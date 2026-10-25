import { describe, it, expect, vi, afterEach } from 'vitest';
import { platform } from '@/platform';
import {
  APP_AUDIT_ACTION_GROUPS,
  APP_AUDIT_ACTION_LABELS,
  APP_AUDIT_LOCAL_ACTOR,
  appAuditActorLabel,
  mergeAppAuditRecords,
  DEFAULT_APP_AUDIT_FILTERS,
  buildAppAuditRecord,
  changedFieldNames,
  currentAppAuditActor,
  distinctAppAuditActions,
  exportAppAuditCsv,
  filterAppAuditRecords,
  parseAppAuditLog,
  recordAppAudit,
  sanitizeAuditDetail,
  serializeAppAuditRecord,
  setAppAuditActorProvider,
  sortAppAuditRecords,
  type AppAuditAction,
} from '@/lib/audit/appAudit';

/**
 * FR-8.9 第二条来源（应用操作审计）的纯逻辑契约。
 *
 * 重点不是「函数能跑」，而是三条一旦破了就静默失效的性质：
 * ① 动作目录与标签表一一对应（漏一条界面上就是裸 id）；
 * ② detail 的密钥一律脱敏（审计 CSV 会被贴进工单）；
 * ③ 写入是旁路——任何异常都不得冒到业务动作上。
 */

afterEach(() => {
  setAppAuditActorProvider(null);
  vi.restoreAllMocks();
});

describe('动作目录与标签', () => {
  it('每个动作都有中文标签（缺一条就会被渲染成裸 id）', () => {
    const ids = Object.keys(APP_AUDIT_ACTION_LABELS) as AppAuditAction[];
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      expect(APP_AUDIT_ACTION_LABELS[id]).toBeTruthy();
    }
  });

  it('分组里的动作必须都在标签表里，且不重复出现', () => {
    const seen = new Set<string>();
    for (const [group, actions] of Object.entries(APP_AUDIT_ACTION_GROUPS)) {
      expect(group).toBeTruthy();
      for (const action of actions) {
        expect(APP_AUDIT_ACTION_LABELS[action], `${action} 缺标签`).toBeTruthy();
        expect(seen.has(action), `${action} 在分组里重复`).toBe(false);
        seen.add(action);
      }
    }
    // 分区覆盖全部标签（分区只影响展示分组，不能漏动作）
    expect([...seen].sort()).toEqual(Object.keys(APP_AUDIT_ACTION_LABELS).sort());
  });
});

describe('sanitizeAuditDetail：脱敏与白名单化', () => {
  it('疑似密钥的键保留键名、值落 ***', () => {
    const out = sanitizeAuditDetail({
      appSecret: 'real-secret-value',
      apiToken: 'tok',
      clientSecret: 'x',
      name: '飞书',
    });
    expect(out).toEqual({
      appSecret: '***',
      apiToken: '***',
      clientSecret: '***',
      name: '飞书',
    });
    // 关键：值不得以任何形式残留
    expect(JSON.stringify(out)).not.toContain('real-secret-value');
  });

  it('对象 / 函数一律丢弃，数组只留字符串并截断', () => {
    const out = sanitizeAuditDetail({
      nested: { a: 1 },
      fn: () => 1,
      fields: ['name', 42 as unknown as string, 'model'],
    });
    expect(out).toEqual({ fields: ['name', 'model'] });
  });

  it('长字符串截断、NaN 丢弃、空结果返回 undefined', () => {
    const long = 'x'.repeat(500);
    const out = sanitizeAuditDetail({ long, bad: Number.NaN, ok: true });
    expect(out?.long).toMatch(/…$/);
    expect((out?.long as string).length).toBeLessThanOrEqual(201);
    expect(out).not.toHaveProperty('bad');
    expect(out?.ok).toBe(true);
    expect(sanitizeAuditDetail({})).toBeUndefined();
    expect(sanitizeAuditDetail(undefined)).toBeUndefined();
  });
});

describe('buildAppAuditRecord / serialize', () => {
  it('默认 outcome=ok、actor=local，未预热设备号时不写该字段', () => {
    const rec = buildAppAuditRecord(
      { action: 'agent.create', targetId: 'a1', targetLabel: '写作专家' },
      { now: new Date('2026-10-23T12:00:00Z'), actor: 'local', deviceId: null },
    );
    expect(rec.ts).toBe('2026-10-23T12:00:00.000Z');
    expect(rec.outcome).toBe('ok');
    expect(rec.actor).toBe(APP_AUDIT_LOCAL_ACTOR);
    expect(rec).not.toHaveProperty('deviceId');
  });

  it('序列化是一行且不含换行；缺省字段不落盘', () => {
    const line = serializeAppAuditRecord({
      ts: '2026-10-23T12:00:00.000Z',
      action: 'task.delete',
      outcome: 'ok',
      actor: 'u_1',
    });
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(JSON.parse(line)).toEqual({
      ts: '2026-10-23T12:00:00.000Z',
      action: 'task.delete',
      outcome: 'ok',
      actor: 'u_1',
    });
  });

  it('detail 里带密钥时序列化后仍看不到原值', () => {
    const rec = buildAppAuditRecord(
      {
        action: 'mcp.secret.write',
        targetId: 'm1',
        detail: { fields: ['apiKey'], apiKey: 'sk-live-123' },
      },
      { now: new Date('2026-10-23T12:00:00Z'), actor: 'local', deviceId: 'dev-1' },
    );
    const line = serializeAppAuditRecord(rec);
    expect(line).toContain('"apiKey":"***"');
    expect(line).not.toContain('sk-live-123');
  });
});

