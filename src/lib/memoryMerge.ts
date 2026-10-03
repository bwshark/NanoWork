/**
 * 记忆正文的**段落级 LWW**（PRD §19.3 / 批次 6b）。
 *
 * ## 为什么单独一个模块
 *
 * 这两个能力本来在 `src/lib/memory.ts` 里，而 `memory.ts` import 了 `@/platform`
 * ——渲染层专有。合并逻辑要被**同步层**（`src/sync/fileAssets.ts`）与**单测**直接调用，
 * 且必须在纯 Node / jsdom 下可跑，所以把无依赖的纯逻辑集中在这里：
 * `memory.ts` 转出（它已这么转过一次 `workspaceKeyFor`），调用点零改动。
 *
 * 本模块**不得** import `@/platform`、`@/lib/memory` 或任何 store。
 *
 * ## 段落的边界为什么是空行（D2-1）
 *
 * PRD 写的是「按 `##` 分块比较 `modified_at`」，但那是**理想的手写 Markdown**。
 * 本仓记忆正文绝大多数由 `MemoryService.append` 产出为 Markdown **引用块**：
 *
 * ```
 * > [2026-09-29T10:00:00.000Z] 来自「手动保存」
 * > <!-- SUMMARY:d41d8cd9 -->
 * > 正文
 * ```
 *
 * 按 `## ` 切会把它们整批漏掉。二者的共同边界是**空行**，且与既有
 * `parseEntryBodies` / `countEntries` 的口径一致——不另起一套切法，
 * 否则「记忆条数」与「段落数」会是两个数。
 */

import { hashContent } from '@/lib/workspaceKey';
// 归一化与正文提取的**实现**已搬到纯判据模块 `@/lib/memoryNormalize`：记忆 v2 的纯函数族
// （`memoryFact` / `memoryDistill` / `memoryPreference` / `memoryProject`）也要用它们，
// 那些模块按设计必须无依赖（NFR-M1 / NFR-M12）。这里转出，既有引用零改动。
//
// **必须 import 再 export**：`export { x } from '…'` 不会把 `x` 引进本模块作用域，
// 而下面的 `blockKey` 要直接调 `parseEntryBodies`。
import { normalizeForDedup, parseEntryBodies } from '@/lib/memoryNormalize';
export { normalizeForDedup, parseEntryBodies };

/** 一个记忆段落（原始文本保留，合并后按块整体搬运） */
export interface MemoryBlock {
  /** 段键（跨设备稳定，见 `blockKey`） */
  key: string;
  /** 段落时间戳（ISO）；无时间戳的段落为 `''`（视为最旧） */
  at: string;
  /** 段落原文（含引用符 / 标题 / 去重标记） */
  body: string;
}

/** 记忆的合并视图：段落集合 + 段级墓碑（`段键 → 删除时刻`） */
export interface MemorySnapshot {
  blocks: MemoryBlock[];
  tombstones: Record<string, string>;
}

/** 按空行切分段落（D2-1） */
export function splitBlocks(text: string): string[] {
  const src = (text ?? '').trim();
  if (src === '') return [];
  return src
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== '');
}

/**
 * 段落时间戳（D2-3）：块首 `> [ISO] 来自「…」` 里的 ISO。
 *
 * 取**第一个**命中的时间戳：引用块的时间行必在首行，手写块即便正文中出现
 * 形如日期的内容也不会先于标题行。
 */
export function blockAt(block: string): string {
  const m = (block ?? '').match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
  return m ? m[1] : '';
}

/**
 * 段键（D2-2）：跨设备必须算出**同一个值**，否则同一段会被当成两段、合并出重复。
 *
 * - 有 `<!-- SUMMARY:<hash> -->` 去重标记 → 直接用它。这是 `MemoryService.append`
 *   写入的标记，哈希是对**正文**算的（`hashContent(trimmed)`），故同内容跨设备同值；
 * - 手写块没有标记 → 对「剥离元信息行 + 归一化」后的正文算同一个哈希。
 *
 * 两类前缀不同（`s:` / `t:`）：标记哈希算的是未归一化的正文，归一化哈希算的是
 * 归一化后的正文，混进同一个命名空间会让「同一段」在两端得到不同的键。
 */
export function blockKey(block: string): string {
  const src = block ?? '';
  const marked = src.match(/<!--\s*SUMMARY:([^\s]+?)\s*-->/);
  if (marked && marked[1]) return `s:${marked[1]}`;
  const body = parseEntryBodies(src)[0] ?? '';
  return `t:${hashContent(normalizeForDedup(body))}`;
}

/** 时间戳转可比值；无法解析（含 `''`）视为 0（最旧） */
function atMs(at: string): number {
  const t = Date.parse(at ?? '');
  return Number.isFinite(t) ? t : 0;
}

/** 解析记忆正文为「段落集合」（墓碑为空，由调用方注入） */
export function parseMemory(text: string): MemorySnapshot {
  const byKey = new Map<string, MemoryBlock>();
  for (const body of splitBlocks(text)) {
    const key = blockKey(body);
    const at = blockAt(body);
    const prev = byKey.get(key);
    // 同键重复（用户手抄了同一条）→ 留时间戳较新的那份
    if (!prev || atMs(at) > atMs(prev.at)) byKey.set(key, { key, at, body });
  }
  return { blocks: Array.from(byKey.values()), tombstones: {} };
}

