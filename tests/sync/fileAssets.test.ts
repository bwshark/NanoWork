/**
 * C 类文件型资产适配器单测（批次 6b，规格判据 J-5 ~ J-8）。
 *
 * 用**真实** `platform`（jsdom → localStorage），只桩时间相关的边界：
 * - J-5 内容即版本（`hydrate` 按内容哈希推进 `rev` / `updatedAt`）；
 * - J-6 身份文件三条、**不含 `bootstrap`**；
 * - J-7 提示词覆盖按 `PROMPT_SLOTS` 枚举，空串（回到默认）可上行；
 * - J-8 落地：记忆**段落级并集**，身份 / 提示词**文件级 LWW**。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { platform } from '@/platform';
import {
  IDENTITY_STORAGE_KEYS,
  PROMPT_KEY_PREFIX,
  USER_MEMORY_KEY,
} from '@/lib/core/constants';
import { PROMPT_SLOTS } from '@/lib/prompt/promptCatalog';
import { hashContent } from '@/lib/workspace/workspaceKey';
import { createFileAssetsAdapter, FILE_ASSET_COLLECTIONS } from '@/sync/fileAssets';
import { FILE_ASSETS_STORAGE_KEY } from '@/sync/types';
import type { SyncChange } from '@/sync/types';

/** 复刻 `MemoryService.append` 产出的引用块形态 */
function quoteBlock(at: string, body: string): string {
  return `> [${at}] 来自「手动保存」\n> <!-- SUMMARY:${hashContent(body)} -->\n> ${body}`;
}

const T1 = '2026-09-29T10:00:00.000Z';
const T2 = '2026-09-29T11:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

/** 取某个 collection 的上行实体（按 id） */
function entityOf(changes: SyncChange[], collection: string, id: string): Record<string, unknown> {
  const hit = changes.find(
    (c) => c.collection === collection && String(c.entity?.id) === id,
  );
  if (!hit) throw new Error(`未找到 ${collection}:${id}`);
  return hit.entity;
}

beforeEach(async () => {
  // 清空本批用到的存储（jsdom 的 localStorage 在文件间共享）
  const keys = [
    USER_MEMORY_KEY,
    FILE_ASSETS_STORAGE_KEY,
    ...Object.values(IDENTITY_STORAGE_KEYS),
    ...PROMPT_SLOTS.map((s) => `${PROMPT_KEY_PREFIX}${s.kind}.${s.key}`),
  ];
  await Promise.all(keys.map((k) => platform.storage.remove(k).catch(() => undefined)));
});

