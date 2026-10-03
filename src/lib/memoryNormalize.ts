/**
 * 记忆正文的**归一化与条目切分**——纯判据模块，无任何依赖。
 *
 * ## 为什么从 `src/lib/memoryMerge.ts` 搬出来
 *
 * 这两个能力原先住在 `memoryMerge.ts`（那是**同步层**的段落级 LWW 实现，import 了
 * `@/lib/workspaceKey`）。记忆 v2 的纯函数族（`memoryFact` / `memoryDistill` /
 * `memoryPreference` / `memoryProject`）都要用它们，而那些模块按设计必须无依赖
 * （NFR-M1 / NFR-M12：可离线验证、确定性可复现）。
 *
 * 搬到本模块后 `memoryMerge.ts` 转出它们，既有引用零改动；依赖方向变成
 * 「同步层 → 纯判据」，符合分层。
 */

/**
 * 归一化文本，用于「这是不是同一句话的另一种写法」的**机械**比对。
 *
 * 只做无信息损失的三件事：去全部空白、去标点与 Markdown 装饰符、统一小写。
 * 不做同义词替换、不做语序调整、不做前缀词剥离——那三件事都需要理解语义，
 * 规则化去做必然误判（见 `src/lib/memory.ts` 的 `isSameStatement` 实测表）。
 *
 * 它同时是**事实去重与派生冲突域键**的输入，因此「同一句话换个标点」在 v2 里
 * 不仅被去重挡住，还会落进同一个 `d:` 冲突域——两处收益同源。
 */
export function normalizeForDedup(text: string): string {
  return (text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(
      /[。，、；：！？""''「」『』（）【】《》〈〉…—·,.!?;:'"()<>[\]{}/\\|~`@#$%^&*+=_-]/g,
      '',
    )
    .toLowerCase();
}

/**
 * 记忆全文里各条目的**正文**（引用块格式与手写 Markdown 都支持）。
 *
 * 元信息行不进正文：去重标记 `<!-- SUMMARY:… -->`、`> [ISO] 来自「…」`、Markdown 标题。
 */
export function parseEntryBodies(text: string): string[] {
  const src = (text ?? '').trim();
  if (src === '') return [];

  // 条目之间以空行分隔；引用块自身是单段，手写 Markdown 的 `## ` 段同理。
  const blocks = src
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== '');

  const bodies: string[] = [];
  for (const block of blocks) {
    const kept: string[] = [];
    for (const raw of block.split('\n')) {
      // 元信息行不进正文：去重标记、`[时间] 来自「来源」`、Markdown 标题
      if (/^>\s*<!--\s*SUMMARY:/.test(raw)) continue;
      if (/^>\s*\[\d{4}-\d{2}-\d{2}T/.test(raw)) continue;
      if (/^#{1,6}\s+/.test(raw)) continue;
      kept.push(raw.replace(/^>\s?/, ''));
    }
    const body = kept.join('\n').trim();
    if (body !== '') bodies.push(body);
  }
  return bodies;
}

/** 单条记忆块的时间戳（块首 `> [ISO] 来自「…」`），无则空串 */
export function blockAtOf(block: string): string {
  const m = (block ?? '').match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
  return m ? m[1] : '';
}

/** 按空行切分段落 */
export function splitMemoryBlocks(text: string): string[] {
  const src = (text ?? '').trim();
  if (src === '') return [];
  return src
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== '');
}

/**
 * 排序比较：**一律用 `<`，禁用 `localeCompare`**。
 *
 * 中文环境下 `localeCompare` 按读音排序，会让同一份输入在不同 locale 下得到不同的
 * canonical 结果——而 v2 的跨设备收敛依赖「同一份证据 → 逐字节相同的 JSON」
 * （设计 §4.3.1 / NFR-M12）。既有的 `sortMemoryFileNames` 出于同样的理由用了 `<`。
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 按 `compareStrings` 排序并去重（返回新数组，不改入参） */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}
