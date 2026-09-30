import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { platform, zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { artifactContentHash, buildIndexEntry } from '@/lib/artifactIndex';
import { isFileArtifact } from '@/lib/fileArtifact';
import type { Artifact, ArtifactIndexEntry, ArtifactVersionMeta, SyncTombstones } from '@/types';

interface ArtifactsState {
  /**
   * 按 sessionId 归档的**引用**（已去 `content`）。
   *
   * 正文按 `contentHash` 只在 `bodies` 存一份（彻底去重，见规格 D1）；渲染前由
   * `ArtifactsPage` / `ArtifactPanel` 用 `resolveArtifactContent` 从 `bodies` 按
   * `entry.contentHash` 回填。image / video 的 `content` 本就是空串，不入 `bodies`，
   * 渲染回落 `url`。
   */
  bySession: Record<string, Artifact[]>;
  /**
   * 内容池：`contentHash` → 正文（彻底去重的唯一正本）。
   *
   * 同内容在任意数量会话出现，这里只占一个 key。image / video 不入池（正文为空）。
   * 必须进 `partialize`：否则重启后索引在、正文丢，与 `bySession` 立刻不一致。
   */
  bodies: Record<string, string>;
  /**
   * 独立索引：`id → 条目`（FR-7.2 + 产物同步）。
   *
   * 这是**跨会话检索与去重的权威入口**，两端都有（Web 端无文件系统也走它）。
   * 条目自带 LWW 四元数据（`rev` / `updatedAt` / `updatedBy` / `deletedAt`），作为
   * LWW 实体跨端传播（见 `src/sync/artifacts.ts`）。Electron 额外把它镜像成
   * `<userData>/artifact-index/<id>.json`（单向，见规格 D7）。
   */
  index: Record<string, ArtifactIndexEntry>;
  /**
   * 索引条目的墓碑表（产物同步，与 8 个实体的 `SyncTombstones` 同款）。
   *
   * `clearSession` / `clearAll` 删除的索引条目**不硬删**，而是摘除 + 写墓碑，使删除
   * 可跨端传播（本地删了，其它设备下一轮同步也删）。键 = 条目 `id`，值 = `SyncMeta`。
   */
  indexTombstones: SyncTombstones;
  /**
   * 记录一个产物。
   *
   * - 同 `id` 且内容相同：重放再确认（标题变化则同步更新，不升版本）；
   * - 同 `id` 内容不同：**升一版**（FR-7.4 同源产物多版本）；
   * - 新 `id`：新建（含 LWW 四元数据 + `version: 1` + 初始 `versions`）。
   *
   * **文件产物**（`type: 'file'`）复用同一套：其 `id` 由路径派生，于是「同一个文件
   * 被再写一次」自然落到「同 id 升一版」——`version > 1` 即「变更」。唯一的差别是
   * 不参与按内容的同会话去重（见实现处注释）。
   */
  recordArtifact: (sessionId: string, messageId: string, artifact: Artifact) => void;
  /** FR-7.4：用户显式把 `artifactId` 编辑成新内容 → 升一版（内容相同则忽略） */
  recordArtifactVersion: (artifactId: string, artifact: Artifact) => void;
  /** FR-7.4：把 `artifactId` 回退到历史版本 `targetHash` 的正文（新开一版，旧正文仍在 `bodies`） */
  rollbackToVersion: (artifactId: string, targetHash: string, title?: string) => void;
  /**
   * 摘除若干产物（引擎把对应文件删掉了）。
   *
   * 与 `clearSession` 同源：**摘除 + 写墓碑**（删除要能跨端传播），`bodies` 不动
   * （同 hash 可能被别的产物引用）。留着条目只会让面板出现一张点开报错的卡片。
   */
  removeArtifacts: (ids: string[]) => void;
  clearSession: (sessionId: string) => void;
  clearAll: () => void;
}

/** 镜像写入失败不该影响入库（索引切片才是权威）；静默即可 */
function mirrorPut(entry: ArtifactIndexEntry): void {
  void platform.artifactIndex.put(entry).catch(() => undefined);
}

function mirrorRemove(id: string): void {
  void platform.artifactIndex.remove(id).catch(() => undefined);
}

/**
 * FR-7.4 升一版：在已有条目上把新内容写进 `bodies` 内容池，并推进 `version` /
 * `previousVersion` / `versions`。
 *
 * 写成模块级函数（而非 store action）：版本动作要从多处调用（`recordArtifact` 的同 id
 * 内容变化、`recordArtifactVersion` 用户编辑、`rollbackToVersion` 回退），且需要直接读
 * 写 store（用 `useArtifactsStore` 实例而非工厂的 `get`/`set`），避免改动 `create` 工厂
 * 的形状。`bodies` 按内容哈希去重：正文已存在则只更新引用。
 *
 * 幂等：`newHash === existing.contentHash` → 无变化，直接返回（重放同内容事件不升版）。
 */
function bumpVersion(
  existing: ArtifactIndexEntry,
  sessionId: string,
  messageId: string,
  artifact: Artifact,
): void {
  const hash = artifactContentHash(artifact);
  if (existing.contentHash === hash) return; // 内容没变不升版

  const now = new Date().toISOString();
  const bodies = artifact.content ? { ...useArtifactsStore.getState().bodies, [hash]: artifact.content } : useArtifactsStore.getState().bodies;
  const newVersion = (existing.version ?? 1) + 1;
  const versions: ArtifactVersionMeta[] = Array.isArray(existing.versions)
    ? [
        ...existing.versions,
        { version: newVersion, contentHash: hash, createdAt: now, title: artifact.title },
      ]
    : [
        { version: 1, contentHash: existing.contentHash, createdAt: existing.createdAt, title: existing.title },
        { version: newVersion, contentHash: hash, createdAt: now, title: artifact.title },
      ];

  const entry: ArtifactIndexEntry = {
    ...existing,
    type: artifact.type,
    title: artifact.title,
    contentHash: hash,
    version: newVersion,
    previousVersion: existing.contentHash,
    versions,
    rev: (typeof existing.rev === 'number' ? existing.rev : 0) + 1,
    updatedAt: now,
    updatedBy: '',
    deletedAt: null,
  };

  // 更新 `bySession` 里该 id 的引用（正文去 content，只留元数据）
  const list = useArtifactsStore.getState().bySession[sessionId] ?? [];
  const ref: Artifact = { ...artifact, content: '' };
  const bySession = {
    ...useArtifactsStore.getState().bySession,
    [sessionId]: list.map((a) => (a.id === artifact.id ? ref : a)),
  };

  useArtifactsStore.setState((s) => ({ bySession, bodies, index: { ...s.index, [artifact.id]: entry } }));
  mirrorPut(entry);
}

/**
 * 渲染前把引用还原成带正文的 `Artifact`。
 *
 * `bodies` 命中（非图片的正文）取池里的正本；未命中（图片 / 未迁移的旧数据）回落
 * `fallback`（内联 content）——两种情形渲染面都不丢正文。
 */
export function resolveArtifactContent(
  contentHash: string,
  bodies: Record<string, string>,
  fallback: string,
): string {
  return bodies[contentHash] ?? fallback;
}

export const useArtifactsStore = create<ArtifactsState>()(
  persist(
    (set, get) => ({
      bySession: {},
      bodies: {},
      index: {},
      indexTombstones: {},

      recordArtifact: (sessionId, messageId, artifact) => {
        const hash = artifactContentHash(artifact);
        const existing = get().index[artifact.id];

        // 已存在同 id 条目：FR-7.4 同源产物演进
        if (existing) {
          if (existing.contentHash === hash) {
            // 同内容重放：标题变了则同步更新（不升版本，避免重放污染版本链）
            if (existing.title !== artifact.title) {
              const entry: ArtifactIndexEntry = {
                ...existing,
                title: artifact.title,
                rev: (typeof existing.rev === 'number' ? existing.rev : 0) + 1,
                updatedAt: new Date().toISOString(),
                updatedBy: '',
              };
              if (entry.versions && entry.versions.length > 0) {
                const last = entry.versions[entry.versions.length - 1];
                entry.versions = [...entry.versions.slice(0, -1), { ...last, title: artifact.title }];
              }
              set((s) => ({ index: { ...s.index, [artifact.id]: entry } }));
              mirrorPut(entry);
            }
            return;
          }
          // 同 id 内容不同 → 升一版（同源产物多版本）
          bumpVersion(existing, sessionId, messageId, artifact);
          return;
        }

        // 新产物：入库去重（规格 D3）——**同会话内**已有相同内容 → 跳过。
        // 判据走索引而不是逐个重算 `bySession` 里每条的 hash——索引就是去重的权威。
        //
        // **文件产物不走这条去重**：它的身份是路径而不是内容，两个文件完全可能内容
        // 相同（模板 / 复制），按内容去重会把第二个文件整条吞掉。同路径的重复写入
        // 已由上面的 `existing` 分支（升版）处理，不会重复入库。
        if (!isFileArtifact(artifact)) {
          const duplicated = Object.values(get().index).some(
            (e) => e.sessionId === sessionId && e.contentHash === hash,
          );
          if (duplicated) return;
        }

        const list = get().bySession[sessionId] ?? [];
        // `id` 去重是既有行为（同一个产物事件重放时不重复入库），保留
        if (list.some((a) => a.id === artifact.id)) return;

        // 彻底去重（规格 D1）：正文按 hash 只存一份进 `bodies`；`bySession` 只留引用。
        // 空正文（image / video）不入池——它本就靠 `url` 渲染，写空串进池无意义。
        const bodies = artifact.content
          ? { ...get().bodies, [hash]: artifact.content }
          : get().bodies;
        const reference: Artifact = { ...artifact, content: '' };

        // 索引条目带 LWW 四元数据初值（新建 rev=1、当前时刻）。`updatedBy` 因 store
        // 同步写不到异步的 deviceId，留空串，由同步适配器 `collect()` 补成真实设备 id。
        const entry = buildIndexEntry(sessionId, messageId, artifact, {
          rev: 1,
          updatedAt: new Date().toISOString(),
          updatedBy: '',
          deletedAt: null,
        });
        set((s) => ({
          bySession: { ...s.bySession, [sessionId]: [...list, reference] },
          bodies,
          index: { ...s.index, [entry.id]: entry },
        }));
        mirrorPut(entry);
      },

      recordArtifactVersion: (artifactId, artifact) => {
        const existing = get().index[artifactId];
        if (!existing) return;
        bumpVersion(existing, existing.sessionId, existing.messageId ?? '', artifact);
      },

      rollbackToVersion: (artifactId, targetHash, title) => {
        const existing = get().index[artifactId];
        if (!existing) return;
        // 正文按 contentHash 存于 `bodies`；图片 / video 不进池则无法回退
        const content = get().bodies[targetHash];
        if (content === undefined) return;
        bumpVersion(existing, existing.sessionId, existing.messageId ?? '', {
          id: artifactId,
          type: existing.type,
          title: title ?? existing.title,
          content,
          createdAt: new Date().toISOString(),
        });
      },

      removeArtifacts: (ids) => {
        if (ids.length === 0) return;
        const wanted = new Set(ids);
        // 墓碑按索引条目写；但**摘除**不依赖索引存在——旧数据的引用切片可能没有
        // 对应条目，只删引用也要删干净，否则列表里照样留着那张卡片
        const doomed = ids
          .map((id) => get().index[id])
          .filter((e): e is ArtifactIndexEntry => !!e);
        const now = new Date().toISOString();
        set((s) => {
          const bySession = { ...s.bySession };
          for (const [sessionId, list] of Object.entries(bySession)) {
            const next = list.filter((a) => !wanted.has(a.id));
            if (next.length !== list.length) bySession[sessionId] = next;
          }
          const index = { ...s.index };
          const indexTombstones = { ...s.indexTombstones };
          for (const e of doomed) {
            delete index[e.id];
            indexTombstones[e.id] = {
              rev: (typeof e.rev === 'number' ? e.rev : 0) + 1,
              updatedAt: now,
              updatedBy: '',
              deletedAt: now,
            };
          }
          // `bodies` 不清：同 hash 可能被其它产物引用，误删会让对方正文消失
          return { bySession, index, indexTombstones };
        });
        doomed.forEach((e) => mirrorRemove(e.id));
      },

      clearSession: (sessionId) => {
        const doomed = Object.values(get().index).filter((e) => e.sessionId === sessionId);
        const now = new Date().toISOString();
        set((s) => {
          const bySession = { ...s.bySession };
          delete bySession[sessionId];
          const index = { ...s.index };
          const indexTombstones = { ...s.indexTombstones };
          for (const e of doomed) {
            delete index[e.id];
            // 跨端删除传播：摘除 + 写墓碑（rev+1 推进版本、deletedAt 标删除时刻）。
            // `updatedBy` 留空串，由同步适配器 `collect()` 补设备 id。
            indexTombstones[e.id] = {
              rev: (typeof e.rev === 'number' ? e.rev : 0) + 1,
              updatedAt: now,
              updatedBy: '',
              deletedAt: now,
            };
          }
          // `bodies` 不清：同 hash 可能被其它会话引用，误删会让对方正文消失
          // （孤儿 `bodies` 代价见规格已知偏差 #1）。
          return { bySession, index, indexTombstones };
        });
        doomed.forEach((e) => mirrorRemove(e.id));
      },

      clearAll: () => {
        const doomed = Object.values(get().index);
        const now = new Date().toISOString();
        set((s) => {
          const indexTombstones = { ...s.indexTombstones };
          for (const e of doomed) {
            indexTombstones[e.id] = {
              rev: (typeof e.rev === 'number' ? e.rev : 0) + 1,
              updatedAt: now,
              updatedBy: '',
              deletedAt: now,
            };
          }
          return { bySession: {}, bodies: {}, index: {}, indexTombstones };
        });
        doomed.forEach((e) => mirrorRemove(e.id));
      },
    }),
    {
      name: STORAGE_KEYS.artifacts,
      storage: zustandStorage,
      // `index` / `bodies` / `indexTombstones` 必须与 `bySession` 一起落盘，否则重载后
      // 索引在、正文丢、墓碑丢（墓碑丢 → 删除无法跨端传播）
      partialize: (s) => ({
        bySession: s.bySession,
        bodies: s.bodies,
        index: s.index,
        indexTombstones: s.indexTombstones,
      }),
      // 一次性迁移（规格 D2）：旧 `bySession` 内联正文搬进 `bodies`、原位置置空。
      // 放在 `merge` 而非 `onRehydrateStorage`——后者在同步 rehydrate 时会引用尚未
      // 赋值的 `useArtifactsStore` 常量（TDZ 崩溃），`merge` 拿到的就是最终 state。
      // 升级后首启执行一次；之后 `recordArtifact` 已直接写池，无需再搬。
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ArtifactsState>;
        const bySession = p.bySession ?? {};
        const bodies = { ...(p.bodies ?? {}) };
        const index = { ...(p.index ?? {}) };
        for (const [sessionId, list] of Object.entries(bySession)) {
          for (const a of list) {
            if (a?.content) {
              const h = artifactContentHash(a);
              if (!bodies[h]) bodies[h] = a.content;
              // 旧数据可能缺索引条目：用 strip 前原文补一条，确保 `contentHash` 与
              // `bodies` 的 key 一致（否则渲染回填会按错误的 hash 取不到正文）。
              // 补的条目给 `rev: 1`（避免首次同步被对端轻易覆盖；旧数据无版本信息）。
              if (!index[a.id]) {
                index[a.id] = buildIndexEntry(sessionId, '', a, {
                  rev: 1,
                  updatedAt: '',
                  updatedBy: '',
                  deletedAt: null,
                });
              }
              a.content = '';
            }
          }
        }
        // 旧持久化数据可能无 `indexTombstones` 字段：归一到空表，避免 undefined 破坏类型
        const indexTombstones = (p.indexTombstones ?? {}) as SyncTombstones;
        return { ...current, bySession, bodies, index, indexTombstones };
      },
    },
  ),
);
