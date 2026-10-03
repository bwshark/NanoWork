/**
 * v1 数据的**只读投影**：把 Markdown 段落变成 `legacy` 事实，并且**继续参与注入**。
 *
 * 需求：`docs/prd-memory-v2.md` FR-M3；设计：`docs/architecture-memory-v2.md` §4.6。
 *
 * ## 这个模块存在的理由（一条必须记住的教训）
 *
 * v1 的注入正文来自「目录下全部 Markdown 的合并」。v2 的注入集合换成了「active 修订 +
 * 最近事实」，于是 v1 的内容会**一个字都不再进 prompt**——用户升级后发现「它以前记得的
 * 事现在不记得了」，而 9 个 v1 测试全绿也发现不了（它们测的是 `MemoryService`，而链路
 * 上游换了集合）。
 *
 * 所以 legacy 内容必须有一条明确的位置：**工作区级/用户级段落的末尾、最低优先级**，
 * 与最近事实共享预算。可执行判据（`tests/memory/injection.test.ts`）：
 * 同一份 v1 目录，在预算足够大时 `loadForInjection().entries` 升级前后**不减少**。
 *
 * ## 三条刻意的规则
 *
 * 1. **不改写原文**：legacy 投影只读，不写回 `.md`。用户手写的内容永远是他的。
 * 2. **不参与自动晋升**：legacy 事实的 `kind` 取 `convention` 但**不进**候选——它们已经
 *    在 long-term 里了，再晋升一次只会把「过程记录」误当「稳定结论」。
 * 3. **参与冲突检测/展示**：它们是既有资产的真实内容，忽略会漏掉真冲突。
 */

import type { FactKind, MemoryFact } from '@/types';
import { CURATED_MEMORY_FILE } from '@/lib/memoryPaths';
import {
  dailyMemoryFileName,
  isDailyMemoryFileName,
  isMemoryFileName,
  mergeMemoryFiles,
} from '@/lib/workspaceMemory';
import { compareStrings, parseEntryBodies } from '@/lib/memoryNormalize';
import { normalizeForDedup } from '@/lib/memoryNormalize';
import { hashContent } from '@/lib/workspaceKey';
import { entryKeyForFact } from '@/lib/memoryFact';

/** legacy 事实的默认 kind（它们已经生效，故按「约定」归类） */
const LEGACY_KIND: FactKind = 'convention';

/** legacy 事实的默认重要度：低于门槛**且**不在 `promotableKinds` 之外，
 *  但它由 `origin: 'legacy'` 明确排除在晋升之外，这个值只用于展示排序。 */
const LEGACY_IMPORTANCE = 3;

/** 一条 legacy 条目的展示形态 */
export interface LegacyEntry {
  /** 稳定 id：`lf_<hash>`（不参与 canonical，只在展示与去重时用） */
  legacyId: string;
  /** 来源文件（`MEMORY.md` / `2026-09-19.md` / 用户手写的 `notes.md`） */
  file: string;
  content: string;
  /** 块首时间戳（若有） */
  at: string | null;
}

/**
 * 从记忆文件集合里取出 legacy 条目。
 *
 * 只取**正文**（`parseEntryBodies` 会剥掉 `> [ISO] 来自「…」` 与去重标记），
 * 因为注入只需要内容；出处由 `file` 字段承担。
 */
export function collectLegacyEntries(
  files: ReadonlyArray<{ name: string; content: string }>,
): LegacyEntry[] {
  const out: LegacyEntry[] = [];
  const seen = new Set<string>();
  for (const file of files ?? []) {
    if (!isMemoryFileName(file.name)) continue;
    for (const body of parseEntryBodies(file.content ?? '')) {
      const key = normalizeForDedup(body);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      out.push({
        legacyId: `lf_${hashContent(`${file.name}\u0000${key}`)}`,
        file: file.name,
        content: body,
        at: firstTimestampOf(body),
      });
    }
  }
  // 顺序：`MEMORY.md` 在前（v1 的排序约定），其余按文件名升序
  return out.sort((a, b) => {
    const rank = (f: string): number =>
      f === CURATED_MEMORY_FILE ? 0 : isDailyMemoryFileName(f) ? 1 : 2;
    if (rank(a.file) !== rank(b.file)) return rank(a.file) - rank(b.file);
    const byFile = compareStrings(a.file, b.file);
    return byFile !== 0 ? byFile : compareStrings(a.content, b.content);
  });
}

/** 从正文里找第一个 ISO 时间戳（引用块的元信息行已被剥掉，故这里多半为空） */
function firstTimestampOf(body: string): string | null {
  const m = (body ?? '').match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/);
  return m ? m[1] : null;
}

/**
 * 把 legacy 条目投影成**只读事实**。
 *
 * 用途只有两个：记忆页的展示、冲突检测的输入。**不要**把它们交给 `distillFacts`
 * 的候选集合（`origin` 明确标记为 `legacy`，蒸馏侧按 `origin` 过滤）。
 */
export function legacyFactsOf(
  entries: readonly LegacyEntry[],
  workspaceId: string,
  now: Date,
): MemoryFact[] {
  return (entries ?? []).map((entry) => {
    const observedAt = entry.at && Number.isFinite(Date.parse(entry.at))
      ? new Date(Date.parse(entry.at)).toISOString()
      : new Date(0).toISOString();
    const base: MemoryFact = {
      factId: entry.legacyId,
      workspaceId,
      kind: LEGACY_KIND,
      content: entry.content,
      importance: LEGACY_IMPORTANCE,
      source: 'user',
      origin: 'legacy',
      evidence: entry.file,
      observedAt,
      schema: 2,
    };
    return base;
  });
}

/** legacy 域的冲突域键（`l:` 命名空间：与显式 key、派生 key **永不互相替代**） */
export function legacyEntryKey(fact: Pick<MemoryFact, 'kind' | 'content' | 'memoryKey'>): string {
  return entryKeyForFact(fact);
}

/** 稳定的空时间（legacy 条目没有可信时间时用它，排序时会排到最前） */
export const LEGACY_EPOCH = new Date(0).toISOString();

/** 本地日期的 legacy 文件名（供 UI 提示「今天的日志」用；v2 不再新写它） */
export function todayLegacyFileName(now: Date = new Date()): string {
  return dailyMemoryFileName(now);
}

/** 把一组文件合并成 legacy 注入正文（与 v1 的 `mergeMemoryFiles` 同口径） */
export function legacyInjectionText(
  files: ReadonlyArray<{ name: string; content: string }>,
): string {
  return mergeMemoryFiles(files);
}
