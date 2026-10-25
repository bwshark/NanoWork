/**
 * 有界注入：**结论与最近事实如何进入 system 段**（设计 §4.6）。
 *
 * 需求：`docs/prd-memory-v2.md` FR-M10 / NFR-M6 / NFR-M12。
 *
 * ## 这个模块要回答的唯一问题
 *
 * 「这一轮该把哪些记忆送进 prompt，以及**最多送多少**」。
 *
 * v1 的答案是「把记住的全部塞进去」，于是注入量随日志天数线性增长，最终把上下文挤爆
 * （设计 §1.3 的根因之三）。v2 的答案是有预算、有优先级、**有可观察的截断计数**：
 *
 * ```
 * 渲染各段 → 按 (importance DESC, lastSeen DESC, entryKey ASC) 排序
 *          → 逐条装入预算 → 装不下的计入 truncated
 * ```
 *
 * ## 三条硬约束
 *
 * 1. `superseded` / `disabled` 修订与**冲突候选永不进 prompt**（不变量 I8）。
 * 2. 总量**不随日志天数增长**：日志只能通过「最近 N 条事实」这一个有界窗口进入。
 * 3. 确定性：同输入同结果（字符串比较用 `<`，禁用 `localeCompare` —— NFR-M12）。
 */

import type { CuratedEntry, CuratedState, MemoryFact, PreferenceRecord, UserProfile } from '@/types';
import { INJECTION_HEADINGS, MEMORY_GUARD_LINE } from '@/lib/memory/memoryInjectionContract';
import { compareStrings } from '@/lib/memory/memoryNormalize';

/** 注入预算（对标 WorkBuddy 的单会话写入上限口径：用户级 4000 / 工作区级 3000 字符） */
export interface InjectionBudget {
  /** 用户级段落的字符上限 */
  userChars: number;
  /** 工作区级段落的字符上限 */
  workspaceChars: number;
  /** 最近事实的条数上限 */
  recentFactLimit: number;
}

/** 默认预算（设置页可放宽；`docs/prd-memory-v2.md` FR-M10） */
export const DEFAULT_INJECTION_BUDGET: InjectionBudget = {
  userChars: 4000,
  workspaceChars: 3000,
  recentFactLimit: 6,
};

/** 一条被渲染出来的记忆行（带排序所需的元信息） */
interface RenderedLine {
  text: string;
  /** 排序键 1：重要度（越大越先留） */
  importance: number;
  /** 排序键 2：最近时间（越新越先留） */
  lastSeen: string;
  /** 排序键 3：稳定键（保证同输入同结果） */
  stableKey: string;
}

/** 注入块的各部分输入 */
export interface InjectionInputs {
  profile: UserProfile;
  preferences: PreferenceRecord[];
  userCurated: CuratedEntry[];
  workspaceCurated: CuratedEntry[];
  /** 最近事实（按 observedAt 降序，调用方负责取够 `budget.recentFactLimit + 余量` 条） */
  recentFacts: MemoryFact[];
  /** 用户级 legacy 正文（v1 的 `~/.nanowork/MEMORY.md` 内容）——**必须继续注入** */
  userLegacyText?: string;
  /** 工作区级 legacy 正文（v1 的 `MEMORY.md` + 日期 `.md` 合并）——**必须继续注入** */
  workspaceLegacyText?: string;
}

/** 注入结果 */
export interface InjectionBlock {
  /** **未包裹**的正文：`<!-- MEMORY -->` 标签与护栏句由唯一包裹点（`wrapForInjection`）补 */
  text: string;
  /** 计入 `entries` 的条数（两段各自计数之和，不含段标题） */
  entries: number;
  /** 因预算被裁掉的行数（0 表示全装下了） */
  truncated: number;
}

