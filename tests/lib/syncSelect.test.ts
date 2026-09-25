import { describe, expect, it } from 'vitest';
import { liveEntities, pickSyncable } from '@/lib/syncSelect';

const NOW = '2026-09-25T10:00:00.000Z';

interface Row {
  id: string;
  name: string;
  deletedAt?: string | null;
}

const rows: Row[] = [
  { id: 'a', name: '甲' },
  { id: 'b', name: '乙', deletedAt: null },
  { id: 'c', name: '丙', deletedAt: NOW },
];

describe('liveEntities', () => {
  it('摘掉墓碑并保留原顺序', () => {
    expect(liveEntities(rows).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('deletedAt 缺字段与 null 都算存活（老数据不会凭空消失）', () => {
    expect(liveEntities([{ id: 'x', name: '' }, { id: 'y', name: '', deletedAt: null }])).toHaveLength(2);
  });

  it('脏值（空串）也算存活，与 isTombstone 同源', () => {
    // 「有没有删除时间」的判据是「非空字符串」，不是真值判断也不是 `!= null`
    expect(liveEntities([{ id: 'z', name: '', deletedAt: '' }]).map((r) => r.id)).toEqual(['z']);
  });

  it('空值 / 空数组返回空数组，不抛错', () => {
    expect(liveEntities(undefined)).toEqual([]);
    expect(liveEntities(null)).toEqual([]);
    expect(liveEntities([])).toEqual([]);
  });

  it('不改原数组', () => {
    const before = [...rows];
    liveEntities(rows);
    expect(rows).toEqual(before);
  });
});

describe('pickSyncable', () => {
  it('剔除列出的键，保留其余', () => {
    const payload = pickSyncable({ id: '1', name: '甲', secret: 's', status: 'ok' }, ['secret', 'status']);
    expect(payload).toEqual({ id: '1', name: '甲' });
  });

  it('omitKeys 为空 = 全量浅拷贝（且不是同一个对象）', () => {
    const source = { id: '1', name: '甲' };
    const payload = pickSyncable(source, []);
    expect(payload).toEqual(source);
    expect(payload).not.toBe(source);
  });

  it('是纯函数：不改原对象', () => {
    const source = { id: '1', name: '甲', secret: 's' };
    pickSyncable(source, ['secret']);
    expect(source).toEqual({ id: '1', name: '甲', secret: 's' });
  });

  it('omit 里列出源码中不存在的键不报错', () => {
    expect(pickSyncable({ id: '1' }, ['notThere'])).toEqual({ id: '1' });
  });

  // —— 下面两组是把 design §5.2 / §5.3 的结论钉成可证伪的判据 ——
  // 它们不是「顺手多写的用例」：这两条排除清单漏掉任何一项，症状都是静默的
  // （凭据上云 / 对端显示「从未探测过却已连接」），单测是唯一能提前拦住的地方。

  it('渠道凭据绝不进同步负载（§5.3 定案：不上行）', () => {
    const channel = {
      id: 'ch-1',
      kind: 'wecom' as const,
      enabled: true,
      allowFrom: ['u1'],
      groupPolicy: 'mention',
      topicIsolation: false,
      lastSyncAt: NOW,
      syncStatus: 'connected',
      clientSecret: 'cs',
      appSecret: 'as',
      botSecret: 'bs',
      token: 'tk',
    };

    const payload = pickSyncable(channel, [
      'clientSecret',
      'appSecret',
      'botSecret',
      'token',
      'lastSyncAt',
      'syncStatus',
    ]);

    expect(Object.keys(payload).sort()).toEqual([
      'allowFrom',
      'enabled',
      'groupPolicy',
      'id',
      'kind',
      'topicIsolation',
    ]);
    // 反过来断言一次：任何一项凭据漏进负载，这条就会红
    for (const secret of ['clientSecret', 'appSecret', 'botSecret', 'token']) {
      expect(Object.prototype.hasOwnProperty.call(payload, secret)).toBe(false);
    }
  });

  it('运行时事实字段不进同步负载，声明字段保留（§5.2）', () => {
    const mcp = {
      id: 'mcp-1',
      name: '本地工具',
      transport: 'stdio',
      command: 'node server.js',
      enabled: true,
      tools: [{ name: 'echo' }],
      lastProbedAt: NOW,
      status: 'connected',
      authKeyNames: ['TOKEN'],
    };

    const payload = pickSyncable(mcp, ['tools', 'lastProbedAt', 'status', 'authKeyNames']);

    expect(Object.keys(payload).sort()).toEqual([
      'command',
      'enabled',
      'id',
      'name',
      'transport',
    ]);
  });
});
