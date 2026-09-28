/**
 * 会话的**可同步元数据**判定（design §19.2 / ADR-006，批次 3）。
 *
 * ## 为什么会话单独一件，不走 `syncStamp.ts`
 *
 * 那五个 store 的实体是**数组项**，删除与编辑都是显式动作（`removeAgent` /
 * `updateAgent`），所以「什么时候涨 `rev`」由调用点决定就够了。
 *
 * 会话不是：它只有 `updateSession(id, updater)` 一个入口，**十来个动作都从它走**
 * （重命名 / 置顶 / 换模式 / 换模型 / 换工作空间 / 换权限 / 改记忆快照……）。
 * 若逐个调用点加 `rev + 1`，漏一处就是「这次改动同步不过去」——而且失败形态是
 * 静默的（本地看起来完全正常，换台电脑才发现少了一次改动）。更糟的是日后新增
 * 一个元数据动作时，没有人会记得去加那一行。
 *
 * 所以判定放在**唯一入口**上：`updateSession` 比较「改动前后的可同步字段」，
 * 只在**真的变了**时打脏。这样：
 * - 新增动作自动纳入，不需要谁记得；
 * - 改记忆快照（`memory` / `memoryVersion` / `memoryWorkspace`）这类**纯缓存**
 *   刷新不会涨版本——它们不在清单里，且本来也不该同步。
 *
 * ## 清单是白名单，不是黑名单
 *
 * 会话对象里混着四类东西：可同步的声明（`title` / `pinned` / `mode`…）、本机事实
 * （`streamWorkdir` / `messageCount` / 全部 `memory*`）、内容（`messages`）、
 * 以及运行态（`permissionLog`）。**只有第一类该同步**，而第一类的数量是稳定的、
 * 可枚举的；黑名单则要随新字段不断补，漏一个就把本机事实推上云（§5.2 的假状态）。
 */

import { metaForDelete, metaForEdit, metaForNew } from './syncStamp';
import type { Session, SyncMeta } from '@/types';

/**
 * 参与同步的会话字段（白名单）。
 *
 * 刻意**不含**：
 * - `streamWorkdir`：落盘分片路径，是「记录在哪台机器的哪个目录」，跨设备不成立；
 * - `messageCount`：索引计数，是**派生物**（可从 JSONL 重算），同步它等于把
 *   一台机器的读盘结果当成事实发给另一台；
 * - `memory*`：纯缓存，产出依据是本机文件版本号；
 * - `messages` / `permissionLog`：正文与审计，走事件流与各自通道，不在元数据里。
 *
 * `workdir` 在清单里：它是**语义工作空间**（用户选的目录），是用户的显式选择。
 * 「路径跨设备不成立」这个理由只对 `streamWorkdir` 成立——`workdir` 要不要跨设备
 * 沿用是产品决策，改由同步层的策略处理，不该在这里被悄悄丢掉。
 */
export const SESSION_SYNC_FIELDS = [
  'title',
  'agentId',
  'groupId',
  'skillIds',
  'workdir',
  'fullAccess',
  'toolApproval',
  'mode',
  'model',
  'channel',
  'readonly',
  'pinned',
] as const satisfies readonly (keyof Session)[];

/** 从会话上摘出参与比较的那几个字段 */
export function pickSyncFields(session: Session): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SESSION_SYNC_FIELDS) out[key] = session[key];
  return out;
}

/**
 * 两个值是否可视为「同一份声明」。
 *
 * 数组（只有 `skillIds`）按**元素顺序**比较：技能挂载顺序会影响注入顺序，
 * `['a','b']` 与 `['b','a']` 不是同一份声明。空数组与 `undefined` 视为不同
 * ——`undefined` 表示「跟随默认」，`[]` 表示「显式一个都不挂」，语义确实不同。
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}

/** 会话的可同步字段是否有变化（`prev` 缺省 = 无从比较 → 视为有变化） */
export function sessionMetaChanged(
  prev: Partial<Record<string, unknown>> | undefined,
  next: Partial<Record<string, unknown>>,
): boolean {
  if (!prev) return true;
  return SESSION_SYNC_FIELDS.some((key) => !sameValue(prev[key], next[key]));
}

/**
 * 会话删除时的**墓碑元数据**（软删除，FR-10.1 / `architecture-syncmeta.md` §7.3）。
 *
 * 与 `sessionSyncPatch` 分工不同：那个回答「这次编辑该不该涨版本」，这个回答
 * 「删除时那四个字段各写什么」。判据同样只有一处实现——这里包一层
 * `metaForDelete`，而不是手写 `deletedAt = now()`：
 * `rev += 1`、`updatedAt` 与 `deletedAt` 取**同一时刻**、`updatedBy` 取当前设备，
 * 且**对已墓碑的会话幂等**（重复删除不递增版本，否则 LWW 的「谁更新」会被
 * 「右键删除 + 批量删除」这种重复动作淹没）。
 *
 * 返回完整的 `SyncMeta`（而非 `SessionSyncPatch`）：墓碑必须带齐 `deletedAt` 与
 * `updatedAt`——前者是墓碑判据，后者参与 LWW 比较，少一个同步层就判不出来。
 */
export function sessionDeletePatch(session: Session): SyncMeta {
  return metaForDelete(session);
}

/** 会话上承载的同步元数据（内联在 `Session` 上，与会话索引的条目形状对齐） */
export interface SessionSyncPatch {
  rev?: number;
  updatedBy?: string;
}

/**
 * 改动后的会话该带什么同步元数据，**没变就返回空对象**。
 *
 * 返回空对象而不是原值：`set` 里展开空对象不产生新键，调用方的 `{ ...s, ...patch }`
 * 因此不会因为「多写了两个一模一样的字段」而看起来像改了。
 *
 * `prev` 传**改动前**的会话（老数据没有元数据时按 `rev = 0` 读，本次改动得到 1）。
 */
export function sessionSyncPatch(prev: Session, next: Session, now?: string): SessionSyncPatch {
  if (!sessionMetaChanged(pickSyncFields(prev), pickSyncFields(next))) return {};
  const meta = metaForEdit(prev, now);
  return { rev: meta.rev, updatedBy: meta.updatedBy };
}

/**
 * 新建会话的同步元数据：`rev = 1`。
 *
 * 与 `sessionSyncPatch` 分开，是因为「新建」不该走 `metaForEdit`——后者对一条
 * 从没落过盘的会话会算出 `rev = 1`，数值上巧合一致，但语义上「新建」与
 * 「老数据第一次被改」必须能区分（§六 问题 4 的 `rev = 0` 保留值就靠这个分辨）。
 */
export function sessionCreatePatch(now?: string): SessionSyncPatch {
  const meta = metaForNew(now);
  return { rev: meta.rev, updatedBy: meta.updatedBy };
}

/**
 * 把 `updateSession` 的改动结果包上同步元数据。
 *
 * 这是 `sessionsStore.updateSession` 唯一要调的东西——**别再在调用点手写 `rev`**。
 */
export function withSessionSync(prev: Session, next: Session): Session {
  const patch = sessionSyncPatch(prev, next);
  return Object.keys(patch).length === 0 ? next : { ...next, ...patch };
}
