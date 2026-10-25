/**
 * 同步元数据的纯函数（design §19.2 / ADR-006）。
 *
 * 与 `storageRoutes.ts` / `agent/skillOverrides.ts` 同一条纪律：**纯逻辑不碰 IO**，因而可
 * 真单测。四个字段若让各 store 各自手写（`rev: (a.rev ?? 0) + 1` 之类），一定会漂移
 * ——尤其「老数据的 rev 缺省当 0 还是当 1」这一条，写错就是「升级后老条目的版本号
 * 与新建条目撞车」，且完全不报错。
 *
 * 时刻用可选参数注入（缺省取当前时间），是为了让用例能断言 `updatedAt` / `deletedAt`
 * 的**确切值**，而不是「大概不是 null」。
 */

import type { SyncMeta, SyncMetaInput, SyncTombstones } from '@/types/sync';

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

/**
 * 补齐缺失字段，拿到「有形状的元数据」。
 *
 * 与 `legacyMeta()` 的差别：后者刻意返回全空（`rev = 0`、时间与设备都为空），
 * 用于「新建一条老数据」；本函数**保留已有值**，只把缺失的按老数据读。
 */
export function normalizeMeta(meta: SyncMetaInput | undefined | null): SyncMeta {
  return normalize(meta);
}

/**
 * 迁移用：给实体列表补齐四字段（已有的原样保留，缺的按 `LEGACY_REV` 读）。
 *
 * 与「读取时补」的差别在于**落盘**——`normalize()` 已能兜住缺失字段，所以本函数
 * 不承担正确性，只承担可观测性：补过之后文件里就写着 `rev: 0`，V1.5 首次全量推送
 * 据此识别「迁移前的老数据、从未被改写过」（§六 问题 4 的保留值）。
 */
export function ensureMetaList<T extends SyncMetaInput>(
  list: readonly T[] | undefined | null,
): T[] {
  return (list ?? []).map((item) => ({ ...item, ...normalize(item) }));
}

/**
 * 登记一条删除：把墓碑写进独立表（见 `types/sync.ts` 的 `SyncTombstones`）。
 *
 * **幂等**：已有同 id 墓碑时连引用都不换——重复删除（右键 + 批量、双击确认按钮）
 * 在真实操作里不罕见，而换引用会白白触发一次重渲染。
 */
export function withTombstone(
  tombstones: SyncTombstones | undefined | null,
  id: string,
  meta: SyncMeta,
): SyncTombstones {
  const base = tombstones ?? {};
  if (isTombstone(base[id])) return base;
  return { ...base, [id]: meta };
}

/**
 * 移除墓碑：**「删除后又建了同 id 的条目」必须调它**。
 *
 * 不清的话那张墓碑会在同步时把刚建好的条目按「已删除」推出去，而本机看起来一切
 * 正常（条目在列表里）——最难自查的一类不一致。
 */
export function withoutTombstone(
  tombstones: SyncTombstones | undefined | null,
  id: string,
): SyncTombstones {
  const base = tombstones ?? {};
  if (!(id in base)) return base;
  const { [id]: _dropped, ...rest } = base;
  return rest;
}

/**
 * 把墓碑表展开成「删除态条目」，供同步层与存活条目拼成完整负载。
 *
 * 现在没有调用方（V1 不实现同步），但它是本文几条断言的可测锚点：
 * 「删除可传播」「墓碑带 `rev`」「`withoutTombstone` 之后不再出现」都靠它验证。
 */
export function tombstoneEntries(
  tombstones: SyncTombstones | undefined | null,
): Array<SyncMeta & { id: string }> {
  return Object.entries(tombstones ?? {}).map(([id, meta]) => ({ id, ...normalize(meta) }));
}

/** 新建实体的元数据：`rev = 1`、非墓碑 */
export function stampCreate(updatedBy: string, now: string = nowIso()): SyncMeta {
  return { rev: INITIAL_REV, updatedAt: now, updatedBy, deletedAt: null };
}

/**
 * 从实体上摘出四个元数据字段（**只摘这四个**，不夹带实体自己的字段）。
 *
 * 用途：合并函数重建内置条目时透传「用户对该条目的改动痕迹」。
 * `mergeAgents` / `mergeGroups` / `mergeConfigs` 每次都从代码里的内置定义重建对象，
 * 只有被用户改过的字段被覆盖回去——元数据必须一起覆盖，否则「用户改了内置 Agent
 * 的启用状态」这件事在下次启动后就查无对证（`rev` 回到缺省）。
 *
 * 源对象没有元数据时，这里返回的四个键值为 `undefined`：展开进对象后 JSON 序列化
 * 会自然丢掉它们，读出时按 `LEGACY_REV` 处理——与「从来没写过元数据」等价。
 */
export function pickMeta(source: SyncMetaInput | undefined | null): SyncMetaInput {
  return {
    rev: source?.rev,
    updatedAt: source?.updatedAt,
    updatedBy: source?.updatedBy,
    deletedAt: source?.deletedAt,
  };
}

/**
 * 迁移产出的元数据：`rev = 0`（§六 问题 4 的保留值）、`updatedBy` 为空。
 *
 * **不用 `stampCreate`**：那会给老数据 `rev = 1`，与真新建的条目撞车，
 * 而 LWW 正是靠这个数判谁更新。`rev = 0` 明确表示「迁移前的老数据、从未被改写
 * 过」，V1.5 首次全量推送据此识别需要补齐的对象。
 */
export function legacyMeta(): SyncMeta {
  return { rev: LEGACY_REV, updatedAt: '', updatedBy: '', deletedAt: null };
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
