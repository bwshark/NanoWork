/**
 * 产物同步适配器——引擎与「产物索引 + 内容池」的**唯一耦合点**（M6 批次 6，规格见
 * `docs/artifact-sync-spec.md`）。
 *
 * ## 为什么是第四类通道（与 `syncRegistry` / `eventStream` / `fileAssets` 并列）
 *
 * 产物有两个维度，塞不进 `SyncCollectionSpec` 的同步 `read()`：
 * 1. **索引条目**（`artifactsStore.index`）：LWW 实体（键 = `id`，自带 `rev` /
 *    `updatedAt` / `updatedBy` / `deletedAt`，走同步层三级 tie-break 裁决 `title` 演进）。
 * 2. **内容池**（`artifactsStore.bodies`）：内容寻址 blob（键 = `contentHash`，正文
 *    不可变，SHA-256 相同则内容必相同）——这是「内容寻址同步」的核心：同 hash 的
 *    正文在云端只存一份，跨端天然去重。
 *
 * 两者都用「全异步、可选注入」的适配器承载，引擎因此**不 import 任何 store**（不变量 2）。
 *
 * ## 两个 collection（不登记进 `syncRegistry`，见 `types.ts` `SyncCollection` 注释）
 *
 * - `artifactIndex`：LWW 实体，键 = `id`。存活条目 + 墓碑（跨端删除传播）都走它。
 * - `artifactBodies`：内容寻址 blob，键 = `contentHash`。`rev` 恒 1、`updatedAt` 恒 `''`、
 *   `deletedAt` 恒 `null`——内容不可变，LWW 永远「完全同版 → 平局 → 服务端保留先到者」，
 *   不会因时间戳漂移而覆盖（内容相同，覆盖无害）。
 *
 * ## `updatedBy` 由适配器补（与 `fileAssets` 同款）
 *
 * `appInfo()` 是异步的，store 的同步写入动作（`recordArtifact` / `clearSession` /
 * `clearAll`）拿不到 `deviceId`，故条目里的 `updatedBy` 写成空串 `''`，本适配器在
 * `hydrate()`（异步）取设备 id，`collect()` 阶段补成真实值。
 */

import { platform } from '@/platform';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { compareVersions } from './SyncEngine';
import type { SyncChange, VersionStamp } from './types';
import type { ArtifactIndexEntry, ArtifactVersionMeta, SyncMeta } from '@/types';

/** 产物同步的两个 collection 名（**不登记进 `syncRegistry`**，见文件头） */
export const ARTIFACT_COLLECTIONS = {
  artifactIndex: 'artifactIndex',
  artifactBodies: 'artifactBodies',
} as const;

/** 产物同步适配器（与 `FileAssetsAdapter` / `SessionEventStreamAdapter` 同款：全异步、可选注入）。 */
export interface ArtifactsAdapter {
  /**
   * 取设备 id（填 `updatedBy` 用）。必须在 `collect()` / `apply()` 之前调用——
   * 引擎在 pull 之前调一次。
   */
  hydrate(): Promise<void>;
  /** 上行负载（`artifactIndex` 存活 + 墓碑 + `artifactBodies` 内容池）；未 `hydrate()` 返回空数组。 */
  collect(): SyncChange[];
  /** 落地一条远端变更；返回是否真的改动了本机（0 / 1）。 */
  apply(change: SyncChange): Promise<number>;
}

/** 未知值收敛成字符串（脏值一律丢弃，不让它污染合并 / 裁决） */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 未知值收敛成数字（脏值一律 0） */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 实体 → 裁决用的版本四要素（`id` 缺失时用落点键兜底） */
function stampOf(id: string, meta: SyncMeta): VersionStamp {
  return {
    id,
    rev: asNumber(meta.rev),
    updatedAt: asString(meta.updatedAt),
    deletedAt: meta.deletedAt ? asString(meta.deletedAt) : null,
  };
}

/**
 * 装配产物同步适配器。
 *
 * **不接收账户 scope**：索引条目自带 LWW 四元数据（`artifactsStore.index`），与
 * `agents` / `tasks` 等 8 个实体同款——同步元数据就在 store 里，无需像 `fileAssets`
 * 那样另存一份按账户分片的 `PersistedState`。store 是单例全局（假设单账户设备），
 * 与 8 个实体的同步同源、不引入账户分片（跨账户隔离归后续）。
 */
