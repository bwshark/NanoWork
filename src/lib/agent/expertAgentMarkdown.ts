/**
 * 专家定义 Markdown（`agents/<name>.md`）的解析。
 *
 * ## 为什么单独一个模块
 *
 * 同一份 `.md` 有两个读者：Electron 主进程（扫插件包里的专家定义）与渲染层
 * （预览 / 落地成 Agent）。解析写两遍必然漂移——症状是「插件页显示 3 位专家，
 * 导入后提示词全是空的」这种最难自查的错位。
 *
 * ⚠️ 本文件**不得 import 任何 `@/` 别名模块**：主进程（`electron/**`）通过相对
 * 路径 import 它，别名在主进程的 esbuild 配置里不存在，一旦引入，`main.cjs`
 * 打包就会失败（见 `electron/plugins` 链路上的既有约束）。
 *
 * ## 为什么自己写一个 YAML 子集解析器
 *
 * frontmatter 的实际形态只有两种：`key: value` 与 `key:\n  sub: value`（后者
 * 专供 `displayName` / `profession` 的中英双写）。为此引入一个 YAML 依赖，
 * 等于为 40 行代码加一个有解析历史漏洞的第三方包，还要让它同时进主进程与渲染层
 * 两个 bundle。这里只做**够用的子集**，遇到不认识的写法就当普通值处理——
 * frontmatter 写坏时的正确行为是「降级到用文件名当名字」，而不是整份丢弃。
 */

/** frontmatter 里我们真正会用的字段（其余原样保留在 `raw` 里） */
export interface ExpertAgentFrontmatter {
  /** Agent 标识，须与文件名一致（WorkBuddy 规范） */
  name?: string;
  /** 中英双语字段 */
  displayName?: { en?: string; zh?: string };
  profession?: { en?: string; zh?: string };
  /** 英文一句话描述（AI 用来判断何时激活） */
  description?: string;
  maxTurns?: number;
}

export interface ParsedExpertAgentMarkdown {
  frontmatter: ExpertAgentFrontmatter;
  /** frontmatter 之后的正文（系统提示词本体） */
  body: string;
}

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 去掉包裹的成对引号（单/双），并处理最外层双引号里的 `\"` */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

/**
 * 解析 frontmatter 区块。
 *
 * 支持的行形态：
 * - `key: value`
 * - `key:` 后跟若干 `  sub: value`（缩进两格）
 * - `# 注释` 与空行（忽略）
 */
function parseFrontmatterBlock(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentKey: string | null = null;

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indentMatch = /^(\s+)(.*)$/.exec(rawLine);
    if (indentMatch) {
      const parent = currentKey ? out[currentKey] : undefined;
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(indentMatch[2]);
      if (kv && parent && typeof parent === 'object' && parent !== null) {
        (parent as Record<string, string>)[kv[1]] = unquote(kv[2]);
      }
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    currentKey = key;
    // 空值 + 后续缩进行 = 嵌套对象；空值且无缩进 = 空串（交给下游判空）
    out[key] = value === '' ? {} : unquote(value);
  }

  return out;
}

function pickPair(value: unknown): { en?: string; zh?: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const src = value as Record<string, unknown>;
  const en = typeof src.en === 'string' ? src.en.trim() : undefined;
  const zh = typeof src.zh === 'string' ? src.zh.trim() : undefined;
  if (!en && !zh) return undefined;
  return { ...(en ? { en } : {}), ...(zh ? { zh } : {}) };
}

/**
 * 解析一篇专家定义 Markdown。
 *
 * 没有 frontmatter 时也返回成功（`frontmatter: {}`，`body` = 全文）：
 * 手写的 `.md` 很常见，不该因为缺 frontmatter 就被当成坏文件跳过。
 */
export function parseExpertAgentMarkdown(source: string): ParsedExpertAgentMarkdown {
  const text = typeof source === 'string' ? source : '';
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return { frontmatter: {}, body: text.trim() };
  }

  const raw = parseFrontmatterBlock(match[1]);
  const frontmatter: ExpertAgentFrontmatter = {};

  if (typeof raw.name === 'string' && raw.name) frontmatter.name = raw.name;
  if (typeof raw.description === 'string' && raw.description) {
    frontmatter.description = raw.description;
  }
  const displayName = pickPair(raw.displayName);
  if (displayName) frontmatter.displayName = displayName;
  const profession = pickPair(raw.profession);
  if (profession) frontmatter.profession = profession;

  const maxTurns = Number(raw.maxTurns);
  if (Number.isFinite(maxTurns) && maxTurns > 0) frontmatter.maxTurns = maxTurns;

  return { frontmatter, body: text.slice(match[0].length).trim() };
}

/**
 * 从解析结果里取一个可读的名字。
 *
 * 优先级：displayName.zh > name > 文件名。刻意**不**用 profession 兜底 ——
 * profession 是「做什么」，拿它当名字会出现两个都叫「架构师」的专家。
 */
export function expertAgentDisplayName(
  parsed: ParsedExpertAgentMarkdown,
  fallback: string,
): string {
  return parsed.frontmatter.displayName?.zh || parsed.frontmatter.name || fallback;
}
