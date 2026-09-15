/**
 * Composer 输入框触发符（`/` 与 `@`）的判定逻辑。
 *
 * 单独成模块的原因：这是一段**纯函数**（无 React / DOM / store 依赖），
 * 抽出来既能让 Composer 瘦身，也能直接写表驱动单测，
 * 不必为了测它而把整棵 React + MUI 依赖树拉进测试环境。
 */

/**
 * 输入区触发器状态：记录 `/` 或 `@` 出现的位置与已键入的过滤词。
 * index 为触发符在文本中的下标，选中候选项时需连同过滤词一起替换掉。
 */
export interface TriggerState {
  type: 'slash' | 'at';
  index: number;
  query: string;
}

/** 触发符后允许的最大过滤词长度（超出视为普通文本，不再弹浮层） */
export const MAX_QUERY_LENGTH = 40;

/** 词内字符：`@` 紧跟在这类字符后面时不触发（邮箱 / 变量名场景） */
const WORD_CHAR = /[A-Za-z0-9_]/;

/** 空白字符（`\n` / `\r` / 空格 / 制表符） */
function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

/**
 * 从光标位置向前扫描，判定当前是否处于 `/` 或 `@` 触发态。
 *
 * 两个触发符的边界刻意「一严一松」：
 *
 * - `/` 只在**行首**或**空白/换行之后**触发。斜杠在 URL（`https://…`）、
 *   文件路径（`src/app.ts`）、以及 `and/or` 里都是常规字符，只要放宽到
 *   「标点后也算」就会被误判——输入到 `https://e` 时过滤词 `e` 会命中
 *   内置指令 `/clear`，浮层直接弹出挡住输入。
 * - `@` 只要前一个字符**不是字母/数字/下划线**即可触发。中文语境下
 *   「看一下@报表」是高频写法，收紧成只认空白会直接废掉这个入口；
 *   而邮箱 `a@b.com` 因前一个是字母，仍被这条规则挡住。
 *
 * 另外两条通用规则：
 * 1. 扫描途中遇到空白立即放弃——触发词里出现空格/换行说明已不是一次触发；
 * 2. 过滤词超过 MAX_QUERY_LENGTH 同样放弃，避免长串文本被误当过滤词。
 *
 * 注意：某个触发符因边界不合格被跳过时是 `continue`（继续向前找更早的触发符），
 * 而不是直接 return null——这样「and/or /clear」这类输入仍能命中后半段。
 *
 * @param value 输入框当前文本
 * @param caret 光标位置（字符下标）
 */
export function detectTrigger(value: string, caret: number): TriggerState | null {
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = value[i];
    if (isSpace(ch)) return null;
    if (ch !== '/' && ch !== '@') continue;

    const prev = i > 0 ? value[i - 1] : '';
    if (ch === '/') {
      // 行首，或紧跟在空白之后才算触发；URL 里的第二个斜杠、路径、and/or 一律跳过
      if (prev !== '' && !isSpace(prev)) continue;
    } else if (prev !== '' && WORD_CHAR.test(prev)) {
      // 邮箱 / 变量名里的 @ 不触发
      continue;
    }

    const query = value.slice(i + 1, caret);
    if (query.length > MAX_QUERY_LENGTH) return null;
    return { type: ch === '/' ? 'slash' : 'at', index: i, query };
  }
  return null;
}
