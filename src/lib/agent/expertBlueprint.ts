/**
 * 专家蓝图（Expert Blueprint）—— 让 AI 生成的专家配置**能真正落库**。
 *
 * ## 为什么需要这一层
 *
 * 本项目的「专家」是纯客户端实体（`agentsStore` 的 `Agent` + `expertGroupsStore`
 * 的 `ExpertGroup`），AI 写不进 localStorage。而「自动创建专家」若只做到
 * 「跳进对话 + 说几句建议」，用户还得把生成的角色描述手工抄进表单 —— 那不算创建。
 *
 * 所以约定一种**可解析的中间格式**：AI 在回复里输出一个 fenced 代码块
 * （` ```nanowork-expert ` / ` ```nanowork-expert-team `），界面把它渲染成一张
 * 预览卡片，用户点「保存」时由本模块转成 store 调用。中间格式选 JSON 而不是
 * 直接让 AI 调工具，是因为提示词里能写清 schema、模型出错时错误可见、
 * 而且不需要给模型任何写权限。
 *
 * ## 三条刻意的设计选择
 *
 * 1. **解析失败时不剥离原文**。剥掉之后用户看到的是一段「凭空消失」的回答，而
 *    解析失败往往正是模型写坏了 JSON —— 那时原文是唯一的线索。
 * 2. **技能只保留本地存在的 id**。AI 会热情地写 `code-review` 之类的名字，而本机
 *    没装它时挂上去只是个永远不生效的空引用（症状：专家卡片显示 3 技能，实际 0 生效）。
 * 3. **落地一律用 `importAgent` 而不是 `createAgent`**。后者会静默改掉全局活跃
 *    专家 —— 用户只是想「存下来」，不是「现在换成他」。
 */

import type { Agent, ExpertGroup, ExpertGroupMode } from '@/types';
import type { PluginExpertPackage } from '@/types/plugin';

/** 单个专家的蓝图围栏语言标识 */
export const EXPERT_BLUEPRINT_LANG = 'nanowork-expert';
/** 专家团的蓝图围栏语言标识 */
export const EXPERT_TEAM_BLUEPRINT_LANG = 'nanowork-expert-team';

/** 专家的配置上限，防止模型写出一份几万字的提示词把界面与存储撑爆 */
export const EXPERT_BLUEPRINT_MAX_PROMPT_CHARS = 8000;
/** 单个专家团最多收几个成员（再多就是「一群」而不是「一团」，编排也跑不动） */
export const EXPERT_BLUEPRINT_MAX_MEMBERS = 8;

/** 蓝图里的一个成员（专家团用；单专家时整个蓝图就是一个成员） */
export interface ExpertBlueprintMember {
  name: string;
  /** 职业头衔 / 一句话定位，展示在卡片副标题 */
  role?: string;
  /** emoji 头像；省略则按名字派生 */
  avatar?: string;
  /** 系统提示词（角色定义 + 工作流） */
  systemPrompt: string;
  /** 想挂的技能 id（本地不存在的会被丢弃） */
  skillIds?: string[];
}

/** 一份可落地的专家蓝图 */
export interface ExpertBlueprint {
  kind: 'agent' | 'team';
  name: string;
  role?: string;
  description: string;
  icon?: string;
  /** kind=agent 时的系统提示词 */
  systemPrompt?: string;
  /** kind=agent 时想挂的技能 */
  skillIds?: string[];
  /** 绑定模型预设名（本地不存在的会被丢弃，理由同技能） */
  model?: string;
  /** kind=team 时的成员；**首位即主理人**（与专家团的执行约定一致） */
  members?: ExpertBlueprintMember[];
  mode?: ExpertGroupMode;
  /** 解析阶段产生的降级说明（字段缺失 / 被截断），供卡片展示 */
  warnings: string[];
}

/** 从一段助手正文里抽出的蓝图与「剥掉蓝图后的正文」 */
export interface ExtractedBlueprints {
  blueprints: ExpertBlueprint[];
  /**
   * 把蓝图代码块替换成一行说明后的正文。
   *
   * 蓝图块本身是几十行 JSON，原样渲染会在消息里铺满一屏高亮代码，
   * 而它承载的信息卡片里已经全部展示了。
   */
  stripped: string;
}

const FENCE_RE = /```(nanowork-expert|nanowork-expert-team)[ \t]*\r?\n([\s\S]*?)```/g;

/** 归一化技能 id 列表：去空、去重、限长 */
function normalizeSkillIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 12) break;
  }
  return out;
}

/** 截断提示词并记一条降级说明 */
function clampPrompt(raw: unknown, label: string, warnings: string[]): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  if (text.length <= EXPERT_BLUEPRINT_MAX_PROMPT_CHARS) return text;
  warnings.push(`${label}的提示词超过 ${EXPERT_BLUEPRINT_MAX_PROMPT_CHARS} 字，已截断`);
  return text.slice(0, EXPERT_BLUEPRINT_MAX_PROMPT_CHARS);
}

