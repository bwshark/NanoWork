import type { MemoryDirective, MemoryScope } from '@/types';

/**
 * Agent 侧**受控**记忆写入协议。
 *
 * ## 为什么是「协议」而不是给 Agent 一个写文件工具
 *
 * 客户端有两套记忆落点：`~/.nanowork/MEMORY.md`（用户级）与
 * `~/.nanowork/memory/<key>.md`（工作区级）。给模型一个通用的 `write_file`
 * 就等于把这两个文件的路径、格式、去重标记全部交给它自己维护——它会在里面写标题、
 * 分点、甚至覆盖掉用户手写的段落，而这些都是**静默**的（用户不会去翻那个目录）。
 *
 * 改成协议后，模型只表达**意图**（「这条该记住」+ 该记在哪一层），落盘由
 * `MemoryService.append` 统一负责：带时间戳、带来源、带幂等去重标记，永不覆盖原文。
 *
 * ## 为什么不用工具调用
 *
 * 工具调用要过审批门（`tool_approval` 轴），而「记一条偏好」是纯本地、无副作用
 * 的写入，弹审批框只教会用户一件事——把审批全关掉。协议走正文，不占工具位。
 *
 * ## 形态
 *
 * ```
 * <memory-save scope="user">用户的名字是明明</memory-save>
 * ```
 *
 * - `scope` 省略时按 `workspace`（更保守：范围更小，串味代价更低）。
 * - 正文里可以出现多个块，逐个落盘。
 * - **块本身不出现在用户可见的回答里**（`stripMemoryDirectives` 剥离），
 *   否则每轮回答末尾都会挂一段奇怪的标签。
 */

/** 开标签前缀（用于提示词模板与解析共用，避免两处字面量漂移） */
export const MEMORY_SAVE_TAG = 'memory-save';

/** 匹配一个完整的 `<memory-save …>…</memory-save>` 块（大小写不敏感） */
const DIRECTIVE_RE = new RegExp(
  `<${MEMORY_SAVE_TAG}\\b([^>]*)>([\\s\\S]*?)</${MEMORY_SAVE_TAG}>`,
  'gi',
);

/** 未闭合的开标签：流式被截断 / 模型忘了收尾 */
const UNCLOSED_RE = new RegExp(`<${MEMORY_SAVE_TAG}\\b[^>]*>[\\s\\S]*$`, 'i');

/** 从属性串里取 `scope="user|workspace"`，未知取值收敛为 workspace（fail-closed） */
function parseScope(attrs: string): MemoryScope {
  const m = /scope\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs ?? '');
  const raw = (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim().toLowerCase();
  // 拼错的取值不猜「用户级」：跨项目写入的代价远大于少写一条
  return raw === 'user' ? 'user' : 'workspace';
}

/**
 * 解析正文里的记忆指令块（按出现顺序）。没有块时返回空数组。
 *
 * `scope="user"` 的语义边界：**只有用户明确要求「记住我……」时才该用它**。
 * 这条约束写在提示词里（`MEMORY_WRITE_INSTRUCTION`），解析层不做二次判断——
 * 解析层无法区分「用户刚刚明确要求」与「模型自作主张」，硬猜只会把合法写入也拦掉。
 */
export function parseMemoryDirectives(text: string): MemoryDirective[] {
  const src = text ?? '';
  if (!src.includes(`<${MEMORY_SAVE_TAG}`)) return [];

  const result: MemoryDirective[] = [];
  DIRECTIVE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIRECTIVE_RE.exec(src)) !== null) {
    const content = (m[2] ?? '').trim();
    if (content === '') continue;
    result.push({ scope: parseScope(m[1] ?? ''), content });
  }
  return result;
}

/**
 * 剥离记忆指令块，返回用户可见正文。
 *
 * 两件事一起做：
 * 1. 删除成对的块；
 * 2. 删除**未闭合**的开标签及其后的全部内容——宁可少显示半句话，也不能把
 *    `</memory-save>` 这种协议标记漏到界面上。未闭合块**不落盘**（内容不可信）。
 *
 * 去掉块后顺手清掉它留下的空行，避免回答末尾挂着一段莫名空白。
 */
export function stripMemoryDirectives(text: string): string {
  const src = text ?? '';
  if (!src.includes(`<${MEMORY_SAVE_TAG}`)) return src;

  let out = src.replace(DIRECTIVE_RE, '');
  // 未闭合块：连同其后内容一起丢弃（模型中途停了，语义不完整）
  out = out.replace(UNCLOSED_RE, '');
  // 折叠被删块留下的连续空行（只折叠 3+ 个换行，不破坏正文里刻意留的空行）
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.replace(/\s+$/, '');
}

/**
 * 注入给模型的协议说明（system 段的 `memory-write` 槽位）。
 *
 * 与「记忆块注入」同开同关（`memoryEnabled && autoSummarize`）：只看不写的能力
 * 只会让模型反复追问「要我记住吗」，不如两边一致。
 */
export const MEMORY_WRITE_INSTRUCTION = [
  '你可以在回答中**主动**把值得长期保留的事实写入记忆，写法是把一行块放在回答末尾：',
  '',
  `<${MEMORY_SAVE_TAG} scope="workspace">这条要记住的内容</${MEMORY_SAVE_TAG}>`,
  '',
  '规则：',
  '- `scope="user"` 记**跨项目**都成立的事实：用户的称呼/姓名、职业与专业背景、稳定的偏好与习惯。',
  '  **只有用户明确要求（「记住我叫…」「以后都按…来」）时才用这一档**，不要凭猜测写。',
  '- `scope="workspace"`（默认）记只对当前项目/工作目录有效的结论、约定与待办。',
  '- 每条只写一句陈述句，不要写「用户说」「我记住了」这类转述，也不要加标题或分点。',
  '- 没有值得长期保留的信息时**不要**输出这个块。它是可选动作，不必每轮都写。',
  '- 你不需要（也没有权限）直接读写记忆文件；写出块之后由客户端完成落盘。',
].join('\n');