describe('fileAssets — 内容即版本（J-5）', () => {
  it('首次 hydrate：有内容的资产 rev=1 且带 updatedAt；空内容不认领版本', async () => {
    await platform.storage.set(USER_MEMORY_KEY, quoteBlock(T1, '我叫明明'));

    const adapter = createFileAssetsAdapter();
    await adapter.hydrate();
    const memory = entityOf(adapter.collect(), FILE_ASSET_COLLECTIONS.memoryUser, 'user');
    expect(memory.rev).toBe(1);
    expect(String(memory.updatedAt)).not.toBe('');

    // 身份文件没写过（空）→ 不推进版本（否则一台空机器会冒充「最新」）
    const soul = entityOf(adapter.collect(), FILE_ASSET_COLLECTIONS.identityFiles, 'soul');
    expect(soul.rev).toBe(0);
    expect(soul.updatedAt).toBe('');
  });

  it('内容没变 → 版本号不动（重复 hydrate 不产生虚假变更）', async () => {
    await platform.storage.set(USER_MEMORY_KEY, quoteBlock(T1, '我叫明明'));
    const adapter = createFileAssetsAdapter();
    await adapter.hydrate();
    const first = entityOf(adapter.collect(), FILE_ASSET_COLLECTIONS.memoryUser, 'user');

    await adapter.hydrate();
    const second = entityOf(adapter.collect(), FILE_ASSET_COLLECTIONS.memoryUser, 'user');
    expect(second.rev).toBe(first.rev);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it('内容变了 → rev+1 且 updatedAt 推进', async () => {
    await platform.storage.set(USER_MEMORY_KEY, quoteBlock(T1, '我叫明明'));
    const adapter = createFileAssetsAdapter();
    await adapter.hydrate();
    const before = entityOf(adapter.collect(), FILE_ASSET_COLLECTIONS.memoryUser, 'user');

    await platform.storage.set(USER_MEMORY_KEY, quoteBlock(T2, '我擅长前端'));
    await adapter.hydrate();
    const after = entityOf(adapter.collect(), FILE_ASSET_COLLECTIONS.memoryUser, 'user');
    expect(after.rev).toBe(Number(before.rev) + 1);
    expect(String(after.updatedAt) >= String(before.updatedAt)).toBe(true);
  });

  it('删掉一条 → 该段的墓碑随负载上行（D2-5）', async () => {
    const full = `${quoteBlock(T1, '我叫明明')}\n\n${quoteBlock(T2, '我擅长前端')}`;
    await platform.storage.set(USER_MEMORY_KEY, full);
    const adapter = createFileAssetsAdapter();
    await adapter.hydrate();

    // 整份覆盖成「只剩第二条」→ 第一条被删
    await platform.storage.set(USER_MEMORY_KEY, quoteBlock(T2, '我擅长前端'));
    await adapter.hydrate();
    const memory = entityOf(adapter.collect(), FILE_ASSET_COLLECTIONS.memoryUser, 'user');
    const tombs = memory.tombstones as Record<string, string>;
    expect(Object.keys(tombs)).toHaveLength(1);
    expect(String(memory.content)).not.toContain('我叫明明');
  });
});

describe('fileAssets — 资产清单（J-6 / J-7）', () => {
  it('身份文件三条，BOOTSTRAP 不进同步（D1-2）', async () => {
    const adapter = createFileAssetsAdapter();
    await adapter.hydrate();
    const ids = adapter
      .collect()
      .filter((c) => c.collection === FILE_ASSET_COLLECTIONS.identityFiles)
      .map((c) => String(c.entity.id))
      .sort();
    expect(ids).toEqual(['identity', 'soul', 'user']);
    expect(ids).not.toContain('bootstrap');
  });

  it('提示词覆盖按 PROMPT_SLOTS 枚举；空串（回到默认）可上行', async () => {
    const adapter = createFileAssetsAdapter();
    await adapter.hydrate();
    const prompts = adapter
      .collect()
      .filter((c) => c.collection === FILE_ASSET_COLLECTIONS.promptOverrides);
    expect(prompts).toHaveLength(PROMPT_SLOTS.length);
    // 从未编辑 → content 为空串（语义是「用内置模板」，不是「删除」）
    expect(prompts.every((p) => p.entity.content === '')).toBe(true);
  });

  it('未 hydrate → collect 为空（绝不推未水合的空值覆盖对端）', async () => {
    const adapter = createFileAssetsAdapter();
    expect(adapter.collect()).toEqual([]);
  });
});

describe('fileAssets — 落地（J-8）', () => {
  it('记忆走**段落级并集**：对端独有的段补进来，本机段不丢', async () => {
    await platform.storage.set(USER_MEMORY_KEY, quoteBlock(T1, '我叫明明'));
    const adapter = createFileAssetsAdapter();
    await adapter.hydrate();

    const changed = await adapter.apply({
      collection: FILE_ASSET_COLLECTIONS.memoryUser,
      entity: {
        id: 'user',
        content: quoteBlock(T2, '我擅长前端'),
        tombstones: {},
        rev: 9,
        updatedAt: T2,
        updatedBy: 'device-b',
        deletedAt: null,
      },
    });
    expect(changed).toBe(1);
    const text = String((await platform.storage.get(USER_MEMORY_KEY)) ?? '');
    expect(text).toContain('我叫明明');
    expect(text).toContain('我擅长前端');
  });

  it('身份文件走文件级 LWW：远端更新 → 落地；远端更旧 → 不落地', async () => {
    await platform.storage.set(IDENTITY_STORAGE_KEYS.soul, '本机版');
    const adapter = createFileAssetsAdapter();
    await adapter.hydrate();

    const stale = await adapter.apply({
      collection: FILE_ASSET_COLLECTIONS.identityFiles,
      entity: { id: 'soul', content: '旧版', rev: 0, updatedAt: PAST, updatedBy: 'b', deletedAt: null },
    });
    expect(stale).toBe(0);
    expect(await platform.storage.get(IDENTITY_STORAGE_KEYS.soul)).toBe('本机版');

    const fresh = await adapter.apply({
      collection: FILE_ASSET_COLLECTIONS.identityFiles,
      entity: {
        id: 'soul',
        content: '远端版',
        rev: 5,
        updatedAt: '2030-01-01T00:00:00.000Z',
        updatedBy: 'b',
        deletedAt: null,
      },
    });
    expect(fresh).toBe(1);
    expect(await platform.storage.get(IDENTITY_STORAGE_KEYS.soul)).toBe('远端版');
  });

  it('未知 collection / 未 hydrate → 不落地', async () => {
    const adapter = createFileAssetsAdapter();
    await adapter.hydrate();
    expect(
      await adapter.apply({ collection: 'agents', entity: { id: 'x', content: 'y' } }),
    ).toBe(0);

    const cold = createFileAssetsAdapter();
    expect(
      await cold.apply({
        collection: FILE_ASSET_COLLECTIONS.memoryUser,
        entity: { id: 'user', content: 'x' },
      }),
    ).toBe(0);
  });
});

describe('fileAssets — 账户分片', () => {
  it('元数据按账户隔离：换号后从零开始，不继承上一个账户的 rev', async () => {
    await platform.storage.set(USER_MEMORY_KEY, quoteBlock(T1, '我叫明明'));

    let scope = 'user-a';
    const adapter = createFileAssetsAdapter(() => scope);
    await adapter.hydrate();
    const aRev = entityOf(adapter.collect(), FILE_ASSET_COLLECTIONS.memoryUser, 'user').rev;
    expect(aRev).toBe(1);

    // 换号：同一份本机内容，但服务端是另一个账户 → 元数据重新计（不继承 rev）
    scope = 'user-b';
    await adapter.hydrate();
    const bRev = entityOf(adapter.collect(), FILE_ASSET_COLLECTIONS.memoryUser, 'user').rev;
    expect(bRev).toBe(1);

    // 切回 A：上一轮的 rev 仍在（读-改-写没有清掉别的分片）
    scope = 'user-a';
    await adapter.hydrate();
    expect(entityOf(adapter.collect(), FILE_ASSET_COLLECTIONS.memoryUser, 'user').rev).toBe(1);
  });
});