function normalizeMember(
  raw: unknown,
  index: number,
  warnings: string[],
): ExpertBlueprintMember | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name) {
    warnings.push(`第 ${index + 1} 位成员缺少姓名，已跳过`);
    return null;
  }
  const role = typeof item.role === 'string' ? item.role.trim() : undefined;
  const systemPrompt = clampPrompt(item.systemPrompt, `成员「${name}」`, warnings);
  if (!systemPrompt) {
    // 只给角色不给提示词时给一个最小可用的角色声明：它至少能让这位成员
    // 在编排里「知道自己是谁」，比挂一个空提示词强。
    warnings.push(`成员「${name}」没有提示词，已用角色定位兜底`);
  }
  const avatar = typeof item.avatar === 'string' ? item.avatar.trim() : undefined;
  return {
    name,
    ...(role ? { role } : {}),
    ...(avatar ? { avatar } : {}),
    systemPrompt: systemPrompt || `你是${name}${role ? `，担任${role}` : ''}，按用户需求给出专业产出。`,
    skillIds: normalizeSkillIds(item.skillIds),
  };
}

const GROUP_MODES: ExpertGroupMode[] = ['sequential', 'parallel', 'coordinator'];

/**
 * 把一段 JSON 归一化成蓝图。
 *
 * 返回 `null` 表示「这份 JSON 不是一份能落地的蓝图」（缺名字 / 专家团没有成员）。
 * 其余情况一律降级而不是抛错：模型输出的东西不可能百分之百合规，
 * 能救回来的部分就不该整份丢掉。
 */
export function normalizeExpertBlueprint(raw: unknown): ExpertBlueprint | null {
  if (raw === null || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const warnings: string[] = [];

  const name = typeof src.name === 'string' ? src.name.trim() : '';
  if (!name) return null;

  const role = typeof src.role === 'string' ? src.role.trim() : undefined;
  const description =
    typeof src.description === 'string' ? src.description.trim() : '';
  const icon = typeof src.icon === 'string' ? src.icon.trim() : undefined;
  const model = typeof src.model === 'string' ? src.model.trim() : undefined;
  const explicitKind = src.kind === 'team' ? 'team' : src.kind === 'agent' ? 'agent' : null;
  // kind 缺省时按结构推断：有成员数组就是团，否则是单个专家。
  const kind: 'agent' | 'team' =
    explicitKind ?? (Array.isArray(src.members) && src.members.length > 0 ? 'team' : 'agent');

  if (kind === 'agent') {
    const systemPrompt = clampPrompt(src.systemPrompt, '该专家', warnings);
    return {
      kind,
      name,
      ...(role ? { role } : {}),
      description,
      ...(icon ? { icon } : {}),
      systemPrompt,
      skillIds: normalizeSkillIds(src.skillIds),
      ...(model ? { model } : {}),
      warnings,
    };
  }

  const rawMembers = Array.isArray(src.members) ? src.members : [];
  const members: ExpertBlueprintMember[] = [];
  rawMembers.slice(0, EXPERT_BLUEPRINT_MAX_MEMBERS).forEach((item, index) => {
    const member = normalizeMember(item, index, warnings);
    if (member) members.push(member);
  });
  if (rawMembers.length > EXPERT_BLUEPRINT_MAX_MEMBERS) {
    warnings.push(`成员超过 ${EXPERT_BLUEPRINT_MAX_MEMBERS} 位，多余的已忽略`);
  }
  if (members.length === 0) return null;

  const mode =
    typeof src.mode === 'string' && GROUP_MODES.includes(src.mode as ExpertGroupMode)
      ? (src.mode as ExpertGroupMode)
      : 'coordinator';

  return {
    kind,
    name,
    ...(role ? { role } : {}),
    description,
    ...(icon ? { icon } : {}),
    skillIds: normalizeSkillIds(src.skillIds),
    ...(model ? { model } : {}),
    members,
    mode,
    warnings,
  };
}

/**
 * 从助手正文里抽出全部蓝图，并给出「剥掉蓝图」的正文。
 *
 * 命中但解析失败的块**不剥离**：那时原文是用户排查模型输出的唯一线索，
 * 悄悄吃掉只会让人以为 AI 什么都没生成。
 */
export function extractExpertBlueprints(content: string): ExtractedBlueprints {
  const blueprints: ExpertBlueprint[] = [];
  if (!content || !content.includes('```')) {
    return { blueprints, stripped: content };
  }

  let stripped = content;
  FENCE_RE.lastIndex = 0;
  const hits: Array<{ whole: string; blueprint: ExpertBlueprint }> = [];
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(content)) !== null) {
    const whole = match[0];
    const lang = match[1];
    const body = match[2];
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const blueprint = normalizeExpertBlueprint(parsed);
    if (!blueprint) continue;
    // 围栏语言与 kind 冲突时以内容为准：模型常把团写成 `nanowork-expert`
    if (lang === EXPERT_TEAM_BLUEPRINT_LANG && blueprint.kind !== 'team' && blueprint.members?.length) {
      blueprint.kind = 'team';
    }
    blueprints.push(blueprint);
    hits.push({ whole, blueprint });
  }

  for (const hit of hits) {
    const { blueprint } = hit;
    const label = blueprint.kind === 'team' ? '专家团' : '专家';
    stripped = stripped.replace(
      hit.whole,
      `> 🧩 已生成${label}蓝图「${blueprint.name}」，可在下方卡片中保存`,
    );
  }

  return { blueprints, stripped };
}

