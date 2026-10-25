/**
 * 「这段正文像不像 provider / 网关的系统报错」——**纯判据模块**。
 *
 * ## 为什么从 `src/lib/memory/memory.ts` 搬出来
 *
 * 这个判据原先住在 `src/lib/memory/memory.ts`，而那个文件 import 了 `@/platform` 与
 * `@/ai/connectionManager`。记忆 v2 的事实校验（`memory/memoryFact.ts`）必须能调它，而事实校验
 * 按设计是**纯函数、无 platform、无 IO**（NFR-M1：无 API key 可验证）——从纯模块反向
 * import 一个带 platform 的文件会直接把 `@/platform` 拉进测试与主进程。
 *
 * 故搬到无依赖的纯模块；`src/lib/memory/memory.ts` 转出它，既有引用零改动。
 *
 * ## 判据本身（v1 的原样保留，附原始事故记录）
 *
 * 为什么护栏必须落在**内容层**：网关（nanobot）在配额 / 鉴权失败时会把错误文案
 * 当作**正常 `delta.content` 吐进 SSE 流**，通道层面分不出这一帧是回答还是报错。
 * 实测事故：用户提问撞上 provider 配额耗尽，错误原文（`The AI provider rejected
 * the request because the API key is out of quota…`）被摘要链路当作模型输出收下，
 * 又因为不含 `[身份]/[任务]` 标签走了整段降级分支，最终以「会话摘要」的名义写进
 * 工作区记忆。记忆是长期资产：一条系统报错躺进去，此后每次会话都会被注入。
 *
 * 判据刻意用「**强特征词** + **语言**」双重条件，宁可漏判也不误杀：
 * - 只看特征词会误杀「用户正在排查 API key 配额问题」这类完全正常的摘要——
 *   中文摘要里出现英文术语是常态；
 * - 报错原文则以英文为主、几乎不含中文。故要求「命中特征词 **且** 中文占比低于 15%」。
 *
 * 已知代价：**中文错误文案认不出来**（中文报错与中文摘要在语言上无法区分），
 * 这类漏判由摘要链路的 `onError` 通道兜底，不由本判定承担。
 */

/**
 * 命中即「疑似报错」的强特征词。
 *
 * ⚠️ 2026-10-01 补三类**真实漏判**——从生产记忆目录里捞出 6 条报错块，全都是下面这些形态：
 * 上游「模型不存在」类（`The model \`x\` does not exist…`）、`Error calling LLM: Connection error.`、
 * 以及网关把 Python dict repr 当 content 吐出来的 `Error: {'message': …}`。
 * 它们**全是英文**（中文占比 0%，语言条件本就满足），漏的是特征词。
 */
const SYSTEM_ERROR_SIGNATURES = [
  'out of quota',
  'insufficient_quota',
  'arrears',
  'api key',
  'invalid_api_key',
  'rejected the request',
  'rate limit',
  'too many requests',
  'unauthorized',
  'econnrefused',
  'econnreset',
  'etimedout',
  'socket hang up',
  'fetch failed',
  'internal server error',
  'bad gateway',
  'service unavailable',
  // 上游「模型 / 资源不存在」类：厂商 SDK 措辞各异，故并列多个形态
  'does not exist',
  'model_not_found',
  'notfounderror',
  'invalid_request_error',
  // 调用层失败
  'connection error',
  'error calling llm',
  // Python dict repr 形态（`Error: {'message': …}`）——「网关把报错当 content 吐」的典型形状
  'error: {',
  // 报错响应常带这两个字段名，而中文摘要不会原文照抄它们
  'request id',
  'trace id',
];

/** 判为报错原文前允许的最大中文占比（见 `looksLikeSystemError`） */
const SYSTEM_ERROR_MAX_CJK_RATIO = 0.15;

/** 中日韩统一表意文字在**可见字符**中的占比（空白不计入分母） */
export function cjkRatio(text: string): number {
  const visible = (text ?? '').replace(/\s/g, '');
  if (visible === '') return 0;
  const cjk = visible.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return cjk / visible.length;
}

/**
 * 正文是否像 provider / 网关的系统报错（而非对话内容或摘要）。
 *
 * 三个调用点：事实入口（`memory/memoryFact.ts`，报错原文不得成为长期记忆）、
 * 摘要出口与摘要入口（`src/lib/memory/memory.ts`）——同一个判据，多种入口。
 */
export function looksLikeSystemError(text: string): boolean {
  const src = (text ?? '').trim();
  if (src === '') return false;
  const lower = src.toLowerCase();
  if (!SYSTEM_ERROR_SIGNATURES.some((sig) => lower.includes(sig))) return false;
  return cjkRatio(src) < SYSTEM_ERROR_MAX_CJK_RATIO;
}