/**
 * 生成一次注入的正文。
 *
 * 返回的是**未包裹正文**：标签与护栏句由调用方唯一一次调 `wrapForInjection` 补。
 * 若这里也画上标签，字面实现会双重包裹、护栏句出现两次，并破坏
 * `MemoryService.extractFromInjection` 的还原（设计 §4.6 的「唯一包裹点」）。
 */
export function buildInjectionBlock(
  inputs: InjectionInputs,
  budget: InjectionBudget = DEFAULT_INJECTION_BUDGET,
): InjectionBlock {
  const userLines = collectUserLines(inputs);
  const workspaceLines = collectWorkspaceLines(inputs);

  const userText = packLines(userLines, budget.userChars, inputs.userLegacyText ?? '');
  const workspaceText = packLines(
    workspaceLines,
    budget.workspaceChars,
    inputs.workspaceLegacyText ?? '',
  );

  const sections: string[] = [];
  if (userText.text.trim() !== '') {
    sections.push(`${INJECTION_HEADINGS.user}\n${userText.text}`);
  }
  if (workspaceText.text.trim() !== '') {
    sections.push(`${INJECTION_HEADINGS.workspace}\n${workspaceText.text}`);
  }

  return {
    text: sections.join('\n\n'),
    entries: userText.entries + workspaceText.entries,
    truncated: userText.truncated + workspaceText.truncated,
  };
}

/** 用户级段落的行（画像 + 活跃偏好 + 用户级策展修订） */
function collectUserLines(inputs: InjectionInputs): RenderedLine[] {
  const lines: RenderedLine[] = [];

  const profileLines = profileToLines(inputs.profile);
  for (const line of profileLines) {
    lines.push({ text: line, importance: 5, lastSeen: '', stableKey: `profile:${line}` });
  }

  for (const pref of inputs.preferences ?? []) {
    lines.push({
      text: `- \`${pref.key}\`: ${pref.value}`,
      // 用户显式偏好比策展结论更该保留：它是「明确要求」而不是「推断」
      importance: 5,
      lastSeen: pref.updatedAt ?? '',
      stableKey: `pref:${pref.key}`,
    });
  }

  for (const entry of inputs.userCurated ?? []) {
    if (entry.status !== 'active') continue;
    if (entry.content.trim() === '') continue;
    lines.push({
      text: `- ${entry.content}`,
      importance: entry.importance,
      lastSeen: entry.lastSeen,
      stableKey: entry.entryKey,
    });
  }

  return lines;
}

/** 工作区级段落的行（策展修订 + 最近事实） */
function collectWorkspaceLines(inputs: InjectionInputs): RenderedLine[] {
  const lines: RenderedLine[] = [];

  for (const entry of inputs.workspaceCurated ?? []) {
    if (entry.status !== 'active') continue;
    if (entry.content.trim() === '') continue;
    lines.push({
      text: `- ${entry.content}`,
      importance: entry.importance,
      lastSeen: entry.lastSeen,
      stableKey: entry.entryKey,
    });
  }

  // 最近事实：**唯一**让 daily 日志进入 prompt 的窗口（有界，不随天数增长）。
  // 条数上限由调用方按 `budget.recentFactLimit` 取好；这里只负责渲染与排序。
  for (const fact of inputs.recentFacts ?? []) {
    lines.push({
      text: `- ${fact.content}`,
      // 近期事实的重要度打折：它们是「刚发生」，不是「已确认」
      importance: Math.max(1, fact.importance - 3),
      lastSeen: fact.observedAt,
      stableKey: `fact:${fact.factId}`,
    });
  }

  return lines;
}

/** 排序：重要度降序 → 时间降序 → 稳定键升序（全用 `<`，保证跨 locale 一致） */
function compareLines(a: RenderedLine, b: RenderedLine): number {
  if (b.importance !== a.importance) return b.importance - a.importance;
  const at = a.lastSeen === '' ? 0 : Date.parse(a.lastSeen);
  const bt = b.lastSeen === '' ? 0 : Date.parse(b.lastSeen);
  const ta = Number.isFinite(at) ? at : 0;
  const tb = Number.isFinite(bt) ? bt : 0;
  if (tb !== ta) return tb - ta;
  return compareStrings(a.stableKey, b.stableKey);
}

