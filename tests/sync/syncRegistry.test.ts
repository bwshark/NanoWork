/**
 * `syncRegistry`：注册表 + `applyEntity` 落地的键控语义 + 缺省 registry。
 *
 * `applyEntity` 是 pull 落地的唯一写入动作，两条语义各自对应一个真实事故：
 * - **墓碑入表 + 从存活数组摘除**：不摘除 = 删不掉的幽灵条目；
 * - **存活 upsert + 清同名墓碑**：不清墓碑 = 「删除后又建回来」的条目被按已删除推出去。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SyncRegistry, applyEntity, createDefaultRegistry } from '@/sync/syncRegistry';
import { useAgentsStore } from '@/stores/agentsStore';
import type { Agent, SyncTombstones } from '@/types';

const keyOf = (e: Record<string, unknown>): string => String(e.id);

const META_BASE = { rev: 2, updatedAt: '2026-06-01T00:00:00.000Z', updatedBy: 'dev-a' };

function tombstoned(id: string, deletedAt = '2026-06-01T00:00:00.000Z'): Record<string, unknown> {
  return { id, rev: 3, updatedAt: deletedAt, updatedBy: 'dev-a', deletedAt };
}

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    systemPrompt: '',
    skillIds: [],
    imBinding: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'user',
    ...over,
  };
}

beforeEach(() => {
  useAgentsStore.setState({ agents: [], tombstones: {} });
});

describe('SyncRegistry 注册 / 查找', () => {
  it('register + get + entries 按登记顺序返回', () => {
    const registry = new SyncRegistry();
    const a = {
      collection: 'a',
      keyOf,
      read: () => ({ entities: [], tombstones: {} }),
      apply: () => undefined,
      payload: (e: Record<string, unknown>) => e,
    };
    const b = { ...a, collection: 'b' };

    registry.register(a);
    registry.register(b);

    expect(registry.get('a')).toBe(a);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.entries().map((s) => s.collection)).toEqual(['a', 'b']);
  });

  it('同名 collection 覆盖登记', () => {
    const registry = new SyncRegistry();
    const first = {
      collection: 'x',
      keyOf,
      read: () => ({ entities: [], tombstones: {} }),
      apply: () => undefined,
      payload: (e: Record<string, unknown>) => e,
    };
    const second = { ...first, keyOf: (e: Record<string, unknown>) => String(e.id).toUpperCase() };

    registry.register(first);
    registry.register(second);

    expect(registry.get('x')).toBe(second);
    expect(registry.entries()).toHaveLength(1);
  });
});

describe('applyEntity：存活 upsert', () => {
  it('新条追加到数组', () => {
    const result = applyEntity([], {}, { id: 'a', name: 'A' }, keyOf);
    expect(result.list).toEqual([{ id: 'a', name: 'A' }]);
    expect(result.tombstones).toEqual({});
  });

  it('已有同名条目原地替换（保持顺序、不产生重复）', () => {
    const result = applyEntity(
      [{ id: 'a', name: '旧' }, { id: 'b', name: 'B' }],
      {},
      { id: 'a', name: '新' },
      keyOf,
    );
    expect(result.list).toEqual([{ id: 'a', name: '新' }, { id: 'b', name: 'B' }]);
  });

  it('存活时清同名墓碑（删除后重建不留幽灵墓碑）', () => {
    const tombstones: SyncTombstones = { a: { ...META_BASE, deletedAt: META_BASE.updatedAt } };
    const result = applyEntity([], tombstones, { id: 'a', ...META_BASE, deletedAt: null }, keyOf);
    expect(result.tombstones).toEqual({});
    expect(result.list).toHaveLength(1);
  });
});

describe('applyEntity：墓碑', () => {
  it('入墓碑表 + 从存活数组键控摘除（只摘同名）', () => {
    const result = applyEntity(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      {},
      tombstoned('a'),
      keyOf,
    );
    expect(result.list).toEqual([{ id: 'b', name: 'B' }]);
    expect(result.tombstones.a).toMatchObject({ rev: 3, updatedAt: META_BASE.updatedAt });
    expect(result.tombstones.a.deletedAt).toBe(META_BASE.updatedAt);
  });

  it('复活：存活实体应用到墓碑表命中的键上会清墓碑', () => {
    const tombstones: SyncTombstones = { a: { ...META_BASE, deletedAt: META_BASE.updatedAt } };
    const result = applyEntity(
      [],
      tombstones,
      { id: 'a', rev: 4, updatedAt: '2026-07-01T00:00:00.000Z', updatedBy: 'dev-a', deletedAt: null },
      keyOf,
    );
    expect(result.tombstones).toEqual({});
    expect(result.list).toEqual([
      { id: 'a', rev: 4, updatedAt: '2026-07-01T00:00:00.000Z', updatedBy: 'dev-a', deletedAt: null },
    ]);
  });

  it('幂等：同一墓碑应用两次结果一致', () => {
    const once = applyEntity([{ id: 'a' }], {}, tombstoned('a'), keyOf);
    const twice = applyEntity(once.list, once.tombstones, tombstoned('a'), keyOf);
    expect(twice.list).toEqual(once.list);
    expect(twice.tombstones).toEqual(once.tombstones);
  });
});

describe('createDefaultRegistry：agents 样板', () => {
  it('登记了 agents，read 反映 store、payload 带全字段', () => {
    const registry = createDefaultRegistry();
    const spec = registry.get('agents');
    expect(spec).toBeDefined();

    useAgentsStore.setState({ agents: [agent('a1', { name: '样板' })], tombstones: {} });
    const read = spec!.read();
    expect(read.entities.find((e) => e.id === 'a1')).toBeTruthy();

    const payload = spec!.payload({ id: 'a1', name: '样板', enabled: true });
    expect(payload).toEqual({ id: 'a1', name: '样板', enabled: true });
  });

  it('apply 墓碑 → 存活列表不含该条、墓碑表含该条', () => {
    const registry = createDefaultRegistry();
    const spec = registry.get('agents')!;
    useAgentsStore.setState({ agents: [agent('a1')], tombstones: {} });

    spec.apply(tombstoned('a1', '2026-08-01T00:00:00.000Z'));

    const state = useAgentsStore.getState();
    expect(state.agents.find((a) => a.id === 'a1')).toBeUndefined();
    expect(state.tombstones.a1).toMatchObject({
      rev: 3,
      deletedAt: '2026-08-01T00:00:00.000Z',
      updatedBy: 'dev-a',
    });
  });

  it('apply 存活更新 → 落地到 store', () => {
    const registry = createDefaultRegistry();
    const spec = registry.get('agents')!;
    useAgentsStore.setState({ agents: [agent('a1', { name: '旧' })], tombstones: {} });

    spec.apply({ ...agent('a1', { name: '新' }), rev: 5, updatedAt: '2026-09-01T00:00:00.000Z' });

    expect(useAgentsStore.getState().agents.find((a) => a.id === 'a1')?.name).toBe('新');
  });
});