export function createArtifactsAdapter(): ArtifactsAdapter {
  let deviceId = '';
  let hydrated = false;

  return {
    async hydrate(): Promise<void> {
      deviceId = (await platform.appInfo())?.deviceId ?? '';
      hydrated = true;
    },

    collect(): SyncChange[] {
      if (!hydrated) return [];
      const state = useArtifactsStore.getState();
      const out: SyncChange[] = [];

      // 1. 索引存活条目（含 LWW 四元数据；`updatedBy` 由 store 写空串，此处补设备 id）
      for (const entry of Object.values(state.index)) {
        out.push({
          collection: ARTIFACT_COLLECTIONS.artifactIndex,
          entity: { ...entry, updatedBy: entry.updatedBy || deviceId } as unknown as Record<
            string,
            unknown
          >,
        });
      }

      // 2. 索引墓碑（跨端删除传播：本地 `clearSession` / `clearAll` 写下的）
      for (const [id, meta] of Object.entries(state.indexTombstones)) {
        out.push({
          collection: ARTIFACT_COLLECTIONS.artifactIndex,
          entity: {
            id,
            rev: meta.rev,
            updatedAt: meta.updatedAt,
            updatedBy: meta.updatedBy || deviceId,
            deletedAt: meta.deletedAt,
          },
        });
      }

      // 3. 内容池（内容寻址：同 hash 云端只存一份；内容不可变 → rev 恒 1 / updatedAt 恒 ''
      //    / deletedAt 恒 null，LWW 永远平局、服务端保留先到者，不覆盖）
      for (const [hash, content] of Object.entries(state.bodies)) {
        out.push({
          collection: ARTIFACT_COLLECTIONS.artifactBodies,
          entity: {
            id: hash,
            content,
            rev: 1,
            updatedAt: '',
            updatedBy: deviceId,
            deletedAt: null,
          },
        });
      }

      return out;
    },

    async apply(change: SyncChange): Promise<number> {
      if (!hydrated) return 0;
      const collection = change?.collection;
      const entity = (change?.entity ?? {}) as Record<string, unknown>;
      const id = asString(entity.id);
      if (!id) return 0;

      // ── 内容池：内容寻址 upsert（正文不可变，命中即无改动）──
      if (collection === ARTIFACT_COLLECTIONS.artifactBodies) {
        const content = asString(entity.content);
        const current = useArtifactsStore.getState().bodies[id];
        if (current === content) return 0;
        useArtifactsStore.setState((s) => ({ bodies: { ...s.bodies, [id]: content } }));
        return 1;
      }

      // ── 索引：LWW 实体（存活合并 / 墓碑摘除）──
      if (collection === ARTIFACT_COLLECTIONS.artifactIndex) {
        const deletedAt = entity.deletedAt ? asString(entity.deletedAt) : null;

        // 墓碑：摘除存活条目 + 写墓碑表（幂等：已是同态则不改）
        if (deletedAt) {
          const meta: SyncMeta = {
            rev: asNumber(entity.rev),
            updatedAt: asString(entity.updatedAt),
            updatedBy: asString(entity.updatedBy),
            deletedAt,
          };
          let changed = false;
          useArtifactsStore.setState((s) => {
            if (!s.index[id] && s.indexTombstones[id]) return s; // 已是同态
            const index = { ...s.index };
            delete index[id];
            changed = true;
            return { index, indexTombstones: { ...s.indexTombstones, [id]: meta } };
          });
          return changed ? 1 : 0;
        }

        // 存活：构造完整条目（仅当对端带来该字段时才覆盖本地，避免脏数据抹掉 title）
        const incoming: ArtifactIndexEntry = {
          id,
          sessionId: asString(entity.sessionId),
          type: asString(entity.type) as ArtifactIndexEntry['type'],
          contentHash: asString(entity.contentHash),
          createdAt: asString(entity.createdAt),
          rev: asNumber(entity.rev),
          updatedAt: asString(entity.updatedAt),
          updatedBy: asString(entity.updatedBy),
          deletedAt: null,
          version: asNumber(entity.version) || 1,
        };
        if (entity.messageId !== undefined) incoming.messageId = asString(entity.messageId);
        if (entity.title !== undefined) incoming.title = asString(entity.title);
        // FR-7.4 版本链：随 LWW 条目一起落地（LWW 裁决只看 rev/updatedAt，版本元数据不参与胜负）
        if (entity.previousVersion !== undefined) {
          incoming.previousVersion = asString(entity.previousVersion);
        }
        if (Array.isArray(entity.versions)) {
          incoming.versions = entity.versions as ArtifactVersionMeta[];
        }

        const local = useArtifactsStore.getState().index[id];
        if (local === undefined) {
          useArtifactsStore.setState((s) => ({ index: { ...s.index, [id]: incoming } }));
          return 1;
        }

        // 三级 tie-break：远端严格更新才采用（与 `applyChange` 同款语义，平局归本地）
        const winner = compareVersions(stampOf(id, incoming), stampOf(id, local));
        if (winner > 0) {
          useArtifactsStore.setState((s) => ({ index: { ...s.index, [id]: incoming } }));
          return 1;
        }
        return 0;
      }

      return 0;
    },
  };
}
