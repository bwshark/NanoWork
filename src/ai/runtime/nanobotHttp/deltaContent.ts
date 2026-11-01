/**
 * 一帧 `delta.content` → 纯文本。
 *
 * ## 为什么不能直接 `fullText += delta.content`
 *
 * OpenAI 规范里 `content` 是 string，但**真实提供方并不统一**：走代理的 Claude /
 * Gemini、部分多模态与国产兼容接口会把正文包成**内容块数组**
 * `[{ type: 'text', text: '…' }, …]`。用 `+` 拼到字符串上时，JS 会调用
 * `Array.prototype.toString()` —— 得到 `"[object Object],[object Object]"`。
 *
 * 症状极具迷惑性（2026-11-01 用户截图）：正文里那一段变成 `[object Object],…`；
 * 而**围栏的 ``` 与语言名来自别的帧**，于是围栏语法完好、里面却是这串垃圾 ——
 * 客户端据此提取出的产物卡片标题正常（`代码块 (nanowork-expert) 1`）、内容却是
 * `[object Object],…`。用户看到的是「JSON 被渲染坏了」，实际是**收流时就把正文
 * 毁了**，且不可恢复。
 *
 * ## 只认 text 块
 *
 * `tool_use` / `image` / `thinking` 这些块不是正文（它们的内容在别的字段里，由
 * `nanobot_event` 通道单独下发）。把它们塞进正文只会让气泡里多出无意义的占位符，
 * 所以这里**丢弃**而不是 stringify。
 */

/** 单个内容块 → 文本 */
function blockText(block: unknown): string {
  if (typeof block === 'string') return block;
  if (block === null || typeof block !== 'object') return '';
  const { type, text } = block as { type?: unknown; text?: unknown };
  if (typeof text !== 'string') return '';
  // 没写 type 的块按 text 处理（部分实现省略该字段）
  if (type !== undefined && type !== 'text' && type !== 'output_text') return '';
  return text;
}

/**
 * `delta.content` / `message.content` → 纯文本（无法识别时返回空串）。
 *
 * 空串表示「这一帧没有正文」，调用方据此跳过打点与渲染，**不要**把它当成
 * 一个空 chunk 回填——那会让首字延迟与流式状态都提前触发。
 */
export function deltaContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).join('');
  return '';
}
