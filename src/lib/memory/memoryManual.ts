/**
 * 「用户手编的 `MEMORY.md` 也算权威」——把**人写进投影的内容**接回正式链路。
 *
 * 需求：用户明确要求「用户也可以手编 MEMORY.md 算权威」；设计：`docs/architecture-memory-v2.md` §12 问题 1。
 *
 * ## 为什么不能只把它留在文件里
 *
 * v2 的 `MEMORY.md` 是**派生投影**：`distill` 之后由 canonical（`curated.json`）重建。
 * 如果用户在文件视图里手工加了一段「本项目不要用 ORM」，而那段内容只存在于文件里，
 * 那么下一次蒸馏重建投影时它就被**吃掉**了——用户会看到自己写的规则凭空消失，
 * 而这件事完全静默（没有任何报错）。
 *
 * 所以手编内容必须变成**事实**（`origin: 'manual'`）进入 canonical，于是：
 * - 它参与蒸馏与冲突检测（内容性质决定落哪一层）；
 * - 它在下一次重建投影时被**重新渲染出来**，不会被吃掉；
 * - 它与模型写的内容享有同一套去重与冲突规则（不再有「用户写的是另一种东西」）。
 *
 * ## 怎么判断「哪些是新手编的」
 *
 * 拿**保存后的正文**与**canonical 里已有的结论**比：段落正文归一化后不在 canonical 里的，
 * 就是这次新增的（或用户改写过措辞的）。这条判据刻意保守：
 *
 * - 不去 diff「上一版文件」——那是投影，投影会因为蒸馏而变，拿它当基准会把蒸馏结果
 *   误判成用户新增；
 * - 不在 canonical 里 = 还没被正式登记，正是要补的那部分。
 */

import type { CuratedEntry, MemoryFact } from '@/types';
import { parseEntryBodies, normalizeForDedup } from '@/lib/memory/memoryNormalize';

