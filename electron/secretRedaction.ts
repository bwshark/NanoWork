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

/**
 * 路径里的**用户身份**脱敏（FR-11.9 补漏，2026-10-21 真机验收发现）。
 *
 * ## 为什么必须做
 *
 * 验收清单 C.7 明确要求「解压自查：**无绝对路径用户名**」——诊断包是用户要
 * **发出去**的（贴给他人 / 发工单），带用户名的绝对路径等于把身份一起发出去。
 *
 * 真机跑出来才发现的缺口：凭据脱敏（`redactSecrets`）只管「长得像凭据」的值，
 * **完全不管路径**。而工具调用的参数与结果里全是绝对路径——
 * PRD §20.4.3 明确说「工具参数与结果相反——『哪一步失败、参数是什么』是排障的
 * 全部，保留并截断到 4000 字符」，所以这些路径**不能删**，只能**换掉用户名**。
 *
 * 真机证据（`tasks/verify-feedback-bundle.mjs`）：诊断包解压后
 * `traces/53568/trace_*.json` 里出现 `C:\Users\xinmi\NanoWork\ai-short-drama-kit.md`。
 *
 * ## 做法：把主目录换成占位符，**保留路径结构**
 *
 * `C:\Users\xinmi\NanoWork\a.md` → `C:\Users\<user>\NanoWork\a.md`
 *
 * 为什么不整段抹掉：路径结构本身是排障线索（「它写到工作区还是写到临时目录」
 * 「它是不是逃出了工作区」）。整段抹掉等于把诊断能力一起毁掉——和
 * `mask()` 刻意**不**处理 `args_digest`（sha256）是同一个理由。
 *
 * ## 边界
 *
 * - 只换**主目录那一段**。主目录之外的路径（`D:\projects\...`）不含用户名，
 *   保留——那里可能有排障价值（如「引擎把文件写到 D 盘了」）。
 * - **不含用户名的机器不受影响**（占位符替换是幂等的）。
 * - 替换**不引入引号/反斜杠/换行**，脱敏后 JSON 依然合法。
 */

/** 主目录占位符（与 WorkBuddy 的口径一致：保留 `<user>` 这个可辨识形状） */
const HOME_PLACEHOLDER = '<user>';

/**
 * 找出「主目录」在文本里的各种写法。
 *
 * ⚠️ 路径在 JSON 里是**转义过的**：反斜杠写成 `\\`，正斜杠写成 `/`。
 * 所以同一个主目录在文本里至少有三种形态：
 * `C:\Users\xinmi`（裸）、`C:\\Users\\xinmi`（JSON 转义）、`C:/Users/xinmi`（正斜杠）。
 * 只处理其中一种会漏——真机上三种都出现过。
 */
function buildHomePatterns(home: string): RegExp[] {
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 主目录在 Windows 上是 `C:\Users\xinmi`；取**最后一段**（用户名）做匹配，
  // 免得盘符变化就漏（用户可能把 home 放在 D 盘）。
  const segments = home.split(/[\\/]+/).filter(Boolean);
  const user = segments[segments.length - 1];
  if (!user) return [];
  const userEscaped = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const drive = segments[0] ? `${segments[0]}[\\\\/]` : '';
  return [
    // 整条主目录（保留盘符与父目录段）
    new RegExp(`${drive}Users[\\\\/]+${userEscaped}`, 'g'),
    // 只换用户名那一段（home 不在 Users 下时兜底）
    new RegExp(`([\\\\/](?:home|Users)[\\\\/]+)${userEscaped}`, 'g'),
  ];
}

/**
 * 把文本里的主目录换成 `<user>` 占位符。
 *
 * @returns `text` 替换后的文本；`hits` 命中次数（用于如实记录「这包被脱敏过」）
 */
export function redactHomePaths(text: string, home: string): RedactResult {
  if (!home) return { text, hits: 0 };
  let hits = 0;
  let next = text;
  for (const re of buildHomePatterns(home)) {
    next = next.replace(re, (m: string) => {
      hits += 1;
      // 保留匹配到的父目录形状（盘符 + Users），只把用户名段换掉
      return m.replace(userSegment(home), HOME_PLACEHOLDER);
    });
  }
  return { text: next, hits };
}

/** 从主目录里取出用户名那一段（按分隔符切，取最后一段） */
function userSegment(home: string): string {
  const segments = home.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? '';
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
