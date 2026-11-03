/**
 * 侧边栏菜单的**顺序**模型：id 表 + 三个纯函数。
 *
 * ## 为什么顺序要用 id 而不是文案 / 下标
 *
 * 存下标的话，日后往菜单里插一项、删一项，老用户的持久化里那一串数字就整体错位
 * ——表现是「我的菜单顺序莫名其妙变了」，且没有任何报错。存 id 则天然可对齐：
 * 归一化时按 id 补回新增项、丢掉已删除项，顺序本身不动。
 *
 * 文案同理不能当键：菜单文案会改（「知识库」以后可能叫「资料库」），改一次
 * 全员的顺序表就失效一次。
 *
 * ## 为什么归一化必须「补齐缺失项」
 *
 * 老用户表里必然没有本次新增的菜单项。若只过滤不补齐，那一项就永远不显示——
 * 不是报错，是**入口悄悄消失**，属于最难被发现的一类退化。补齐放在末尾：
 * 新功能默认排在最后，不打断用户已经调好的顺序。
 *
 * 本文件刻意**不 import React / MUI**：`settingsStore` 的迁移要用它，
 * 而 store 层引入组件库会把 MUI 拖进同步 / 迁移这些非 UI 代码路径。
 */

/** 一级菜单里**可拖拽排序**的行（「新建任务」固定第一行，不在此表内） */
export type PrimaryMenuId = 'tasks' | 'knowledge' | 'capabilities' | 'more';

/** 「更多」浮层里的行 */
export type MoreMenuId = 'projects' | 'orgAssets' | 'audit';

/** 一级菜单默认顺序（也是「补齐缺失项」的基准顺序） */
export const PRIMARY_MENU_IDS: readonly PrimaryMenuId[] = [
  'tasks',
  'knowledge',
  'capabilities',
  'more',
];

/** 「更多」浮层默认顺序 */
export const MORE_MENU_IDS: readonly MoreMenuId[] = ['projects', 'orgAssets', 'audit'];

/**
 * 把持久化里的顺序表收敛成「合法且完整」的顺序。
 *
 * 三步：丢掉非法项（不是本表里的 id / 非字符串）→ 去重 → 按默认顺序补回缺失项。
 * 顺序表可能是 `undefined`（老用户）、`null`（手工写入）、甚至是字符串——一律当空表。
 */
export function normalizeMenuOrder<T extends string>(
  saved: unknown,
  all: readonly T[],
): T[] {
  const raw = Array.isArray(saved)
    ? saved.filter((v): v is string => typeof v === 'string')
    : [];
  const known = new Set<string>(all);
  const out: T[] = [];
  for (const id of raw) {
    // `known.has` 挡非法 id，`includes` 挡重复
    if (known.has(id) && !out.includes(id as T)) out.push(id as T);
  }
  for (const id of all) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 把**持久化里存着的**顺序表收敛成合法顺序，但**空表保持空表**。
 *
 * 与 `normalizeMenuOrder` 的差别只有一个，却是关键的一个：空表要原样返回 `[]`，
 * 不能补成默认顺序全集。空表的语义是「用户没调过，跟着代码里的默认顺序走」；
 * 若迁移时把它写成全集，等于替用户「调过了」，日后调整默认顺序老用户永远收不到。
 *
 * 渲染侧才用 `normalizeMenuOrder`（那里需要一份**可渲染的完整顺序**）。
 * 两个函数分开，是为了让「存储语义」与「渲染语义」各自只被表达一次。
 */
export function normalizeStoredMenuOrder<T extends string>(
  saved: unknown,
  all: readonly T[],
): T[] {
  if (!Array.isArray(saved) || saved.length === 0) return [];
  return normalizeMenuOrder(saved, all);
}

/**
 * 把 `list[from]` 移到 `to`（`to` 是**移出后**的目标下标，即「最终第几位」）。
 *
 * 越界的 `to` 夹到两端而不是抛错：拖到列表外（鼠标跑出弹窗）是常见操作，
 * 让它落到「最前 / 最后」比让整个面板崩掉合理。
 */
export function moveMenuItem<T>(
  list: readonly T[],
  from: number,
  to: number,
): T[] {
  if (from < 0 || from >= list.length) return list as T[];
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (from === target) return list as T[];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * 由指针纵坐标算出「应插入到第几位」。
 *
 * ## 为什么用「相对列表顶部的槽位」而不是「指针压在哪一行」
 *
 * 行是**边拖边实时重排**的（参考视频里其余行会当场让位）。若判据是「指针压在哪
 * 一行」，那个判据会随重排一起变化 —— 判据与结果互为因果，拖到一半开始来回抖。
 * 这里把判据锚在「列表顶 + 槽位序号 × 行距」上：这两个量都在 `pointerdown` 时
 * 快照，与后续重排无关，于是同一个指针位置恒得同一个下标，天然不抖。
 *
 * `pitch` 是**行距**（行高 + 行间空隙），不是行高。用行高会在有空隙的列表里
 * 逐行累积偏差，拖到第 4 行就已经偏了半行。
 *
 * 越界一律夹到两端：拖到列表外（鼠标跑出弹窗）是常见操作，让它落到「最前 / 最后」
 * 比让面板崩掉合理。`pitch <= 0`（还没测量出来）时返回 -1，表示「这一帧不动」。
 */
export function dropInsertIndex(
  pointerY: number,
  listTop: number,
  pitch: number,
  count: number,
): number {
  if (!(pitch > 0) || count <= 0) return -1;
  const raw = Math.floor((pointerY - listTop) / pitch);
  return Math.max(0, Math.min(count - 1, raw));
}

