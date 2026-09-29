/**
 * 产物索引的纯函数（FR-7.2）。
 *
 * 不 import platform、不 import store——索引条目的组装、去重判据、检索与折叠都是
 * 纯计算，这样才能单测覆盖而不必拉起 React。
 *
 * 落点相关的决定见 `docs/fr-7-2-artifact-index-spec.md`：
 * - D1 索引存元数据，**不存内容本体**（内容仍随消息 / `bySession`）
 * - D3 去重 = 入库去重（同会话同 hash 跳过）+ 检索折叠（跨会话同 hash 折叠展示）
 * - D9 不做 `version` / `previousVersion`（归 FR-7.4）
 */

import { contentHash } from '@/lib/contentHash';
import type { Artifact, ArtifactIndexEntry, ArtifactType, SyncMeta } from '@/types';

/**
 * 产物的内容寻址哈希。
 *
 * 外链类（image / video）的 `content` 是空串，此时 `url` 才是它的身份——
 * 若一律哈希 `content`，所有图片会算出同一个值而被误判为重复。
 */
export function artifactContentHash(artifact: Artifact): string {
  const body = artifact.content && artifact.content !== '' ? artifact.content : (artifact.url ?? '');
  return contentHash(body);
}

/**
 * 由一次入库组装索引条目。
 *
 * `meta` 为 LWW 四元数据（`rev` / `updatedAt` / `updatedBy` / `deletedAt`），缺省是
 * 「基线」：未同步过（`rev: 0`）。`artifactsStore.recordArtifact` 传 `rev: 1` +
 * 当前时刻；`merge` 迁移旧数据也补 `rev: 1`（避免首次同步被对端轻易覆盖）。
 */
export function buildIndexEntry(
  sessionId: string,
  messageId: string,
  artifact: Artifact,
  meta: SyncMeta = { rev: 0, updatedAt: '', updatedBy: '', deletedAt: null },
): ArtifactIndexEntry {
  const hash = artifactContentHash(artifact);
  const entry: ArtifactIndexEntry = {
    id: artifact.id,
    sessionId,
    messageId,
    type: artifact.type,
    contentHash: hash,
    createdAt: artifact.createdAt,
    version: 1,
    versions: [{ version: 1, contentHash: hash, createdAt: artifact.createdAt }],
    ...meta,
  };
  if (artifact.title !== undefined) entry.title = artifact.title;
  if (entry.title !== undefined && entry.versions) entry.versions[0].title = entry.title;
  return entry;
}

/** 检索视图里的「一条产物」：索引元数据 + 内容本体（关键词要搜正文） */
export interface ArtifactItem {
  entry: ArtifactIndexEntry;
  artifact: Artifact;
}

/** 关键词命中：标题 / 内容 / 语言三者之一（大小写不敏感） */
export function matchesKeyword(item: ArtifactItem, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (kw === '') return true;
  const { entry, artifact } = item;
  return (
    (entry.title ?? '').toLowerCase().includes(kw) ||
    artifact.content.toLowerCase().includes(kw) ||
    (artifact.language ?? '').toLowerCase().includes(kw)
  );
}

export interface FilterOptions {
  keyword?: string;
  /** 空数组 / undefined = 不筛类型 */
  types?: ArtifactType[];
  /**
   * 仅显示有版本历史的产物（FR-7.4：`versions` 长度 > 1 = 同源产物被编辑 / 回退过）。
   * 用于「全局检索」里快速挑出被改过的产物，而不是一版定稿的。
   */
  editedOnly?: boolean;
}

/** 同源产物是否有多于一版的版本历史（FR-7.4 落点后才有意义；无 `versions` 视为单版） */
export function hasVersionHistory(entry: ArtifactIndexEntry): boolean {
  return Array.isArray(entry.versions) && entry.versions.length > 1;
}

/** 筛选：关键词 + 类型 + 仅编辑过 */
export function filterItems(items: ArtifactItem[], opts: FilterOptions): ArtifactItem[] {
  const types = opts.types && opts.types.length > 0 ? new Set(opts.types) : null;
  return items.filter(
    (item) =>
      (!types || types.has(item.entry.type)) &&
      (!opts.editedOnly || hasVersionHistory(item.entry)) &&
      matchesKeyword(item, opts.keyword ?? ''),
  );
}

/** 折叠后的一组：同一 `contentHash` 的全部出现 */
export interface ArtifactHashGroup {
  contentHash: string;
  /** 组内按 `createdAt` 升序 */
  items: ArtifactItem[];
}

/**
 * 按 `contentHash` 折叠（跨会话去重的**展示层**，不删数据）。
 *
 * 同内容在多个会话出现时，索引里仍是多条（`sessionId` 不同），折叠只是让产物库
 * 默认不刷屏，并标出「N 处出现」。
 */
export function groupByHash(items: ArtifactItem[]): ArtifactHashGroup[] {
  const buckets = new Map<string, ArtifactItem[]>();
  for (const item of items) {
    const list = buckets.get(item.entry.contentHash);
    if (list) list.push(item);
    else buckets.set(item.entry.contentHash, [item]);
  }
  const groups: ArtifactHashGroup[] = [];
  for (const [contentHash, list] of buckets) {
    list.sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt));
    groups.push({ contentHash, items: list });
  }
  return groups;
}

/**
 * 组间排序（按组内**最新**一条的时间）。
 *
 * 用「组内最新」而不是「组内最早」：折叠后一条代表整个组，用户期望它按最近一次
 * 出现排在前面。
 */
export function sortGroups(
  groups: ArtifactHashGroup[],
  order: 'newest' | 'oldest',
): ArtifactHashGroup[] {
  const sorted = [...groups];
  sorted.sort((a, b) => {
    const at = a.items[a.items.length - 1].entry.createdAt;
    const bt = b.items[b.items.length - 1].entry.createdAt;
    return order === 'newest' ? bt.localeCompare(at) : at.localeCompare(bt);
  });
  return sorted;
}
