import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUDIT_FILTERS,
  distinctValues,
  exportAuditCsv,
  filterAuditRecords,
  parseAuditLog,
  sortAuditRecords,
  type AuditFilters,
  type AuditRecord,
} from '@/lib/audit/auditLog';

/** 构造一条引擎原始 NDJSON 行（snake_case），便于走真实解析路径。 */
function ndjsonLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

/** 直接构造渲染层记录（跳过解析），用于筛选 / 排序 / CSV 测试。 */
function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    timestamp: '',
    tool: '',
    tier: '',
    outcome: '',
    approvedBy: 'none',
    argsDigest: '',
    args: null,
    line: 0,
    ...overrides,
  };
}

describe('parseAuditLog', () => {
  it('空文本返回空结果与零跳过', () => {
    const r = parseAuditLog('');
    expect(r.records).toEqual([]);
    expect(r.skipped).toBe(0);
  });

  it('解析合法 NDJSON 并标注行号（空行忽略）', () => {
    const text = [
      '',
      ndjsonLine({ timestamp: '2026-10-01T01:00:00+00:00', tool: 'write_file', tier: 'allow', outcome: 'executed', approved_by: 'user', args_digest: 'abc', agent_id: 'a1' }),
      '   ',
      ndjsonLine({ timestamp: '2026-10-02T02:00:00+00:00', tool: 'Bash', tier: 'deny', outcome: 'refused', agent_id: 'a2' }),
    ].join('\n');
    const r = parseAuditLog(text);
    expect(r.skipped).toBe(0);
    expect(r.records).toHaveLength(2);
    expect(r.records[0].line).toBe(2);
    expect(r.records[0].tool).toBe('write_file');
    expect(r.records[0].approvedBy).toBe('user');
    expect(r.records[1].line).toBe(4);
    expect(r.records[1].tier).toBe('deny');
    // approved_by 缺省补 none
    expect(r.records[1].approvedBy).toBe('none');
  });

  it('损坏 JSON 与数组行计入 skipped 而非抛出', () => {
    const text = [
      ndjsonLine({ tool: 'x', tier: 'allow', outcome: 'executed' }),
      'this is not json',
      '[1,2,3]',
      ndjsonLine({ tool: 'y', tier: 'deny', outcome: 'refused' }),
    ].join('\n');
    const r = parseAuditLog(text);
    expect(r.records).toHaveLength(2);
    expect(r.skipped).toBe(2);
    expect(r.records.map((x) => x.tool)).toEqual(['x', 'y']);
  });

  it('args 仅当为对象时保留，否则为 null', () => {
    const text = [
      ndjsonLine({ tool: 'a', tier: 'allow', outcome: 'executed', args: { path: '/tmp/x' } }),
      ndjsonLine({ tool: 'b', tier: 'allow', outcome: 'executed', args: 'plain-string' }),
      ndjsonLine({ tool: 'c', tier: 'allow', outcome: 'executed' }),
    ].join('\n');
    const r = parseAuditLog(text);
    expect(r.records[0].args).toEqual({ path: '/tmp/x' });
    expect(r.records[1].args).toBeNull();
    expect(r.records[2].args).toBeNull();
  });
});

describe('filterAuditRecords', () => {
  const base: AuditRecord[] = [
    record({ timestamp: '2026-10-01T08:00:00+00:00', tool: 'write_file', tier: 'allow', outcome: 'executed', approvedBy: 'user', agentId: 'a1', sessionKey: 's1', channel: 'websocket', reason: 'ok' }),
    record({ timestamp: '2026-10-05T09:00:00+00:00', tool: 'Bash', tier: 'deny', outcome: 'refused', approvedBy: 'policy', agentId: 'a2', reason: 'dangerous' }),
    record({ timestamp: '2026-10-10T10:00:00+00:00', tool: 'read_file', tier: 'sandbox', outcome: 'executed', approvedBy: 'read_only', agentId: 'a1', argsDigest: 'deadbeef' }),
  ];

  function withFilters(f: Partial<AuditFilters>): AuditRecord[] {
    return filterAuditRecords(base, { ...DEFAULT_AUDIT_FILTERS, ...f });
  }

  it('tier / outcome / approvedBy 单维筛选', () => {
    expect(withFilters({ tier: 'deny' }).map((r) => r.tool)).toEqual(['Bash']);
    expect(withFilters({ outcome: 'refused' }).map((r) => r.tool)).toEqual(['Bash']);
    expect(withFilters({ approvedBy: 'read_only' }).map((r) => r.tool)).toEqual(['read_file']);
  });

  it('agentId 与 tool 为空串时表示不限', () => {
    expect(withFilters({ agentId: '' })).toHaveLength(3);
    expect(withFilters({ tool: '' })).toHaveLength(3);
    expect(withFilters({ agentId: 'a1' }).map((r) => r.tool)).toEqual(['write_file', 'read_file']);
    expect(withFilters({ tool: 'Bash' }).map((r) => r.tool)).toEqual(['Bash']);
  });

  it('日期起止按天含端点比较', () => {
    expect(withFilters({ from: '2026-10-05' }).map((r) => r.tool)).toEqual(['Bash', 'read_file']);
    expect(withFilters({ to: '2026-10-05' }).map((r) => r.tool)).toEqual(['write_file', 'Bash']);
    expect(withFilters({ from: '2026-10-05', to: '2026-10-05' }).map((r) => r.tool)).toEqual(['Bash']);
    // 空 timestamp 在带 from/to 时被排除
    expect(withFilters({ from: '2026-10-01' }).length).toBe(3);
  });

  it('query 跨多字段匹配', () => {
    expect(withFilters({ query: 'Bash' }).map((r) => r.tool)).toEqual(['Bash']);
    expect(withFilters({ query: 'deadbeef' }).map((r) => r.tool)).toEqual(['read_file']);
    expect(withFilters({ query: 'dangerous' }).map((r) => r.tool)).toEqual(['Bash']);
    expect(withFilters({ query: 'websocket' }).map((r) => r.tool)).toEqual(['write_file']);
    expect(withFilters({ query: 'nonexistent' })).toHaveLength(0);
  });

  it('组合筛选取交集', () => {
    const r = withFilters({ agentId: 'a1', tier: 'sandbox' });
    expect(r.map((x) => x.tool)).toEqual(['read_file']);
  });
});

