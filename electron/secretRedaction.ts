/**
 * 日志出口的内容级凭据脱敏（FR-11.9）。
 *
 * ## 为什么在「出口」而不在「写入」
 *
 * 本地日志必须保持**原文**：排查「为什么这把密钥报 401」时，脱敏过的日志等于废纸。
 * 而诊断包是**会被用户发出去的**（设置页一键导出 → 贴给他人/发工单），那才是危险的地方。
 * 所以脱敏只发生在 `buildDiagnosticsBundle` 读文件进 zip 的那一刻。
 *
 * ## 与既有「清单级排除」的分工
 *
 * `diagnostics.ts` 早就**整文件排除**了 `nanowork.config.json` / `channels.json` /
 * `connectors/`（含明文凭据的那几个）。那是第一道防线，也是主防线。
 * 本模块是第二道：日志/trace 里**夹带**的凭据（工具参数、报错回显、用户粘贴的片段）。
 *
 * ⚠️ **如实记录的边界**（照 WorkBuddy `high-credit-gate.cjs` 的纪律写清楚）：
 * 脱敏是**模式匹配**，只能覆盖「长得像凭据」的东西。一个不像任何模式的密钥
 * （比如用户自定义的 `x-my-token: <32位随机串>`，键名不在名单里）**会被漏掉**。
 * 这一层不自称完备——真正的保证仍然是「含凭据的文件根本不进包」。
 *
 * ## 为什么这些模式是保守的
 *
 * 刻意**不**脱敏长十六进制串：`args_digest`（sha256，64 hex）在审计日志里是排查
 * 「哪次调用」的关键线索，脱敏它会把诊断能力一起毁掉。凭据与摘要的分辨率靠
 * 「键名是不是凭据词」+「是不是 Bearer/JWT/sk- 形态」这两条信号，不靠长度。
 */

export interface RedactResult {
  text: string;
  /** 被改过的匹配数（用于在 meta.json 里如实记录「这包被脱敏过」） */
  hits: number;
}

/** 键名看起来是凭据的 `key: value` / `key=value` */
const CREDENTIAL_KV_RE =
  /(api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|secret|token|password|passwd|credential|authorization)(\s*["']?\s*[:=]\s*["']?)([^\s"',;})\]]{8,})/gi;
/** `Authorization: Bearer <token>` 的 token 部分 */
const BEARER_RE = /(Bearer\s+)([A-Za-z0-9._\-]{12,})/gi;

/** OpenAI 风格的 `sk-…` */
const SK_RE = /\bsk-[A-Za-z0-9]{16,}\b/g;

/** JWT：`eyJ…` 三段式 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** 保留首 4 尾 4，中间打码；太短就整串打码 */
function mask(value: string): string {
  if (value.length < 12) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * 脱敏一段文本。
 *
 * 替换**不引入引号/反斜杠/换行**，所以脱敏后的 JSON 依然是合法 JSON——
 * 拿到包的人 `jq` 一下不会因为脱敏而解析失败。
 */
export function redactSecrets(text: string): RedactResult {
  let hits = 0;

  const next = text
    // 键值对：保留键名与分隔符，只打值
    .replace(CREDENTIAL_KV_RE, (_m, key: string, sep: string, value: string) => {
      hits += 1;
      return `${key}${sep}${mask(value)}`;
    })
    .replace(BEARER_RE, (_m, scheme: string, value: string) => {
      hits += 1;
      return `${scheme}${mask(value)}`;
    })
    .replace(SK_RE, (m: string) => {
      hits += 1;
      return mask(m);
    })
    .replace(JWT_RE, (m: string) => {
      hits += 1;
      return mask(m);
    });

  return { text: next, hits };
}

/** 一批文本一起脱敏，返回合计命中数 */
export function redactSecretsIn(texts: readonly string[]): { texts: string[]; hits: number } {
  let hits = 0;
  const out = texts.map((t) => {
    const r = redactSecrets(t);
    hits += r.hits;
    return r.text;
  });
  return { texts: out, hits };
}
