/**
 * 同步元数据的纯函数（design §19.2 / ADR-006）。
 *
 * 与 `storageRoutes.ts` / `skillOverrides.ts` 同一条纪律：**纯逻辑不碰 IO**，因而可
 * 真单测。四个字段若让各 store 各自手写（`rev: (a.rev ?? 0) + 1` 之类），一定会漂移
 * ——尤其「老数据的 rev 缺省当 0 还是当 1」这一条，写错就是「升级后老条目的版本号
 * 与新建条目撞车」，且完全不报错。
 *
 * 时刻用可选参数注入（缺省取当前时间），是为了让用例能断言 `updatedAt` / `deletedAt`
 * 的**确切值**，而不是「大概不是 null」。
 */

import type { SyncMeta, SyncMetaInput } from '@/types/sync';

/** 新建实体的起始版本号 */
export const INITIAL_REV = 1;

/** 迁移前老数据的版本读数（缺字段一律按它，**不按 `INITIAL_REV`**） */
export const LEGACY_REV = 0;

const nowIso = () => new Date().toISOString();

/**
 * 删除时间的**唯一**判据：非空字符串才算墓碑。
 *
 * 用「非空字符串」而不是「`!== null`」的原因：`deletedAt` 是脏数据时会分叉出
 * 一个永远删不掉的条目（判据说「不是墓碑」、写入说「已经是了」）。这里只留一条规则，
 * `normalize` 与 `isTombstone` 共用它，两者不可能再漂移。
 *
 * 方向也是刻意选的：把脏值读成**存活**（条目照常显示，磁盘上数据还在、可恢复），
 * 而不是读成**墓碑**（条目凭空消失，而用户从界面上看不出任何原因）。
 */
const tombstoneOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/**
 * 补齐缺失字段，让读出的永远是「有形状的元数据」。
 *
 * 不用 `??`：`rev` 是 number，`null` / 字符串 / NaN 都是脏数据，`??` 会原样放过它们，
 * 于是 `markDirty` 算出 `NaN + 1`。判据落在**值**上，不落在键是否存在上。
 */
function normalize(meta: SyncMetaInput | undefined | null): SyncMeta {
  return {
    rev: typeof meta?.rev === 'number' && Number.isFinite(meta.rev) ? meta.rev : LEGACY_REV,
    updatedAt: typeof meta?.updatedAt === 'string' ? meta.updatedAt : '',
    updatedBy: typeof meta?.updatedBy === 'string' ? meta.updatedBy : '',
    deletedAt: tombstoneOf(meta?.deletedAt),
  };
}

/** 新建实体的元数据：`rev = 1`、非墓碑 */
export function stampCreate(updatedBy: string, now: string = nowIso()): SyncMeta {
  return { rev: INITIAL_REV, updatedAt: now, updatedBy, deletedAt: null };
}

/**
 * 标记「被改写过」：`rev += 1` 并刷新时间与修改者。
 *
 * **刻意不动 `deletedAt`**：编辑一条已打墓碑的条目不会让它复活。墓碑是删除的事实，
 * 复活必须是一个显式动作（V1 没有这个动作）；顺手改回 `null` 会让别的设备收到
 * 「删了又出现」的抖动，而这在 LWW 下无法与「新增一条同名条目」区分。
 *
 * 入参允许是老数据（无元数据）：`rev` 读作 `LEGACY_REV`，本次改动得到 `rev = 1`。
 */
export function markDirty(
  meta: SyncMetaInput | undefined | null,
  updatedBy: string,
  now: string = nowIso(),
): SyncMeta {
  const base = normalize(meta);
  return { rev: base.rev + 1, updatedAt: now, updatedBy, deletedAt: base.deletedAt };
}

/**
 * 标记删除（墓碑）：写 `deletedAt` 并递增 `rev`，**不摘除数组项**。
 *
 * **幂等**：已经是墓碑的条目再删一次什么都不改（连 `rev` 都不动）。删两次递增两个
 * 版本会让同步层的「谁更新」失去意义，而重复删除在真实操作里并不罕见（右键删除 +
 * 批量删除、双击确认按钮）。
 */
export function markDeleted(
  meta: SyncMetaInput | undefined | null,
  updatedBy: string,
  now: string = nowIso(),
): SyncMeta {
  const base = normalize(meta);
  if (base.deletedAt !== null) return base;
  return { rev: base.rev + 1, updatedAt: now, updatedBy, deletedAt: now };
}

/**
 * 是否墓碑。
 *
 * 缺字段、`null`、空串都算**存活**——这是「老数据没打过墓碑」的唯一正确读法
 * （反过来把 undefined 当墓碑，会让升级后所有老条目一次性消失）。
 */
export function isTombstone(meta: SyncMetaInput | undefined | null): boolean {
  return tombstoneOf(meta?.deletedAt) !== null;
}
