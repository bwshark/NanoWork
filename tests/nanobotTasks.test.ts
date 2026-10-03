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
