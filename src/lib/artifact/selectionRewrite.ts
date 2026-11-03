/**
 * FR-7.5 人机双写：**圈选局部让 AI 改写**的纯逻辑层。
 *
 * ## 这一层解决什么
 *
 * 产物面板里用户圈住一段正文 → 说一句「改成 XX」→ 模型只回**那一段的新文本**
 * → 用它替换原文的同一段 → 产物升一版（FR-7.4 版本链）。
 *
 * 全程有四个容易做错的地方，都在这里用纯函数钉住：
 *
 * 1. **选区偏移**：浏览器给的是 `selectionStart` / `selectionEnd`，而替换要动的是
 *    同一份 `content`。中间任何一次「先 trim 再算偏移」都会错位——所以本模块只
 *    接受原文与偏移，绝不 trim 原文。
 * 2. **模型爱包壳**：它会把结果塞进 ``` 围栏、前面加「好的，改写如下：」。
 *    原样替换进去，产物正文就多了一堆不属于它的东西。`extractRewriteResult`
 *    负责剥壳，但**只在整段输出恰好是一层围栏时**剥——正文里本来就有代码块时
 *    不能连内容一起吃掉。
 * 3. **替换后偏移变化**：新文本可能比原选区短或长，但只有「被替换的那一段」变，
 *    前后文不动。`applyRewrite` 因此只做一次 `slice + slice` 拼接。
 * 4. **空改写**：模型返回空串 / 只有空白 → 必须判失败，不能把选区删掉。
 *    一个「沉默的删除」是最难事后追责的形态（内容没了，日志里还写着成功）。
 *
 * ## 为什么提示词要带「只回改写后的文本」
 *
 * 不带的话模型会顺手解释、加标题、把整篇重写一遍。而这里只需要**一段替换文本**：
 * 让它自由发挥，替换进去就是把产物改坏。提示词里同时给了「保持原语言 / 原缩进」
 * 与「不要解释」，因为这两条漏一条，输出就得再洗一次。
 */

/** 一次选区（`start` / `end` 是原文里的字符偏移，左闭右开） */
export interface TextSelection {
  start: number;
  end: number;
}

/** 选区是否可用（非空、有序、落在正文内） */
export function isValidSelection(selection: TextSelection | null, contentLength: number): boolean {
  if (!selection) return false;
  const { start, end } = selection;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start >= end) return false;
  if (start < 0 || end > contentLength) return false;
  return true;
}

/**
 * 把任意一对偏移归一成合法选区。
 *
 * 浏览器里反向拖选会给出 `start > end`（`anchorOffset` / `focusOffset` 的原始形态），
 * 而 `<textarea>` 的 `selectionStart/End` 永远是排序好的。两种来源都要接，
 * 因此这里统一 swap 一次。**越界一律返回 null**：越界说明调用方算错了偏移，
 * 悄悄夹到边界只会让改写落到错误的段落。
 */
export function normalizeSelection(start: number, end: number, contentLength: number): TextSelection | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  let a = Math.trunc(start);
  let b = Math.trunc(end);
  if (a > b) [a, b] = [b, a];
  if (a < 0 || b > contentLength || a === b) return null;
  return { start: a, end: b };
}

/** 取选区覆盖的原文（越界返回空串，调用方可据此判「选区失效」） */
export function selectedText(content: string, selection: TextSelection | null): string {
  if (!isValidSelection(selection, content.length) || selection === null) return '';
  return content.slice(selection.start, selection.end);
}

/** 改写请求的上下文（供提示词构造与结果清洗） */
export interface RewriteContext {
  /** 用户这次的改写意图（「改成过去时」「缩短一半」「改成英文」…） */
  instruction: string;
  /** 产物标题 / 文件名，让模型知道自己在改什么 */
  title?: string;
  /** 正文的语言标记（code 产物的高亮语言），用于提示保持缩进风格 */
  language?: string;
}

/**
 * 构造改写用的 system 提示词。
 *
 * 三条硬约束写在最前面，因为模型对**开头**的服从度最高：
 * 只回改写后的那一段 / 不要解释 / 保持缩进与语言。
 */