describe('recordAppAudit：旁路，绝不冒泡', () => {
  it('写一条已序列化的行到平台层', () => {
    const spy = vi.spyOn(platform, 'auditAppendApp').mockResolvedValue({ ok: true });
    recordAppAudit({ action: 'skill.override', targetId: 's1', detail: { override: 'off' } });
    expect(spy).toHaveBeenCalledTimes(1);
    const lines = spy.mock.calls[0][0];
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.action).toBe('skill.override');
    expect(parsed.detail).toEqual({ override: 'off' });
  });

  it('平台层拒绝 / 抛错时调用方不受影响（无抛出、无未处理拒绝）', async () => {
    vi.spyOn(platform, 'auditAppendApp').mockRejectedValue(new Error('disk full'));
    expect(() => recordAppAudit({ action: 'agent.delete', targetId: 'a1' })).not.toThrow();
    // 让被吞掉的 Promise 走完，若实现漏了 catch 这里会变成未处理拒绝
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('序列化阶段抛错也被吞掉（detail 取值器抛异常）', () => {
    const spy = vi.spyOn(platform, 'auditAppendApp').mockResolvedValue({ ok: true });
    const detail = {
      get boom(): string {
        throw new Error('getter exploded');
      },
    };
    expect(() => recordAppAudit({ action: 'agent.update', detail })).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('操作者注入', () => {
  it('provider 返回值即 actor；空串 / 抛错回落到 local', () => {
    setAppAuditActorProvider(() => 'u_abc');
    expect(currentAppAuditActor()).toBe('u_abc');

    setAppAuditActorProvider(() => '   ');
    expect(currentAppAuditActor()).toBe(APP_AUDIT_LOCAL_ACTOR);

    setAppAuditActorProvider(() => {
      throw new Error('no runtime');
    });
    expect(currentAppAuditActor()).toBe(APP_AUDIT_LOCAL_ACTOR);

    setAppAuditActorProvider(null);
    expect(currentAppAuditActor()).toBe(APP_AUDIT_LOCAL_ACTOR);
  });
});

describe('parseAppAuditLog：坏行只跳过，不抛', () => {
  it('空行 / 坏 JSON / 缺 action / 非对象都计入 skipped', () => {
    const text = [
      '{"ts":"2026-10-23T01:00:00.000Z","action":"agent.create","outcome":"ok","actor":"local"}',
      '',
      'not-json',
      '{"ts":"2026-10-23T01:00:00.000Z"}',
      '[1,2,3]',
      '{"ts":"2026-10-23T02:00:00.000Z","action":"task.delete","outcome":"failed","actor":"u_1","reason":"x"}',
    ].join('\n');
    const { records, skipped } = parseAppAuditLog(text);
    expect(records.map((r) => r.action)).toEqual(['agent.create', 'task.delete']);
    expect(skipped).toBe(3);
    expect(records[1].reason).toBe('x');
    // 行号 1-based，用于稳定排序与溯源
    expect(records[0].line).toBe(1);
    expect(records[1].line).toBe(6);
  });

  it('读回时对 detail 再脱敏一遍（文件可能被手改过）', () => {
    const text =
      '{"ts":"2026-10-23T01:00:00.000Z","action":"channel.update","outcome":"ok","actor":"local","detail":{"appSecret":"leak","fields":["allowFrom"]}}';
    const { records } = parseAppAuditLog(text);
    expect(records[0].detail).toEqual({ appSecret: '***', fields: ['allowFrom'] });
  });

  it('空文本返回空集', () => {
    expect(parseAppAuditLog('')).toEqual({ records: [], skipped: 0 });
  });
});

describe('filter / sort / distinct / csv', () => {
  const text = [
    '{"ts":"2026-10-20T01:00:00.000Z","action":"agent.create","outcome":"ok","actor":"local","targetLabel":"A"}',
    '{"ts":"2026-10-21T01:00:00.000Z","action":"agent.delete","outcome":"ok","actor":"local","targetLabel":"B"}',
    '{"ts":"2026-10-21T02:00:00.000Z","action":"task.delete","outcome":"failed","actor":"u_1","targetLabel":"C","reason":"engine said no"}',
  ].join('\n');
  const { records } = parseAppAuditLog(text);

  it('按动作 / 结果 / 关键词 / 日期过滤', () => {
    expect(
      filterAppAuditRecords(records, { ...DEFAULT_APP_AUDIT_FILTERS, action: 'agent.delete' }),
    ).toHaveLength(1);
    expect(
      filterAppAuditRecords(records, { ...DEFAULT_APP_AUDIT_FILTERS, outcome: 'failed' }),
    ).toHaveLength(1);
    // 关键词命中中文标签也算（用户搜「删除专家」应该能找到）
    expect(
      filterAppAuditRecords(records, { ...DEFAULT_APP_AUDIT_FILTERS, query: '删除专家' }),
    ).toHaveLength(1);
    expect(
      filterAppAuditRecords(records, { ...DEFAULT_APP_AUDIT_FILTERS, query: 'engine said' }),
    ).toHaveLength(1);
    expect(
      filterAppAuditRecords(records, {
        ...DEFAULT_APP_AUDIT_FILTERS,
        from: '2026-10-21',
        to: '2026-10-21',
      }),
    ).toHaveLength(2);
  });

  it('排序：默认最新在前，同毫秒按行号倒序', () => {
    const same = parseAppAuditLog(
      [
        '{"ts":"2026-10-21T01:00:00.000Z","action":"task.toggle","outcome":"ok","actor":"local"}',
        '{"ts":"2026-10-21T01:00:00.000Z","action":"mcp.delete","outcome":"ok","actor":"local"}',
      ].join('\n'),
    ).records;
    expect(sortAppAuditRecords(same, true).map((r) => r.action)).toEqual([
      'mcp.delete',
      'task.toggle',
    ]);
    expect(sortAppAuditRecords(records, true)[0].ts >= sortAppAuditRecords(records, true)[1].ts).toBe(
      true,
    );
  });

  it('时间不明的记录在按日期筛选时被排除（宁可少显示）', () => {
    const bad = parseAppAuditLog(
      '{"action":"agent.update","outcome":"ok","actor":"local"}',
    ).records;
    expect(
      filterAppAuditRecords(bad, { ...DEFAULT_APP_AUDIT_FILTERS, from: '2026-01-01' }),
    ).toHaveLength(0);
  });

  it('动作去重按频次降序', () => {
    const many = parseAppAuditLog(
      [
        '{"ts":"2026-10-21T01:00:00.000Z","action":"skill.override","outcome":"ok","actor":"local"}',
        '{"ts":"2026-10-21T02:00:00.000Z","action":"skill.override","outcome":"ok","actor":"local"}',
        '{"ts":"2026-10-21T03:00:00.000Z","action":"agent.create","outcome":"ok","actor":"local"}',
      ].join('\n'),
    ).records;
    expect(distinctAppAuditActions(many)).toEqual(['skill.override', 'agent.create']);
  });

  it('CSV 带表头、中文标签列与转义', () => {
    const csv = exportAppAuditCsv(records);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('action_label');
    expect(lines).toHaveLength(4);
    expect(csv).toContain('删除专家');
    // 含引号的值必须被双写包裹，否则导出文件会错列
    const quoted = exportAppAuditCsv(
      parseAppAuditLog(
        '{"ts":"2026-10-21T01:00:00.000Z","action":"agent.update","outcome":"ok","actor":"local","targetLabel":"a,\\"b\\""}',
      ).records,
    );
    expect(quoted).toContain('"a,""b"""');
  });
});

describe('来源（本机 / 引擎）与合并', () => {
  const localText =
    '{"ts":"2026-10-23T01:00:00.000Z","action":"agent.create","outcome":"ok","actor":"local"}';
  const engineText =
    '{"ts":"2026-10-23T02:00:00.000Z","action":"cron.reload","outcome":"ok","actor":"engine","detail":{"jobs":3}}';

  it('parse 默认标本机，显式传 engine 才标引擎', () => {
    expect(parseAppAuditLog(localText).records[0].origin).toBe('app');
    expect(parseAppAuditLog(engineText, 'engine').records[0].origin).toBe('engine');
  });

  it('合并后按时间倒序，引擎那条排在最前', () => {
    const merged = mergeAppAuditRecords(
      parseAppAuditLog(localText).records,
      parseAppAuditLog(engineText, 'engine').records,
    );
    const sorted = sortAppAuditRecords(merged, true);
    expect(sorted.map((r) => r.action)).toEqual(['cron.reload', 'agent.create']);
    expect(sorted[0].origin).toBe('engine');
  });

  it('操作者显示：引擎 / 本机 / 账户 id 三档', () => {
    expect(appAuditActorLabel('engine')).toBe('引擎');
    expect(appAuditActorLabel(APP_AUDIT_LOCAL_ACTOR)).toBe('本机');
    expect(appAuditActorLabel('u_abc')).toBe('u_abc');
  });
});

describe('changedFieldNames', () => {
  it('跳过 undefined 与未变化字段，数组按内容比较', () => {
    expect(
      changedFieldNames({ name: 'A', list: ['x', 'y'], model: 'm1' }, {
        name: 'A',
        list: ['x', 'y'],
        model: 'm2',
        note: undefined,
      }),
    ).toEqual(['model']);
  });

  it('无 before（新建）时全部计入', () => {
    expect(changedFieldNames(null, { a: 1, b: 2 })).toEqual(['a', 'b']);
    expect(changedFieldNames({}, undefined)).toEqual([]);
  });
});
