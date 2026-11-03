/**
 * FR-8.9 第四条来源：**引擎侧两份应用操作审计**的路径解析与内容合并。
 *
 * ## 为什么是两份
 *
 * `serve`（/v1 API）与 `gateway`（IM 渠道长连接）是两个**并行进程**，都由主进程
 * 拉起（`Promise.all`）。两边都会产生「非工具类动作」：serve 侧是 Dream 采纳、
 * 配置热加载；gateway 侧是「把写好的消息发到 IM」。让它们往同一个文件 append，
 * 正确性就押在「单次 write 小于 PIPE_BUF 时 O_APPEND 原子」这条平台细节上——
 * 行被内核切开就是两行都坏，而解析层对坏行只能整行丢弃，等于悄悄丢证据。
 *
 * ## 为什么合并放在主进程而不是渲染层
 *
 * 渲染层拿到的是「一段 NDJSON」，行号连续、可按 ts 混排。若给它两个独立结果，
 * 行号会在两段之间重复，`ParsedAppAuditRecord.line`（用于稳定排序与溯源）就失去意义。
 *
 * ## 拼接必须补齐换行
 *
 * 两个文件各自都以 `\n` **结尾**是追加写的自然结果，但「自然」不是「保证」：
 * 进程被强杀时最后一行可能没有换行符。此时 `join('')` 会把前一份的最后一行与后一份
 * 的第一行粘成一条坏 JSON —— 解析层只好整行丢弃，正好丢掉最不该丢的那条（崩溃前
 * 的最后一次动作）。所以这里逐份规范化，而不是简单地相加。
 */

/** 与 `nanobot/security/audit.py` 里的两个 env 同名（引擎可重定向 / 可关闭）。 */
export interface EngineAppAuditEnv {
  /** `NANOBOT_APP_AUDIT_LOG`（serve 那份）。 */
  app?: string;
  /** `NANOBOT_GATEWAY_AUDIT_LOG`（gateway 那份）。 */
  gateway?: string;
}

const APP_FILE = 'app-operations.ndjson';
const GATEWAY_FILE = 'app-operations.gateway.ndjson';

/**
 * 解析出要读的文件清单。
 *
 * 三种取值逐条对应引擎侧语义：
 * - `undefined`：没设 → 用 `auditDir` 下的默认文件名；
 * - 有内容：显式路径（`join` 只为统一分隔符，不改语义）；
 * - **空串：关闭那一份**（与 `nanobot/security/audit.py` 的 `raw.strip()` 判据一致）。
 *
 * 返回值可能是空数组（两份都关掉）。调用方据此回「无审计」而不是回一个
 * 永远不存在的路径——否则界面会提示去那个文件里找。
 */
export function resolveEngineAppAuditTargets(
  env: EngineAppAuditEnv,
  auditDir: string,
): string[] {
  const one = (raw: string | undefined, file: string): string | null => {
    if (raw === undefined) return joinPath(auditDir, file);
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
  };
  return [one(env.app, APP_FILE), one(env.gateway, GATEWAY_FILE)].filter(
    (target): target is string => target !== null,
  );
}

/** 极小的路径拼接：只做分隔符归一，不解析 `..`（路径来自本地 env，不是用户输入）。 */
function joinPath(dir: string, file: string): string {
  if (!dir) return file;
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${file}` : `${dir}${sep}${file}`;
}

/** 合并多份 NDJSON 文本。每份之间的换行**必须**补齐，理由见文件头注释。 */
export function mergeEngineAppAuditContent(chunks: string[]): {
  content: string;
  exists: boolean;
} {
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    parts.push(chunk.endsWith('\n') ? chunk : `${chunk}\n`);
  }
  return {
    content: parts.join(''),
    // 只有空白的文件等于「还没有记录」：中间态（进程刚建好文件就退出）不该让
    // 界面显示一张空表，那会让人以为审计坏了。
    exists: parts.some((part) => part.trim().length > 0),
  };
}
