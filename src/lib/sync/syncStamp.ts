/**
 * 带设备标识的同步标记入口（**store 专用**）。
 *
 * ## 为什么在 `sync/syncMeta.ts` 之外再包一层
 *
 * `lib/sync/syncMeta.ts` 是**纯函数**——时刻与设备标识都从入参注入，因而可真单测。
 * store 的写动作没法注入：它是用户点击触发的，只能读「当前设备是谁」这个同步快照。
 * 于是每个 store 都得写 `markDirty(entity, currentDeviceId() ?? '')`。
 *
 * 这句话在本批次要出现四十多次。重复的代价不是字数，而是**各写各的**：
 * 有人会漏 `?? ''`（TS 会拦），有人会图省事写 `'unknown'`（TS 不拦）——
 * 后者让多台机器共用同一个 `updatedBy`，LWW 里「谁改的」彻底失去意义，
 * 而失败形态是静默的（同步照常工作，只是冲突归因全错）。
 *
 * 所以固化在这里：**store 侧只有这三个入口**，命名与 `sync/syncMeta.ts` 的
 * `stampCreate` / `markDirty` / `markDeleted` 刻意不同，避免混用。
 *
 * ## 未预热时 `updatedBy` 落成空串
 *
 * `currentDeviceId()` 在启动预热完成前返回 `null`（见 `lib/core/deviceId.ts`）。
 * 这里落成空串而**不是** `'unknown'`：空串明确表示「来源未知」，而 `'unknown'`
 * 会伪装成一台真实设备。`rev` 照常递增——它才是 LWW 的判据，`updatedBy` 只用于溯源。
 * 预热由 `src/App.tsx` 的启动副作用保证，正常交互路径上不会走到这个分支。
 */

import { currentDeviceId } from '@/lib/core/deviceId';
import { markDeleted, markDirty, stampCreate } from '@/lib/sync/syncMeta';
import type { SyncMeta, SyncMetaInput } from '@/types';

/** 新建条目的元数据：`rev = 1`、非墓碑 */
export function metaForNew(now?: string): SyncMeta {
  return stampCreate(currentDeviceId() ?? '', now);
}

/**
 * 改动条目的元数据：`rev += 1`。
 *
 * 入参是**改动前**的实体（老数据没有元数据时按 `LEGACY_REV` 读，本次改动得到 `rev = 1`）。
 * 刻意不清 `deletedAt`：编辑一条已打墓碑的条目不会让它复活。
 */
export function metaForEdit(meta: SyncMetaInput | undefined | null, now?: string): SyncMeta {
  return markDirty(meta, currentDeviceId() ?? '', now);
}

/**
 * 删除条目的元数据：打墓碑（`deletedAt = now`）、`rev += 1`，**不摘除数组项**。
 *
 * 幂等：对已墓碑的条目再删一次什么都不改（`rev` 也不动）。
 */
export function metaForDelete(meta: SyncMetaInput | undefined | null, now?: string): SyncMeta {
  return markDeleted(meta, currentDeviceId() ?? '', now);
}