/**
 * 按优先级把行装进预算，并把 legacy 正文放在**末尾、最低优先级**。
 *
 * 返回值里的 `entries` 只数「行」——legacy 正文的条数由调用方用自己的体例计
 * （它是 Markdown 段落，不是行）。
 */
function packLines(
  lines: readonly RenderedLine[],
  budgetChars: number,
  legacyText: string,
): { text: string; entries: number; truncated: number } {
  const sorted = [...lines].sort(compareLines);
  const kept: string[] = [];
  let used = 0;
  let truncated = 0;

  for (const line of sorted) {
    const cost = line.text.length + 1;
    if (used + cost > budgetChars) {
      truncated += 1;
      continue;
    }
    kept.push(line.text);
    used += cost;
  }

  // legacy 正文（v1 资产）排在**末尾**：它是「历史记录」，不是「当前结论」。
  // 预算装不下时**它可以被裁掉**（否则预算无从成立），但裁掉的事实由 `truncated`
  // 如实计数——记忆页要显示「有 N 条历史格式内容因预算未注入」，不能静默丢。
  const legacy = (legacyText ?? '').trim();
  let legacyKept = '';
  if (legacy !== '') {
    const cost = legacy.length + 1;
    if (used + cost <= budgetChars) {
      legacyKept = legacy;
      used += cost;
    } else {
      truncated += 1;
    }
  }

  const parts = [...kept, legacyKept].filter((t) => t.trim() !== '');
  return { text: parts.join('\n'), entries: kept.length, truncated };
}

/** 画像 → 展示行（`callThem` 等内部字段名要翻成用户看得懂的中文） */
export function profileToLines(profile: UserProfile): string[] {
  const labels: Record<string, string> = {
    name: '姓名',
    callThem: '称呼',
    timezone: '时区',
    language: '默认语言',
    occupation: '职业',
    organization: '所在组织',
    role: '角色',
    city: '常驻城市',
    responseStyle: '表达偏好',
  };
  const out: string[] = [];
  for (const [field, value] of Object.entries(profile ?? {})) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    out.push(`- ${labels[field] ?? field}: ${value}`);
  }
  return out;
}

/**
 * 由「两段正文」合成注入正文（保留 v1 的段标题与定序）。
 *
 * 与 `MemoryService.composeMemoryForInjection` 的区别：那个是 v1 的入口（只处理两层
 * 纯文本），本函数是 v2 的入口（已在 `buildInjectionBlock` 内按预算装好）。
 * 定序与段标题**必须与 v1 一致**——护栏句写着「以用户级为准」，顺序反了那句就指向空处。
 */
export function composeInjectionSections(userText: string, workspaceText: string): string {
  const sections: string[] = [];
  const user = (userText ?? '').trim();
  const workspace = (workspaceText ?? '').trim();
  if (user !== '') sections.push(`${INJECTION_HEADINGS.user}\n${user}`);
  if (workspace !== '') sections.push(`${INJECTION_HEADINGS.workspace}\n${workspace}`);
  return sections.join('\n\n');
}

/** 供调用方拼 provenance 头（可观察「注入了哪个快照」） */
export interface InjectionProvenance {
  userScope: string;
  workspaceId: string;
  capturedAt: string;
  entries: number;
  truncated: number;
}

/** provenance 注释行（放在护栏句之后，人读时一眼看到快照信息） */
export function provenanceLine(p: InjectionProvenance): string {
  return (
    `<!-- memory-provenance source=client-memory-v2 user_scope=${p.userScope} ` +
    `workspace_id=${p.workspaceId} captured_at=${p.capturedAt} ` +
    `entries=${p.entries} truncated=${p.truncated} -->`
  );
}

export { MEMORY_GUARD_LINE };