/** 切分辅助：判断一个原始块是不是引用块（`parseEntryBodies` 会剥掉 `> `，故必须先判） */
function isQuoteBlock(rawBlock: string): boolean {
  const lines = (rawBlock ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return false;
  return lines.every((l) => l.startsWith('>'));
}

/** 手编段落默认的 kind：用户写进记忆的多是「约定 / 规则」 */
export const MANUAL_FACT_KIND = 'convention' as const;

/**
 * 手编段落默认的重要度。
 *
 * 取 4（达到 `minImportance`）是刻意的：用户**明确写下来**的东西不该再等「重复出现 2 次」
 * 才够格晋升——那是给模型自动沉淀设的门槛。
 *
 * 它同时也**豁免 `retentionDays` 年龄门槛**（见 `memory/memoryDistill.ts` 的 `isAgeExempt`）。
 * 早先的实现不豁免，结果是「点保存 → 内容当场从文件里消失，要等满 30 天蒸馏才会重新
 * 渲回来」，而 toast 还在说「已登记为长期记忆」——用户看到的是自己写的东西被静默吃掉，
 * 与本文文件头的目标（手编不被重建吃掉）直接冲突。年龄门槛是给模型自动沉淀降噪的，
 * 用户手打的输入已经过了「用户确认要记住」这道门。
 */
export const MANUAL_FACT_IMPORTANCE = 4;

/**
 * 引用块里的**装饰性说明**（v2 会写进投影的那些），不该被当成用户的结论。
 *
 * `parseEntryBodies` 会剥掉 `> ` 前缀，所以拿到手的正文看不出它原本是引用块——
 * 必须在**切分之前**标记，否则「（以下内容已过期…）」这类说明会被登记成一条长期记忆。
 *
 * 判据是「前缀白名单」而不是「含『已过期』就丢」：用户完全可能手写一条
 * 「XX 方案已过期，改用 YY」的真实结论。只排除那些**结构上属于模板**的开头。
 */
const INJECTION_ARTIFACT_PREFIXES = [
  '（以下偏好已过期',
  '(以下偏好已过期',
  '（以下内容已过期',
  '(以下内容已过期',
];

function isInjectionArtifactBody(body: string): boolean {
  const text = (body ?? '').trim();
  return INJECTION_ARTIFACT_PREFIXES.some((p) => text.startsWith(p));
}

/**
 * 手编段落是否有资格成为事实。
 *
 * 排除四类**不该进记忆**的投影内容：
 * - Markdown 标题（`# 这个项目的长期记忆` 这类模板占位语，不是用户的结论）；
 * - 引用块（`> …`）：v1 的时间戳出处行与 v2 的过期说明都写在引用块里；
 * - 空段与纯装饰（`---`）；
 * - 段落过大（超过 2000 字会被 `createMemoryFact` 拒绝，这里先过滤，
 *   免得用户粘了一大段文档进来导致整次保存报错）。
 */
export function isEligibleManualParagraph(text: string): boolean {
  const body = (text ?? '').trim();
  if (body === '') return false;
  if (body.length > 2000) return false;
  if (/^#{1,6}\s/.test(body)) return false;
  if (/^[-*_]{3,}$/.test(body)) return false;
  return !isInjectionArtifactBody(body);
}

/**
 * 从「保存后的正文」里挑出**还没进 canonical** 的手编段落。
 *
 * @param savedText 用户刚保存的文件正文
 * @param knownEntries canonical 里现有的全部修订（含 superseded / disabled）
 * @returns 需要补登记为 `origin: 'manual'` 事实的段落（按出现顺序，已去重）
 */
export function extractNewManualParagraphs(
  savedText: string,
  knownEntries: readonly CuratedEntry[],
): string[] {
  const known = new Set(
    (knownEntries ?? [])
      .filter((e) => typeof e.content === 'string')
      .map((e) => normalizeForDedup(e.content)),
  );
  const seen = new Set<string>();
  const out: string[] = [];

  // 按**原始块**切分：`parseEntryBodies` 会剥掉 `> ` 前缀，剥完就分不出引用块了，
  // 而引用块里装的是时间戳出处与「已过期」说明，都不是用户的结论。
  for (const rawBlock of (savedText ?? '').split(/\n\s*\n/)) {
    if (isQuoteBlock(rawBlock)) continue;
    for (const body of parseEntryBodies(rawBlock)) {
      if (!isEligibleManualParagraph(body)) continue;
      const key = normalizeForDedup(body);
      if (key === '' || seen.has(key) || known.has(key)) continue;
      seen.add(key);
      // 单行化：长期记忆里的段落按空行切分，一个含空行的段落会在下一次解析时
      // 被拆成两条——那是同一句话凭空变两条。
      out.push(body.replace(/\n{2,}/g, '\n').trim());
    }
  }
  return out;
}

/**
 * 由手编段落构造事实输入（交给 `MemoryStore.appendFact`）。
 *
 * `memoryKey` **刻意不设**：手编时用户面对的是正文，不是冲突域键；替他猜一个键
 * （比如按首行生成）会在下一次手编改写措辞时变成另一个域，于是新旧两条并存——
 * 那正是 v1 的重复问题。没有显式键就落 `d:` 派生域，行为可预期。
 */
export function manualParagraphToFactInput(
  paragraph: string,
  workspaceId: string,
  observedAt: string,
): {
  workspaceId: string;
  kind: typeof MANUAL_FACT_KIND;
  content: string;
  importance: number;
  origin: 'manual';
  source: 'user';
  evidence: string;
  observedAt: string;
} {
  return {
    workspaceId,
    kind: MANUAL_FACT_KIND,
    content: paragraph,
    importance: MANUAL_FACT_IMPORTANCE,
    origin: 'manual',
    source: 'user',
    // 证据指向「来源是记忆页的手工编辑」，便于日后回答「这条为什么在记忆里」
    evidence: 'memory-page:manual-edit',
    observedAt,
  };
}

/** 手编段落 → 事实（供测试与调用方做纯逻辑断言时用） */
export function manualParagraphToFact(
  paragraph: string,
  workspaceId: string,
  observedAt: string,
): Pick<MemoryFact, 'workspaceId' | 'kind' | 'content' | 'importance' | 'origin' | 'observedAt'> {
  const input = manualParagraphToFactInput(paragraph, workspaceId, observedAt);
  return {
    workspaceId: input.workspaceId,
    kind: input.kind,
    content: input.content,
    importance: input.importance,
    origin: input.origin,
    observedAt: input.observedAt,
  };
}