export function buildRewriteSystemPrompt(ctx: RewriteContext): string {
  const lang = (ctx.language ?? '').trim();
  const kind = lang ? `这是一段 ${lang} 内容。` : '';
  return [
    '你是一个文本改写引擎。用户会给你一段被选中的文本和一句改写要求，',
    '你只输出**改写后的那一段文本本身**。',
    '',
    '硬性要求：',
    '1. 不要输出任何解释、前后缀、标题、Markdown 围栏（```）；',
    '2. 不要改动未被选中的上下文，只重写给你的这一段；',
    '3. 保持原有的缩进风格、换行习惯与语言（除非用户明确要求翻译）；',
    '4. 若这段是代码，只改用户要求的部分，不要顺手重构其余逻辑。',
    kind ? `\n${kind}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * 构造改写用的 user 消息：选区原文 + 意图。
 *
 * 用明确的标记包住原文（`<selected>`），而不是靠「下面这段是原文」这类自然语言——
 * 后者在正文本身含类似措辞时会歧义，模型分不清哪部分是待改内容。
 */
export function buildRewriteUserPrompt(content: string, selection: TextSelection | null, ctx: RewriteContext): string {
  const segment = selectedText(content, selection);
  const head = ctx.title?.trim() ? `文件：${ctx.title.trim()}\n` : '';
  return [
    head + '改写要求：' + ctx.instruction.trim(),
    '',
    '<selected>',
    segment,
    '</selected>',
  ].join('\n');
}

/**
 * 去掉首尾**空行**与行尾空白，但**保留首行的缩进**。
 *
 * ⛔ 这里不能用 `String.prototype.trim()`：代码产物里缩进是语义的一部分。
 * `trim()` 会把选区首行的 4 个空格吃掉，于是「把缩进去掉」这种改写被误判成
 * 「没有变化」而拒绝；反过来替换时又会把模型给的缩进抹平，插进去就是一段错位的代码。
 *
 * 所以只做三件事：① 丢掉开头的空白行；② 丢掉结尾的空白行；③ 去掉末尾的行尾空白。
 * 首行前导空格原样保留。
 */
function trimBlankEdges(text: string): string {
  const lines = text.split('\n');
  let from = 0;
  let to = lines.length;
  while (from < to && lines[from].trim() === '') from += 1;
  while (to > from && lines[to - 1].trim() === '') to -= 1;
  if (from >= to) return '';
  // 只裁整段的末尾（末行已确认为非空白行，可能带行尾空格）
  return lines.slice(from, to).join('\n').replace(/\s+$/, '');
}

/**
 * 从模型输出里取出「改写后的文本」。
 *
 * 处理三类常见包壳（按优先级）：
 * 1. 整体被一层 ``` 围栏包住（可带语言标记）→ 只取围栏内；
 * 2. 前面有一段「好的，改写如下：」这类引导语 → 从第一个换行后的内容起算；
 * 3. 首尾多余空行 → 去掉（但**保留**首行缩进与内部换行，见 `trimBlankEdges`）。
 *
 * ⛔ **只在整段输出恰好是一层围栏时才剥**。若正文内部本来就有代码块
 * （改写结果是一整段带 ``` 的 Markdown），按「第一个 ``` 到最后一个 ```」去取
 * 会把正文前后的内容吃掉。判据是「围栏必须从第一行开始、到最后一行为止」。
 */
export function extractRewriteResult(raw: string): string {
  const text = (raw ?? '').replace(/\r\n/g, '\n');
  if (text.trim() === '') return '';

  const fenced = matchWholeFence(text);
  if (fenced !== null) return trimBlankEdges(fenced);

  // 引导语：首行以冒号结尾且很短（「好的，改写如下：」），其后才是正文
  const lines = text.split('\n');
  if (lines.length > 1) {
    const first = lines[0].trim();
    if (first.length <= 40 && /[:：]$/.test(first)) {
      return trimBlankEdges(lines.slice(1).join('\n'));
    }
  }

  return trimBlankEdges(text);
}

/**
 * 整段是否恰好是一层围栏；是则返回围栏内文本，否则 null。
 *
 * 「恰好」的定义：第一行是 ```（可带语言），最后一行也是 ```，且中间不出现
 * 与开头同级的收尾 ``` —— 出现多个围栏说明正文自带代码块，不是包壳。
 */
function matchWholeFence(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return null;
  const lines = trimmed.split('\n');
  if (lines.length < 2) return null;
  const opening = lines[0];
  if (!/^```[a-zA-Z0-9_+-]*\s*$/.test(opening.trim())) return null;
  if (lines[lines.length - 1].trim() !== '```') return null;
  const body = lines.slice(1, -1).join('\n');
  // 正文里还有围栏 → 说明这不是单纯包壳，交给调用方原样处理
  if (body.includes('```')) return null;
  return body;
}

/** 一次改写的结果（成功时才带 `content`） */
export type RewriteOutcome =
  | { ok: true; content: string }
  | { ok: false; reason: string };

/**
 * 把改写结果拼回正文。
 *
 * 只替换选区那一段，前后文一字不动。**失败一律不改正文**——返回 `ok: false`
 * 让调用方去提示，而不是返回一个「差不多」的字符串。
 *
 * 三种拒绝：
 * - 选区失效（正文在等待期间被换掉了：版本回退 / 切了产物）；
 * - 改写结果为空（模型什么都没给，或给了纯空白）；
 * - 改写结果与原文完全相同（模型没做任何改动，升一版只会污染版本链）。
 *
 * ⚠️ 比较与拼接都用 `trimBlankEdges` 而不是 `trim()`：后者会抹平首行缩进，
 * 既会把「只改了缩进」判成没变化，也会在替换时把缩进吃掉。
 */
export function applyRewrite(
  content: string,
  selection: TextSelection | null,
  rewritten: string,
): RewriteOutcome {
  if (!isValidSelection(selection, content.length) || selection === null) {
    return { ok: false, reason: '选区已失效（正文可能已切换），请重新圈选' };
  }
  const next = trimBlankEdges((rewritten ?? '').replace(/\r\n/g, '\n'));
  if (next === '') return { ok: false, reason: '模型没有返回改写结果' };

  const original = content.slice(selection.start, selection.end);
  // 逐字比较：`trimBlankEdges` 只去首尾空行，段首缩进仍参与比较 —— 缩进变了
  // 就是真的变了（代码产物里缩进是语义）
  if (next === original) {
    return { ok: false, reason: '改写结果与原文相同，未产生变更' };
  }

  const merged = content.slice(0, selection.start) + next + content.slice(selection.end);
  return { ok: true, content: merged };
}

/**
 * 改写后的选区（供界面把光标/高亮落在新文本上）。
 *
 * 新文本长度可能变了，但**起点不变**：前文没有动过。
 */
export function rewrittenSelection(selection: TextSelection, rewritten: string): TextSelection {
  const start = selection.start;
  return { start, end: start + trimBlankEdges(rewritten).length };
}