describe('sortAuditRecords', () => {
  const mixed: AuditRecord[] = [
    record({ timestamp: '2026-10-01T00:00:00+00:00', tool: 'a' }),
    record({ timestamp: '2026-10-03T00:00:00+00:00', tool: 'c' }),
    record({ timestamp: '2026-10-02T00:00:00+00:00', tool: 'b' }),
    record({ timestamp: '', tool: 'bad' }),
  ];

  it('默认倒序：最新在前，空时间戳沉底', () => {
    const sorted = sortAuditRecords(mixed);
    expect(sorted.map((r) => r.tool)).toEqual(['c', 'b', 'a', 'bad']);
  });

  it('升序：最旧在前，空时间戳仍沉底', () => {
    const sorted = sortAuditRecords(mixed, false);
    expect(sorted.map((r) => r.tool)).toEqual(['a', 'b', 'c', 'bad']);
  });

  it('不修改原数组', () => {
    const copy = [...mixed];
    sortAuditRecords(mixed);
    expect(mixed).toEqual(copy);
  });
});

describe('distinctValues', () => {
  const recs: AuditRecord[] = [
    record({ tool: 'Bash', agentId: 'a1' }),
    record({ tool: 'Bash', agentId: 'a2' }),
    record({ tool: 'write_file', agentId: 'a1' }),
  ];

  it('tool 按频次降序', () => {
    expect(distinctValues(recs, 'tool')).toEqual(['Bash', 'write_file']);
  });

  it('agentId 按频次降序', () => {
    expect(distinctValues(recs, 'agentId')).toEqual(['a1', 'a2']);
  });
});

describe('exportAuditCsv', () => {
  const recs: AuditRecord[] = [
    record({ timestamp: '2026-10-01T08:00:00+00:00', tool: 'write_file', tier: 'allow', outcome: 'executed', approvedBy: 'user', agentId: 'a1', args: { path: '/tmp/x' } }),
  ];

  it('表头为引擎原始 snake_case 字段', () => {
    const csv = exportAuditCsv(recs);
    const header = csv.split('\n')[0];
    expect(header).toBe('timestamp,tool,tier,outcome,approved_by,agent_id,session_key,channel,approval_mode,args_digest,reason,args');
  });

  it('含逗号 / 引号 / 换行的字段被正确转义', () => {
    const tricky: AuditRecord[] = [
      record({ tool: 'Bash', tier: 'deny', outcome: 'refused', reason: 'ran "rm -rf" on, the box', args: { cmd: 'a,b\nc' } }),
    ];
    const csv = exportAuditCsv(tricky);
    const row = csv.split('\n')[1];
    // 含逗号的 reason 必须被双引号包裹（内部引号转义为双写）
    expect(row).toContain('"ran ""rm -rf"" on, the box"');
    // 含换行的 args 也会被双引号包裹，且内部 JSON 引号同样双写
    expect(row).toContain('"{""cmd"":""a,b\\nc""}"');
  });

  it('args 以 JSON 序列化并正确转义导出', () => {
    const csv = exportAuditCsv(recs);
    const row = csv.split('\n')[1];
    // args 经 JSON.stringify 后整体被双引号包裹、内部引号双写
    expect(row.endsWith('"{""path"":""/tmp/x""}"')).toBe(true);
  });
});