/** 渲染回记忆正文：按时间升序，块间空行分隔（与 `splitBlocks` 互为逆运算） */
export function renderMemory(snapshot: MemorySnapshot): string {
  const blocks = [...(snapshot?.blocks ?? [])].sort((a, b) => {
    const d = atMs(a.at) - atMs(b.at);
    return d !== 0 ? d : a.body < b.body ? -1 : a.body > b.body ? 1 : 0;
  });
  return blocks.map((b) => b.body).join('\n\n');
}

/**
 * 合并两份墓碑：同键取**时刻较大**者。
 *
 * 取大而不是取并集的全部：墓碑只在「比段更新」时才有效，留着旧的那个会让
 * 它在下一次与更旧的段比较时误判。
 */
export function mergeTombstones(
  a: Record<string, string>,
  b: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...(a ?? {}) };
  for (const [key, at] of Object.entries(b ?? {})) {
    const cur = out[key];
    if (cur === undefined || atMs(at) > atMs(cur)) out[key] = at;
  }
  return out;
}

/**
 * 段落级 LWW 合并（D2-4）：段级 2P-Set。
 *
 * ```
 * 对每个段键：在「本机段 / 对端段 / 墓碑」四者中取 at 最大者
 *   墓碑最大 → 丢弃该段
 *   段最大   → 保留该段
 *   平局     → 块优先于墓碑（「又写回来」胜过「删掉了」，见 §7 偏差 5）
 * ```
 *
 * **为什么必须有段级墓碑**：记忆页的编辑是**整份覆盖**、`clear()` 是整份清空。
 * 只做段并集的话，「删掉一条」与「清空」会在下次同步被对端的旧段**填回来**——
 * 那是功能回归（用户按了清空却还能看到旧记忆）。
 *
 * 幂等：`merge(a, b)` 与 `merge(b, a)` 结果相同，重复合并同一份不产生变化。
 */
export function mergeMemory(
  local: MemorySnapshot,
  remote: MemorySnapshot,
): MemorySnapshot {
  const tombs = mergeTombstones(local?.tombstones ?? {}, remote?.tombstones ?? {});

  const localBlocks = new Map<string, MemoryBlock>();
  for (const b of local?.blocks ?? []) localBlocks.set(b.key, b);
  const remoteBlocks = new Map<string, MemoryBlock>();
  for (const b of remote?.blocks ?? []) remoteBlocks.set(b.key, b);

  const keys = new Set<string>([
    ...localBlocks.keys(),
    ...remoteBlocks.keys(),
    ...Object.keys(tombs),
  ]);

  const kept: MemoryBlock[] = [];
  const nextTombs: Record<string, string> = {};

  for (const key of keys) {
    const lb = localBlocks.get(key);
    const rb = remoteBlocks.get(key);
    const tombAt = tombs[key];

    // 两端段内容相同（同键）时任取；不同则按 (at, body) 稳定挑一个
    const candidates = [lb, rb].filter((b): b is MemoryBlock => b !== undefined);
    if (candidates.length === 0) {
      // 两端都没有段：只可能是一份墓碑 → 保留（第三台设备也要知道它删过）
      if (tombAt !== undefined) nextTombs[key] = tombAt;
      continue;
    }
    const winner = candidates.reduce((best, cur) => {
      const d = atMs(cur.at) - atMs(best.at);
      if (d > 0) return cur;
      if (d < 0) return best;
      return cur.body < best.body ? cur : best;
    });

    if (tombAt === undefined) {
      kept.push(winner);
      continue;
    }
    // 墓碑严格更新才丢弃；平局保留块并**丢弃墓碑**（否则它会在下轮再次打平，
    // 而「删了又回来」比「留着一条旧的」更让人困惑）
    if (atMs(tombAt) > atMs(winner.at)) nextTombs[key] = tombAt;
    else kept.push(winner);
  }

  return { blocks: kept, tombstones: nextTombs };
}

/**
 * 求「被移除的段」→ 新增墓碑（D2-5）。
 *
 * 本机不记录「曾经有过哪些段」的历史，所以墓碑只能由 **diff** 得出：
 * 上一次已知的段键集合里、本次不在的那些，就是被删除的。调用方持久化
 * 「上次已知段键」即可（段键是短哈希，几百条也才 KB 级）。
 *
 * `at` 是本次删除时刻；对端合并时靠它与段时间戳比大小决定「删」还是「留」。
 */
export function diffRemovedKeys(
  prevKeys: readonly string[],
  nextKeys: readonly string[],
  at: string,
): Record<string, string> {
  const next = new Set(nextKeys ?? []);
  const out: Record<string, string> = {};
  for (const key of prevKeys ?? []) {
    if (key === '') continue;
    if (!next.has(key)) out[key] = at;
  }
  return out;
}

/** 便捷入口：两份**正文**直接合并（无墓碑；调用方自己管墓碑时用 `mergeMemory`） */
export function mergeMemoryText(localText: string, remoteText: string): string {
  return renderMemory(mergeMemory(parseMemory(localText), parseMemory(remoteText)));
}
