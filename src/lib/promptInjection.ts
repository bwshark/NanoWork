/**
 * **提示词注入检测**（FR-8.6 ③）——纯规则、可单测、**只提示不拦截**。
 *
 * ## 为什么只提示不拦截
 *
 * 拦错了比不拦更糟：用户可能正在**讨论**注入防护（「帮我看看这段话有没有注入风险」），
 * 也可能在贴一段日志。拦截会让这类正常提问直接发不出去，而且用户无从知道
 * 是哪条规则拦的。所以这里只回答「这段话像不像在指使我做别的事」，
 * 把判断与决定交回给用户。
 *
 * ## 判据刻意收紧
 *
 * 每一条都要求「动作 + 对象」同时出现，而不是单看关键词：
 * - `api key` 单独出现 → **不报**（用户天天在问「API key 配额怎么排查」）；
 * - `send … api key` / `读取 .env` 这种组合才报；
 * - 「忽略」单独出现也不报，必须紧跟「以上 / 之前 + 指令 / 规则」。
 *
 * 已知代价（如实写在调用处）：中文的隐晦表达（「把我刚才说的那套都作废」）
 * 认不出来。规则集是**下限保护**，不是安全边界——真正的边界是引擎侧的工具审批
 * 与路径规则（FR-8.2 / FR-8.13）。
 */

/** 四类注入意图 */
export type InjectionKind = 'override' | 'role-hijack' | 'exfiltration' | 'obfuscation';

/** 一条命中 */
export interface InjectionHit {
  kind: InjectionKind;
  /** 面向用户的短语（「试图覆盖既有指令」） */
  label: string;
  /** 命中的原文片段（截断，供用户自己确认） */
  excerpt: string;
}

interface InjectionRule {
  kind: InjectionKind;
  label: string;
  pattern: RegExp;
}

/**
 * 规则表。
 *
 * ⚠️ 加规则前先问一句「正常提问会不会命中」——这个模块的误报会直接显示在
 * 每个用户的输入框上方，误报一次就够让人不再信任它。
 */
