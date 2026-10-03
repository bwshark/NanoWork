import { describe, it, expect } from 'vitest';
import {
  MANAGED_BY_SMARTAGENT,
  buildNanobotJobsFragment,
  computeNextRunMs,
  effectiveValidityWindow,
  toNanobotJob,
  toNanobotSchedule,
} from '@/ai/runtime/nanobotHttp/tasks';
import type { TaskConfig } from '@/types';

/** 构造最小 TaskConfig */
function task(schedule: TaskConfig['schedule'], over: Partial<TaskConfig> = {}): TaskConfig {
  return {
    id: 't1',
    name: '早报',
    schedule,
    prompt: '生成早报',
    agentId: 'a1',
    status: 'enabled',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('toNanobotSchedule: 三种形态对齐 nanobot CronSchedule', () => {
  it('cron → { kind: cron, expr, tz }', () => {
    expect(toNanobotSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' })).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'Asia/Shanghai',
    });
  });

  it('interval → { kind: every, everyMs }（分钟转毫秒）', () => {
    expect(toNanobotSchedule({ kind: 'interval', minutes: 90 })).toEqual({
      kind: 'every',
      everyMs: 90 * 60_000,
    });
  });

  it('once → { kind: at, atMs }', () => {
    const at = '2026-08-20T01:30:00.000Z';
    expect(toNanobotSchedule({ kind: 'once', at })).toEqual({
      kind: 'at',
      atMs: Date.parse(at),
    });
  });
});

describe('toNanobotJob: payload 与 deleteAfterRun 语义', () => {
  it('payload 为 agent_turn + message；单次任务 deleteAfterRun=true', () => {
    const job = toNanobotJob(task({ kind: 'once', at: '2026-08-20T01:30:00.000Z' }));
    expect(job.payload.kind).toBe('agent_turn');
    expect(job.payload.message).toBe('生成早报');
    expect(job.payload.originMetadata?.agentId).toBe('a1');
    expect(job.deleteAfterRun).toBe(true);
    expect(job.enabled).toBe(true);
  });

  it('周期任务 deleteAfterRun=false；disabled 映射 enabled=false', () => {
    const t = task({ kind: 'cron', expr: '0 9 * * *' });
    t.status = 'disabled';
    const job = toNanobotJob(t);
    expect(job.deleteAfterRun).toBe(false);
    expect(job.enabled).toBe(false);
  });

  it('runOptions 落入 payload.originMetadata', () => {
    const t = task({ kind: 'cron', expr: '0 9 * * *' });
    t.runOptions = { model: 'qwen-max', skillIds: ['s1'], fullAccess: true };
    const job = toNanobotJob(t);
    expect(job.payload.originMetadata).toEqual({
      // 托管标记必须下发：网关据此区分前端创建与服务端自建任务
      managedBy: MANAGED_BY_SMARTAGENT,
      agentId: 'a1',
      runOptions: { model: 'qwen-max', skillIds: ['s1'], fullAccess: true },
    });
  });
});

describe('buildNanobotJobsFragment: 输出 jobs.json 兼容结构', () => {
  it('含 version 与 jobs 数组', () => {
    const parsed = JSON.parse(
      buildNanobotJobsFragment([task({ kind: 'interval', minutes: 60 })]),
    ) as { version: number; jobs: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.jobs).toHaveLength(1);
  });
});

// ───────────────────────── FR-5.4：RRULE 与有效期窗口 ─────────────────────────

describe('FR-5.4 RRULE：下发前降级为引擎能跑的形态', () => {
  it('rrule → cron（用户看到的仍是规则本身，引擎拿到的是 cron）', () => {
    expect(
      toNanobotSchedule({ kind: 'rrule', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15,28;BYHOUR=9' }),
    ).toEqual({ kind: 'cron', expr: '0 9 1,15,28 * *' });
  });

  it('rrule 降成固定间隔时同样透传到 every（不复制换算规则）', () => {
    expect(toNanobotSchedule({ kind: 'rrule', rrule: 'FREQ=DAILY;INTERVAL=2;BYHOUR=9' })).toEqual({
      kind: 'every',
      everyMs: 2 * 24 * 60 * 60_000,
    });
  });

  it('rrule 的 tz 不会被丢掉', () => {
    expect(
      toNanobotSchedule({ kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9', tz: 'Asia/Shanghai' }),
    ).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' });
  });

  it('降不了级的 rrule → 永不触发的 cron（同步链路不许因一条坏规则整批失败）', () => {
    // 02-31 不存在，croniter 永远算不出下次触发
    expect(toNanobotSchedule({ kind: 'rrule', rrule: 'FREQ=MONTHLY;BYDAY=1MO' })).toEqual({
      kind: 'cron',
      expr: '0 0 31 2 *',
    });
    expect(computeNextRunMs({ kind: 'rrule', rrule: 'FREQ=MONTHLY;BYDAY=1MO' }, Date.now())).toBeNull();
  });
});

describe('FR-5.4 有效期窗口：引擎没有窗口概念，只能由前端算', () => {
  // 一律用**本地时间**构造：`nextCronRunMs` 与引擎的 croniter 都是本地时区语义，
  // 用 UTC 字面量写期望值会在非 UTC 机器上假红
  const at = (y: number, m: number, d: number, h = 0, mi = 0): number =>
    new Date(y, m - 1, d, h, mi, 0, 0).getTime();
  const iso = (y: number, m: number, d: number, h = 0, mi = 0): string =>
    new Date(y, m - 1, d, h, mi, 0, 0).toISOString();

  const NOW = at(2026, 10, 3, 0, 0); // 2026-10-03 00:00 本地
  const daily9 = { kind: 'cron', expr: '0 9 * * *' } as const;

  it('无窗口：按原语义取下一次', () => {
    expect(computeNextRunMs(daily9, NOW)).toBe(at(2026, 10, 3, 9, 0));
  });

  it('下界在未来：不早于 validFrom（从窗口起点开始找）', () => {
    expect(computeNextRunMs(daily9, NOW, { from: iso(2026, 10, 10) })).toBe(at(2026, 10, 10, 9, 0));
  });

  it('下次触发晚于上界 → null（任务存在但不再执行，而不是「跑到窗口外」）', () => {
    expect(computeNextRunMs(daily9, NOW, { until: iso(2026, 10, 3, 8, 0) })).toBeNull();
  });

  it('下次触发正好在上界之内 → 正常返回（上界是**含**的）', () => {
    expect(computeNextRunMs(daily9, NOW, { until: iso(2026, 10, 3, 9, 0) })).toBe(at(2026, 10, 3, 9, 0));
  });

  it('窗口整体已过期 → null', () => {
    expect(
      computeNextRunMs(daily9, NOW, { from: iso(2026, 9, 1), until: iso(2026, 9, 30, 23, 59) }),
    ).toBeNull();
  });

  it('上界取「任务级窗口」与「RRULE 自带 UNTIL」中**更早**的那个', () => {
    // 用户写了 UNTIL=10-05，又在任务级填了 10-20 → 必须听规则自己的截止
    const w = effectiveValidityWindow({
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;UNTIL=20261005T000000Z' },
      validUntil: '2026-10-20T00:00:00Z',
    });
    expect(w.until).toBe('2026-10-05T00:00:00Z');

    // 反过来：任务级更早 → 取任务级
    const w2 = effectiveValidityWindow({
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;UNTIL=20261020T000000Z' },
      validUntil: '2026-10-05T00:00:00Z',
    });
    expect(w2.until).toBe('2026-10-05T00:00:00Z');
  });

  it('窗口透传进 originMetadata（引擎不消费，但排查时能看到当时按什么窗口算的）', () => {
    const job = toNanobotJob(
      task({ kind: 'cron', expr: '0 9 * * *' }, { validFrom: '2026-10-01T00:00:00Z', validUntil: '2026-11-01T00:00:00Z' }),
    );
    expect(job.payload.originMetadata.validity).toEqual({
      from: '2026-10-01T00:00:00Z',
      until: '2026-11-01T00:00:00Z',
    });
  });

  it('没有窗口时不产生 validity 字段（元数据不被无意义的空对象污染）', () => {
    const job = toNanobotJob(task({ kind: 'interval', minutes: 60 }));
    expect('validity' in job.payload.originMetadata).toBe(false);
  });
});

// ───────────────────────── FR-5.6：结果推送（delivery） ─────────────────────────

describe('FR-5.6 delivery：下发给引擎的投递配置', () => {
  const every60 = { kind: 'interval', minutes: 60 } as const;

  it('有目标时原样写进 payload.delivery', () => {
    const job = toNanobotJob(
      task(every60, { delivery: { targets: [{ channel: 'wecom', chatId: 'c1' }], on: 'complete' } }),
    );
    expect(job.payload.delivery).toEqual({
      targets: [{ channel: 'wecom', chatId: 'c1' }],
      on: 'complete',
    });
  });

  it('没配置时不写键 —— payload 保持干净，幂等合并也不会在「有键但空」「没键」之间抖', () => {
    const job = toNanobotJob(task(every60));
    expect('delivery' in job.payload).toBe(false);
  });

  it('空目标等同于没配置（不写键）', () => {
    const job = toNanobotJob(task(every60, { delivery: { targets: [], on: 'complete' } }));
    expect('delivery' in job.payload).toBe(false);
  });

  it('⭐ delivery 不得碰 legacy 投递字段 —— 它们非空会让任务被引擎判为「未绑定会话」并禁用', () => {
    const job = toNanobotJob(
      task(every60, { delivery: { targets: [{ channel: 'wecom', chatId: 'c1' }], on: 'error' } }),
    );

    expect(job.payload.deliver).toBe(false);
    expect(job.payload.channel).toBeNull();
    expect(job.payload.to).toBeNull();
    expect(job.payload.channelMeta).toEqual({});
    // 任务仍必须绑在自己那个 api:cron-{id} 会话上（执行 / 权限 / 留痕都靠它）
    expect(job.payload.sessionKey).toBe('api:cron-t1');
    expect(job.payload.originChannel).toBe('api');
    expect(job.payload.originChatId).toBe('cron-t1');
  });

  it('「仅失败时推送」这个档位原样透传', () => {
    const job = toNanobotJob(
      task(every60, {
        delivery: { targets: [{ channel: 'feishu.feishu', chatId: 'ou_1' }], on: 'error' },
      }),
    );
    expect(job.payload.delivery?.on).toBe('error');
  });

  it('多目标全部下发，且保持用户添加的顺序', () => {
    const job = toNanobotJob(
      task(every60, {
        delivery: {
          targets: [
            { channel: 'wecom', chatId: 'c1' },
            { channel: 'feishu', chatId: 'c2' },
          ],
          on: 'complete',
        },
      }),
    );
    expect(job.payload.delivery?.targets.map((t) => `${t.channel}:${t.chatId}`)).toEqual([
      'wecom:c1',
      'feishu:c2',
    ]);
  });

  it('同步链路的实际产物（jobs.json 片段）里真的带着 delivery', () => {
    const fragment = buildNanobotJobsFragment([
      task(every60, { delivery: { targets: [{ channel: 'wecom', chatId: 'c1' }], on: 'error' } }),
    ]);
    const parsed = JSON.parse(fragment) as {
      jobs: Array<{ payload: { delivery?: unknown } }>;
    };
    expect(parsed.jobs[0].payload.delivery).toEqual({
      targets: [{ channel: 'wecom', chatId: 'c1' }],
      on: 'error',
    });
  });
});

// ───────────────────────── FR-5.8：任务级工作目录 ─────────────────────────

describe('FR-5.8 工作目录：写进 originMetadata.workspace_scope', () => {
  const every60 = { kind: 'interval', minutes: 60 } as const;

  it('绑定了目录 → 落成 workspace_scope.project_path', () => {
    const job = toNanobotJob(task(every60, { workdir: 'D:\\proj\\alpha' }));
    expect(job.payload.originMetadata.workspace_scope).toEqual({
      project_path: 'D:\\proj\\alpha',
    });
  });

  it('没绑定 → 不下发该键（让引擎走会话/默认作用域，而不是声明一个空作用域）', () => {
    const job = toNanobotJob(task(every60));
    expect('workspace_scope' in job.payload.originMetadata).toBe(false);
  });

  it('⭐ 任务的 origin 渠道必须保持 `api`：引擎只在 scoped_channels 里解析工作区作用域', () => {
    // 改掉这一条，任务级工作目录会被**静默忽略**（不报错、回落默认目录）。
    // 引擎侧对应 `WorkspaceScopeResolver.scoped_channels = {websocket, api}`，
    // 并有否定用例钉住：nanobot/tests/cron/test_bound_runner_workspace.py
    const job = toNanobotJob(task(every60, { workdir: '/home/me/proj' }));
    expect(job.payload.originChannel).toBe('api');
    expect(job.payload.deliver).toBe(false);
    expect(job.payload.channel).toBeNull();
  });

  it('工作目录与结果推送可以同时配置（前者管在哪跑、后者管结果发给谁）', () => {
    const job = toNanobotJob(
      task(every60, {
        workdir: '/home/me/proj',
        delivery: { targets: [{ channel: 'wecom', chatId: 'c1' }], on: 'complete' },
      }),
    );
    expect(job.payload.originMetadata.workspace_scope).toEqual({ project_path: '/home/me/proj' });
    expect(job.payload.delivery?.targets).toEqual([{ channel: 'wecom', chatId: 'c1' }]);
  });
});
