/**
 * 产物同步适配器单测（批次 6，FR-7.2 索引 + `bodies` 内容池的内容寻址同步）。
 *
 * 用**真实** `platform`（jsdom → localStorage）与真实 `artifactsStore`，只桩 `appInfo`
 * 的设备 id，覆盖：
 * - 未 hydrate → collect 为空（绝不推未水合的空覆盖）；
 * - 索引条目走 `artifactIndex`、内容池走 `artifactBodies`（内容寻址：同 hash 云端只一份）；
 * - `apply` 内容池 upsert（命中即无改动）、索引 LWW 存活合并 / 墓碑、版本字段随条目落地。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { createArtifactsAdapter, ARTIFACT_COLLECTIONS } from '@/sync/artifacts';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { contentHash } from '@/lib/core/contentHash';
import { artifactContentHash } from '@/lib/artifact/artifactIndex';
import type { Artifact } from '@/types';
import type { SyncChange } from '@/sync/types';

function art(over: Partial<Artifact> & { id: string }): Artifact {
  const { id, ...rest } = over;
  return { type: 'code', content: 'x', createdAt: '2026-09-29T00:00:00.000Z', ...rest, id };
}

function entityOf(changes: SyncChange[], collection: string, id: string): Record<string, unknown> {
  const hit = changes.find((c) => c.collection === collection && String(c.entity?.id) === id);
  if (!hit) throw new Error(`未找到 ${collection}:${id}`);
  return hit.entity;
}

/**
 * 远端时间戳：用**相对当前时间**的偏移，不要写死日期。
 *
 * 本地条目由 `recordArtifact` 写入，`updatedAt` 就是「现在」；于是「远端更新 → 落地」
 * 这条用例的前提是 `T_NEW > 现在`。写死成某个具体日期的话，过了那天本地的
 * `updatedAt` 反而更大，LWW 判据（远端更旧 → 不落地）就把这条用例判红——
 * 与代码无关，纯粹是时间炸弹。
 */
const T_OLD = new Date(Date.now() - 3_600_000).toISOString();
const T_NEW = new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  // 清空 store（index / bodies / 墓碑都要清，避免跨用例串扰）
  useArtifactsStore.setState({ bySession: {}, index: {}, bodies: {}, indexTombstones: {} });
  vi.spyOn(platform, 'appInfo').mockResolvedValue({ deviceId: 'dev-1' } as never);
});

describe('artifacts — 未 hydrate / 上行组装', () => {
  it('未 hydrate → collect 为空（绝不推未水合的空值覆盖对端）', () => {
    const cold = createArtifactsAdapter();
    expect(cold.collect()).toEqual([]);
  });

  it('hydrate 后：索引条目走 artifactIndex、内容池走 artifactBodies（内容寻址）', async () => {
    useArtifactsStore.getState().recordArtifact('s1', 'm1', art({ id: 'a1', content: 'hello' }));
    const adapter = createArtifactsAdapter();
    await adapter.hydrate();
    const changes = adapter.collect();

    const idx = entityOf(changes, ARTIFACT_COLLECTIONS.artifactIndex, 'a1');
    expect(idx.rev).toBe(1);
    expect(String(idx.updatedBy)).toBe('dev-1');
    expect(String(idx.contentHash)).toBe(contentHash('hello'));

    const body = entityOf(changes, ARTIFACT_COLLECTIONS.artifactBodies, contentHash('hello'));
    expect(String(body.content)).toBe('hello');
    expect(body.rev).toBe(1); // 内容不可变 → rev 恒 1
    expect(String(body.updatedAt)).toBe(''); // 内容不可变 → updatedAt 恒 ''
  });

  it('内容寻址去重：同内容跨会话只占 bodies 一个 key（云端只存一份）', async () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'dup' }));
    s.recordArtifact('s2', 'm2', art({ id: 'a2', content: 'dup' }));
    const adapter = createArtifactsAdapter();
    await adapter.hydrate();

    const bodies = adapter
      .collect()
      .filter((c) => c.collection === ARTIFACT_COLLECTIONS.artifactBodies)
      .map((c) => String(c.entity.id));
    expect(bodies).toEqual([contentHash('dup')]); // 一个 key
    const idxIds = adapter
      .collect()
      .filter((c) => c.collection === ARTIFACT_COLLECTIONS.artifactIndex)
      .map((c) => String(c.entity.id));
    expect(idxIds.sort()).toEqual(['a1', 'a2']); // 两条索引
  });

  it('空正文（image）不入 bodies（靠 url 渲染）', async () => {
    useArtifactsStore.getState().recordArtifact('s1', 'm1', art({ id: 'a1', type: 'image', content: '' }));
    const adapter = createArtifactsAdapter();
    await adapter.hydrate();
    const bodies = adapter.collect().filter((c) => c.collection === ARTIFACT_COLLECTIONS.artifactBodies);
    expect(bodies).toEqual([]);
  });
});