const RULES: readonly InjectionRule[] = [
  // —— ① 指令覆盖：必须「覆盖动词 + 既有指令对象」 ——
  {
    kind: 'override',
    label: '试图覆盖既有指令',
    pattern:
      /(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|directions?)/i,
  },
  {
    kind: 'override',
    label: '试图覆盖既有指令',
    pattern:
      /(?:忽略|无视|忘掉|忘记|作废)(?:掉)?(?:以上|之前|前面|上述|上面|所有)(?:的)?(?:所有|一切)?(?:指令|规则|要求|提示词|设定|限制)/,
  },

  // —— ② 角色劫持：改写身份，或索要系统提示词 ——
  {
    kind: 'role-hijack',
    label: '试图改写角色设定',
    pattern:
      /(?:you\s+are\s+now|from\s+now\s+on(?:\s+you\s+are)?|act\s+as)\s+(?:a\s+|an\s+|the\s+)?(?:root|admin(?:istrator)?|dan|unrestricted|unfiltered)/i,
  },
  {
    kind: 'role-hijack',
    label: '试图改写角色设定',
    pattern: /(?:你现在是|从现在开始你是|从现在起你是|假装你是)[^\n]{0,12}(?:管理员|root|开发者模式|DAN|无限制|无审查)/i,
  },
  {
    kind: 'role-hijack',
    label: '索要系统提示词',
    pattern:
      /(?:reveal|print|show|repeat|output|dump)[^\n]{0,24}(?:system\s+prompt|your\s+instructions|your\s+system)/i,
  },
  {
    kind: 'role-hijack',
    label: '索要系统提示词',
    pattern: /(?:输出|打印|复述|泄露|告诉我|发给我)[^\n]{0,12}(?:系统提示词|系统指令|你的设定|你的提示词)/,
  },
  {
    // 中文里对象常在动作前面（「把系统提示词发给我」「系统指令贴出来」），
    // 只写「动词 → 对象」这一种语序会漏掉一大半真实说法。
    kind: 'role-hijack',
    label: '索要系统提示词',
    pattern:
      /(?:系统提示词|系统指令|你的设定|你的提示词)[^\n]{0,12}(?:输出|打印|复述|贴出来|告诉我|发给我|念一遍)/,
  },

  // —— ③ 外泄诱导：动作 + 凭据对象 ——
  {
    kind: 'exfiltration',
    label: '试图读取凭据文件',
    pattern:
      /(?:read|cat|open|print|读取|打开|查看|打印)[^\n]{0,24}(?:\.env\b|id_rsa|id_ed25519|\.ssh\b|\.aws\/credentials|\.npmrc|credentials\.json)/i,
  },
  {
    kind: 'exfiltration',
    label: '试图外传密钥',
    pattern:
      /(?:send|post|upload|email|发给|发送到|上传到|寄给)[^\n]{0,24}(?:api[\s_-]?key|token|secret|password|密钥|令牌|口令)/i,
  },
  {
    // 中文的「把字句」：必须带「把 / 将」，否则「token 过期了，发送到服务端」会被误报
    kind: 'exfiltration',
    label: '试图外传密钥',
    pattern:
      /(?:把|将)[^\n]{0,16}(?:api[\s_-]?key|token|secret|password|密钥|令牌|口令|\.env)[^\n]{0,16}(?:发给|发送到|上传到|寄给|贴到)/i,
  },

  // —— ④ 编码混淆：编码方式 + 执行意图，或长 base64 载荷 / 零宽字符 ——
  {
    kind: 'obfuscation',
    label: '疑似编码混淆的指令',
    pattern:
      /(?:base64|rot13|hex|十六进制)[^\n]{0,16}(?:decode|解码|解开|翻译)[^\n]{0,24}(?:follow|execute|执行|照做|运行)/i,
  },
  {
    kind: 'obfuscation',
    label: '疑似编码载荷',
    // 120+ 连续 base64 字符：正常文本里罕见，代码块里的 data URL 才会这么长。
    // 阈值取 120 而不是 80，是为了不把短哈希 / 短 token 也算进来。
    pattern: /[A-Za-z0-9+/]{120,}={0,2}/,
  },
  {
    kind: 'obfuscation',
    label: '含零宽字符',
    pattern: /[\u200b-\u200f\u2060\ufeff]/,
  },
];

/** 片段截断长度（够用户认出是哪句话，又不至于把整段贴回界面） */
const EXCERPT_MAX = 48;

/** 从命中位置取出可读片段：整行太短就向右补，太长就截断 */
function excerptAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEnd = text.indexOf('\n', index);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
  if (line.length <= EXCERPT_MAX) return line;
  const offset = Math.max(0, index - lineStart);
  const start = Math.max(0, Math.min(offset - 8, line.length - EXCERPT_MAX));
  return `${start > 0 ? '…' : ''}${line.slice(start, start + EXCERPT_MAX)}…`;
}

/**
 * 扫一段文本，返回命中项（**每类最多一条**，按规则表顺序）。
 *
 * 每类只留第一条：界面上「你这段话有 7 处可疑」不会让人更警觉，
 * 只会让人关掉这个提示。真正需要的是「这里像在指使我」。
 */
export function detectPromptInjection(text: string): InjectionHit[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const hits: InjectionHit[] = [];
  const seen = new Set<InjectionKind>();
  for (const rule of RULES) {
    if (seen.has(rule.kind)) continue;
    const match = rule.pattern.exec(text);
    if (!match) continue;
    seen.add(rule.kind);
    hits.push({
      kind: rule.kind,
      label: rule.label,
      excerpt: excerptAt(text, Math.max(0, match.index)),
    });
  }
  return hits;
}

/** 命中项的汇总文案（组件与测试共用，别各写一份） */
export function summarizeInjectionHits(hits: readonly InjectionHit[]): string {
  if (hits.length === 0) return '';
  const kinds = [...new Set(hits.map((h) => h.label))];
  return `这段话里有 ${hits.length} 处可疑指令（${kinds.join('、')}）。确认是你自己的意图再发送。`;
}