/** 落地所需的最小 store 能力（便于测试替换，避免 import 整个 store） */
export interface ExpertBlueprintSink {
  importAgent: (partial?: Partial<Agent>) => Agent;
  createGroup: (partial?: Partial<ExpertGroup>) => ExpertGroup;
}

export interface ExpertBlueprintApplyResult {
  agentIds: string[];
  groupId?: string;
  warnings: string[];
}

/**
 * 把蓝图落成真实的专家 / 专家团。
 *
 * `knownSkillIds` 给定时，蓝图里本地不存在的技能会被丢弃并记一条说明 ——
 * 不拦的话界面上会出现「绑了 3 个技能、一个都不生效」的专家。
 */
export function applyExpertBlueprint(
  blueprint: ExpertBlueprint,
  sink: ExpertBlueprintSink,
  options?: { knownSkillIds?: Iterable<string>; knownModels?: Iterable<string> },
): ExpertBlueprintApplyResult {
  const knownSkills = options?.knownSkillIds ? new Set(options.knownSkillIds) : null;
  const knownModels = options?.knownModels ? new Set(options.knownModels) : null;
  const warnings = [...blueprint.warnings];
  const agentIds: string[] = [];

  const pickSkills = (raw: string[] | undefined, owner: string): string[] => {
    const ids = raw ?? [];
    if (!knownSkills) return ids;
    const kept = ids.filter((id) => knownSkills.has(id));
    const dropped = ids.filter((id) => !knownSkills.has(id));
    if (dropped.length > 0) {
      warnings.push(`${owner}：本地未安装技能 ${dropped.join('、')}，已忽略`);
    }
    return kept;
  };

  const pickModel = (raw: string | undefined, owner: string): string | undefined => {
    if (!raw) return undefined;
    if (!knownModels) return raw;
    if (knownModels.has(raw)) return raw;
    warnings.push(`${owner}：本地没有模型预设「${raw}」，已改为跟随会话`);
    return undefined;
  };

  if (blueprint.kind === 'agent') {
    const owner = `专家「${blueprint.name}」`;
    const model = pickModel(blueprint.model, owner);
    const agent = sink.importAgent({
      name: blueprint.name,
      systemPrompt: blueprint.systemPrompt ?? '',
      skillIds: pickSkills(blueprint.skillIds, owner),
      ...(blueprint.icon ? { avatar: blueprint.icon } : {}),
      ...(model ? { model } : {}),
    });
    agentIds.push(agent.id);
    return { agentIds, warnings };
  }

  const members = blueprint.members ?? [];
  for (const member of members) {
    const agent = sink.importAgent({
      name: member.name,
      systemPrompt: member.systemPrompt,
      skillIds: pickSkills(member.skillIds, `成员「${member.name}」`),
      ...(member.avatar ? { avatar: member.avatar } : {}),
    });
    agentIds.push(agent.id);
  }

  const group = sink.createGroup({
    name: blueprint.name,
    ...(blueprint.role ? { role: blueprint.role } : {}),
    description: blueprint.description,
    memberIds: agentIds,
    mode: blueprint.mode ?? 'coordinator',
    ...(blueprint.icon ? { icon: blueprint.icon } : {}),
  });

  return { agentIds, groupId: group.id, warnings };
}

/**
 * 插件包里的专家 → 蓝图。
 *
 * 插件与 AI 是两条来源完全不同的通道，但**落地动作必须只有一条**：都走
 * `applyExpertBlueprint`，于是「技能过滤」「不改活跃专家」「成员顺序」这些规则
 * 只需要在这里之外的同一个地方维护一次。
 *
 * 单人专家用清单的 `displayName` 而不是 md 里的 `name`：后者是 kebab-case 标识
 * （`react-dev`），挂在专家卡片标题上不能给人看。团队成员则用各自的可读名。
 */
export function blueprintFromPluginExpert(pkg: PluginExpertPackage): ExpertBlueprint {
  if (pkg.expertType === 'team') {
    return {
      kind: 'team',
      name: pkg.displayName,
      description: pkg.description,
      members: pkg.agents.map((agent) => ({
        name: agent.name,
        ...(agent.profession ? { role: agent.profession } : {}),
        systemPrompt: agent.systemPrompt,
      })),
      mode: 'coordinator',
      warnings: [],
    };
  }

  const head = pkg.agents[0];
  return {
    kind: 'agent',
    name: pkg.displayName,
    ...(head?.profession ? { role: head.profession } : {}),
    description: pkg.description,
    systemPrompt: head?.systemPrompt ?? '',
    warnings: [],
  };
}