describe('artifacts — 落地 apply', () => {
  it('内容池 upsert：命中即无改动；新内容才写 bodies', async () => {
    useArtifactsStore.getState().recordArtifact('s1', 'm1', art({ id: 'a1', content: 'local' }));
    const adapter = createArtifactsAdapter();
    await adapter.hydrate();

    // 远端推来相同正文 → 无改动
    const same = await adapter.apply({
      collection: ARTIFACT_COLLECTIONS.artifactBodies,
      entity: { id: contentHash('local'), content: 'local', rev: 1, updatedAt: '', updatedBy: 'b', deletedAt: null },
    });
    expect(same).toBe(0);

    // 远端推来新正文（不同 hash）→ 写入 bodies
    const h2 = contentHash('remote');
    const changed = await adapter.apply({
      collection: ARTIFACT_COLLECTIONS.artifactBodies,
      entity: { id: h2, content: 'remote', rev: 1, updatedAt: '', updatedBy: 'b', deletedAt: null },
    });
    expect(changed).toBe(1);
    expect(useArtifactsStore.getState().bodies[h2]).toBe('remote');
  });

  it('索引 LWW：远端更旧不落地、远端更新落地', async () => {
    useArtifactsStore.getState().recordArtifact('s1', 'm1', art({ id: 'a1', content: 'v1', title: '本地' }));
    const adapter = createArtifactsAdapter();
    await adapter.hydrate();

    const stale = await adapter.apply({
      collection: ARTIFACT_COLLECTIONS.artifactIndex,
      entity: { id: 'a1', sessionId: 's1', type: 'code', contentHash: contentHash('v1'), createdAt: 'x', rev: 0, updatedAt: T_OLD, updatedBy: 'b', deletedAt: null },
    });
    expect(stale).toBe(0);
    expect(useArtifactsStore.getState().index.a1.title).toBe('本地');

    const fresh = await adapter.apply({
      collection: ARTIFACT_COLLECTIONS.artifactIndex,
      entity: { id: 'a1', sessionId: 's1', type: 'code', contentHash: contentHash('v1'), createdAt: 'x', rev: 5, updatedAt: T_NEW, updatedBy: 'b', deletedAt: null, title: '远端' },
    });
    expect(fresh).toBe(1);
    expect(useArtifactsStore.getState().index.a1.title).toBe('远端');
  });

  it('索引墓碑：摘除存活条目 + 写墓碑表（跨端删除传播）', async () => {
    useArtifactsStore.getState().recordArtifact('s1', 'm1', art({ id: 'a1', content: 'v1' }));
    const adapter = createArtifactsAdapter();
    await adapter.hydrate();

    const tomb = await adapter.apply({
      collection: ARTIFACT_COLLECTIONS.artifactIndex,
      entity: { id: 'a1', sessionId: 's1', type: 'code', contentHash: contentHash('v1'), createdAt: 'x', rev: 9, updatedAt: T_NEW, updatedBy: 'b', deletedAt: T_NEW },
    });
    expect(tomb).toBe(1);
    const state = useArtifactsStore.getState();
    expect(state.index.a1).toBeUndefined();
    expect(state.indexTombstones.a1).toBeTruthy();
    expect(String(state.indexTombstones.a1.deletedAt)).toBe(T_NEW);
  });

  it('版本字段随 LWW 条目落地（FR-7.4）：version / previousVersion / versions 保留', async () => {
    const adapter = createArtifactsAdapter();
    await adapter.hydrate();
    const changed = await adapter.apply({
      collection: ARTIFACT_COLLECTIONS.artifactIndex,
      entity: {
        id: 'a1',
        sessionId: 's1',
        type: 'code',
        contentHash: contentHash('v2'),
        createdAt: 'x',
        rev: 3,
        updatedAt: T_NEW,
        updatedBy: 'b',
        deletedAt: null,
        version: 2,
        previousVersion: contentHash('v1'),
        versions: [
          { version: 1, contentHash: contentHash('v1'), createdAt: T_OLD },
          { version: 2, contentHash: contentHash('v2'), createdAt: T_NEW },
        ],
      },
    });
    expect(changed).toBe(1);
    const entry = useArtifactsStore.getState().index.a1;
    expect(entry.version).toBe(2);
    expect(entry.previousVersion).toBe(contentHash('v1'));
    expect(entry.versions).toHaveLength(2);
  });

  it('未知 collection / 未 hydrate → 不落地', async () => {
    const adapter = createArtifactsAdapter();
    await adapter.hydrate();
    expect(
      await adapter.apply({ collection: 'agents', entity: { id: 'x', content: 'y' } }),
    ).toBe(0);
    const cold = createArtifactsAdapter();
    expect(
      await cold.apply({
        collection: ARTIFACT_COLLECTIONS.artifactIndex,
        entity: { id: 'a1', contentHash: 'z', rev: 1, updatedAt: T_NEW, updatedBy: 'b', deletedAt: null },
      }),
    ).toBe(0);
  });
});
