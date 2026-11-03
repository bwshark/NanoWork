/**
 * 组织资产（FR-2.6）的**载荷转换**：本地实体 ↔ 云端快照。
 *
 * ## 两条方向，纪律完全不同
 *
 * **上传方向（`*Payload`）是白名单构造**：逐个字段挑出来，而不是「删掉几个敏感字段」。
 * 黑名单式的 `{...agent, path: undefined}` 会在下次给 `Agent` 加字段时静默泄露——
 * 而那正是最不容易被 review 到的时刻。服务端还有一道 `path` / `imBinding` 的拒绝
 * （`cloud/app/orgassets/routes.py`），这是第二道闸：漏剥的客户端应当**报错**，
 * 而不是悄悄把别人机器上的路径写进组织库。
 *
 * **落地方向（`*FromOrgAsset`）要防的是「脏数据」**——载荷是自由 JSON，任何字段都
 * 可能是错的类型。所以每个字段都过一遍类型判断，坏值按缺省处理；宁可导入一个
 * 少了模型的专家，也不要让一次点击把整页炸掉。
 *
 * ## 三个「必须原样保留」的字段
 *
 * 1. `toolAllow` / `toolDeny` 的**存在性**：空数组 = 一个工具都不许，省略 = 不限制。
 *    用 `?? undefined` / `?? []` 归一化会把最严的配置变成最松的（FR-2.2）。
 * 2. 专家的 `model` 只有在**本机确实有这个预设**时才带过来：失效的预设名会让引擎
 *    每轮报错（见 `types/agent.ts` 的 `model` 注释）。
 * 3. 技能的 `prompt` 正文逐字不动：那是这个技能的全部价值。
 *
 * ## 刻意**不**上传的三样
 *
 * `path`（别人机器上的路径）、`imBinding`（别人账号的机器人绑定）、`knowledge`
 * （绑定的是发布者所在组织的库 id，换组织就指不到东西）。丢掉它们不是妥协：
 * 带上任何一个，导入方都会得到一个「看起来配好了、实际指不到」的坏配置。
 */

import type { Agent, PromptSlotState, Skill } from '@/types';
import type {
  OrgAgentPayload,
  OrgAsset,
  OrgAssetKind,
  OrgPromptPayload,
  OrgSkillPayload,
} from '@/types/orgAsset';
import { orgAssetLocalId, ORG_ASSET_KIND_LABEL } from '@/types/orgAsset';
import { isBuiltinAgentId } from '@/types/agent';
import { dedupeExpertName } from '@/lib/agent/expertPackage';

/** 读一个字符串字段，坏值返回 `undefined`（不抛、不猜）。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 读一个字符串数组：过滤掉非字符串项；不是数组就返回 `undefined`。 */
function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string' && item !== '');
  return out;
}

/* ------------------------------------------------------------------ *
 * 上传方向：本地实体 → 载荷
 * ------------------------------------------------------------------ */

/** 专家 → 载荷。 */
export function agentPayload(agent: Agent): OrgAgentPayload {
  const payload: OrgAgentPayload = {
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    // 技能 id 是**引用**不是内容：导入端按「本地没有就忽略」处理（见 landAgent）。
    // 这里原样带上，否则导入后得手动一个个重新勾技能
    skillIds: [...agent.skillIds],
  };
  // ⚠️ 只判 `!== undefined`：空数组必须原样带上（它是「一个工具都不许」）
  if (agent.toolAllow !== undefined) payload.toolAllow = [...agent.toolAllow];
  if (agent.toolDeny !== undefined) payload.toolDeny = [...agent.toolDeny];
  if (agent.promptDomain !== undefined) payload.promptDomain = agent.promptDomain;
  if (agent.promptStyle !== undefined) payload.promptStyle = agent.promptStyle;
  if (agent.model) payload.model = agent.model;
  // data: URL 不上云：一张头像能把 64KiB 的载荷上限吃掉大半，而它只是张图
  if (agent.avatar && !agent.avatar.startsWith('data:')) payload.avatar = agent.avatar;
  return payload;
}

/** 技能 → 载荷。`path` / `installedAt` / `scope` 全部剥掉（机器专属）。 */
export function skillPayload(skill: Skill): OrgSkillPayload {
  const payload: OrgSkillPayload = {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    prompt: skill.prompt,
  };
  if (skill.icon) payload.icon = skill.icon;
  // 空数组也要带：`allowedTools: []` 是「这个技能一个工具都不许用」
  if (skill.allowedTools !== undefined) payload.allowedTools = [...skill.allowedTools];
  if (skill.version) payload.version = skill.version;
  if (skill.userInvocable !== undefined) payload.userInvocable = skill.userInvocable;
  return payload;
}

/**
 * 提示词槽位 → 载荷。
 *
 * 取 `override ?? builtin`：**只有自定义过的槽位值得发布**（发布内置默认等于把出厂
 * 内容抄一份进组织库，看起来像模板、实际谁都有）。界面据此只列 `override !== null`
 * 的槽位，这里的取法只是兜底。
 */
export function promptPayload(state: PromptSlotState): OrgPromptPayload {
  return {
    kind: state.slot.kind,
    key: state.slot.key,
    text: state.override ?? state.slot.builtin,
  };
}

/* ------------------------------------------------------------------ *
 * 发布候选与草稿（把「页面上选谁、发什么」这段判据抽出来）
 * ------------------------------------------------------------------ */

/** 本机可选来源（页面的三个 store 快照）。 */
export interface PublishSource {
  agents: readonly Agent[];
  skills: readonly Skill[];
  /** 提示词槽位状态（`PromptLibrary.statesSync()` 的产物） */
  promptStates: readonly PromptSlotState[];
}

/** 可发布的一条候选（下拉项）。 */
export interface PublishCandidate {
  id: string;
  name: string;
}

/**
 * 某一种类下「可以发布哪些」。
 *
 * 三条排除规则，理由各不相同：
 * - **内置专家**：随应用发布，人手一份，发到组织里只是噪音；
 * - **内置技能**：同上（`source === 'builtin'`）；项目级技能来自工作区目录，
 *   发布它也意味着把「某个仓库里的约定」变成全员默认，不是一个人能决定的事；
 * - **未自定义的提示词槽位**：发布它等于把出厂默认抄一份进组织库，看起来像模板、
 *   实际谁都有（`promptPayload` 注释有同一条）。
 */
export function publishCandidates(
  kind: OrgAssetKind,
  source: PublishSource,
): PublishCandidate[] {
  if (kind === 'agent') {
    return source.agents
      .filter((agent) => !isBuiltinAgentId(agent.id))
      .map((agent) => ({ id: agent.id, name: agent.name }));
  }
  if (kind === 'skill') {
    return source.skills
      .filter((skill) => skill.source !== 'builtin')
      .map((skill) => ({ id: skill.id, name: skill.name }));
  }
  return source.promptStates
    .filter((state) => state.override !== null)
    .map((state) => ({
      id: `${state.slot.kind}.${state.slot.key}`,
      name: `${state.slot.label}（${state.slot.kind}.${state.slot.key}）`,
    }));
}

/** 发布用的草稿：名称、说明与**已经剥干净的**载荷。 */
export interface PublishDraft {
  name: string;
  description: string;
  payload: Record<string, unknown>;
}

/**
 * 候选 id → 发布草稿。选不到（被删 / 换了种类）返回 `null`，由界面提示。
 *
 * 说明字段的处理：专家没有 `description`，取系统提示词首行——那是用户自己写的一句话
 * 定位，比自己再编一句准确。技能用 `description`，提示词用槽位的说明。
 */
export function publishDraft(
  kind: OrgAssetKind,
  id: string,
  source: PublishSource,
): PublishDraft | null {
  if (kind === 'agent') {
    const agent = source.agents.find((item) => item.id === id);
    if (!agent) return null;
    return {
      name: agent.name,
      description: agent.systemPrompt.split('\n')[0]?.slice(0, 120) ?? '',
      payload: agentPayload(agent) as unknown as Record<string, unknown>,
    };
  }
  if (kind === 'skill') {
    const skill = source.skills.find((item) => item.id === id);
    if (!skill) return null;
    return {
      name: skill.name,
      description: skill.description,
      payload: skillPayload(skill) as unknown as Record<string, unknown>,
    };
  }
  const state = source.promptStates.find(
    (item) => `${item.slot.kind}.${item.slot.key}` === id,
  );
  if (!state) return null;
  return {
    name: `${ORG_ASSET_KIND_LABEL.prompt}·${state.slot.label}`,
    description: state.slot.description,
    payload: promptPayload(state) as unknown as Record<string, unknown>,
  };
}

/* ------------------------------------------------------------------ *
 * 落地方向：载荷 → 本地实体
 * ------------------------------------------------------------------ */

/** `landAgent` 的依赖：本机现状（用于过滤失效引用）。 */
export interface OrgImportContext {
  /** 本机已有专家名（含内置）。重名会加后缀 —— 与专家包导入同一条规则 */
  existingNames?: Iterable<string>;
  /** 本机可用技能 id。**省略 = 不校验**（目录还没加载时不能当「全都失效」） */
  knownSkillIds?: Iterable<string>;
  /** 本机模型预设 id。**省略或空集 = 不校验**（同 `planExpertImport`） */
  knownPresetIds?: Iterable<string>;
}

export interface LandedAgent {
  /** 直接喂给 `agentsStore.importAgent`（它负责生成 id、落库与记账） */
  draft: Partial<Agent>;
  /** 降级说明（缺技能 / 缺模型 / 重名），界面要显示出来，不能静默 */
  warnings: string[];
}

/**
 * 专家载荷 → 可落地的草稿。
 *
 * 三条降级规则与专家包导入（`planExpertImport`）逐条一致，理由也一样：缺技能不阻塞、
 * 缺模型要丢弃、`toolAllow: []` 原样保留。命名规则直接复用 `dedupeExpertName`，
 * 不另写一份。
 */
export function landAgent(asset: OrgAsset, ctx: OrgImportContext = {}): LandedAgent {
  const p = asset.payload as Partial<OrgAgentPayload>;
  const warnings: string[] = [];
  const base = (str(p.name) ?? asset.name).trim() || asset.name;

  const { name, renamed } = dedupeExpertName(base, ctx.existingNames ?? []);
  if (renamed) warnings.push(`本机已有同名专家，导入为「${name}」`);

  let skillIds = strArray(p.skillIds) ?? [];
  if (ctx.knownSkillIds) {
    const known = new Set(ctx.knownSkillIds);
    const dropped = skillIds.filter((id) => !known.has(id));
    if (dropped.length > 0) {
      skillIds = skillIds.filter((id) => known.has(id));
      warnings.push(`本地未安装技能 ${dropped.join('、')}，已忽略`);
    }
  }

  let model = str(p.model);
  if (model) {
    const presets = new Set(ctx.knownPresetIds ?? []);
    if (presets.size > 0 && !presets.has(model)) {
      warnings.push(`本地没有模型预设「${model}」，已改为跟随会话`);
      model = undefined;
    }
  }

  const draft: Partial<Agent> = {
    name,
    systemPrompt: str(p.systemPrompt) ?? '',
    skillIds,
  };
  // ⚠️ 存在性有语义：空数组必须落成空数组
  const allow = strArray(p.toolAllow);
  if (allow !== undefined) draft.toolAllow = allow;
  const deny = strArray(p.toolDeny);
  if (deny !== undefined) draft.toolDeny = deny;
  const domain = str(p.promptDomain);
  if (domain !== undefined) draft.promptDomain = domain;
  const style = str(p.promptStyle);
  if (style !== undefined) draft.promptStyle = style;
  if (model) draft.model = model;
  const avatar = str(p.avatar);
  if (avatar) draft.avatar = avatar;
  return { draft, warnings };
}

/**
 * 技能载荷 → 技能实体。
 *
 * id 用 `org:<资产 id>`：`skillsStore.installSkill` 按 id 覆盖，于是「同一条资产导入
 * 两次」是更新而不是装出两个同名技能——与专家（每次都是新的一份）刻意不同：
 * 技能是「装上/卸下」型资产，专家是可编辑的个人副本。
 */
export function landSkill(asset: OrgAsset): Skill {
  const p = asset.payload as Partial<OrgSkillPayload>;
  const skill: Skill = {
    id: orgAssetLocalId(asset.id),
    name: (str(p.name) ?? asset.name).trim() || asset.name,
    description: str(p.description) ?? asset.description,
    category: str(p.category) ?? '组织资产',
    prompt: str(p.prompt) ?? '',
    // `market` = 「不是随包发布、也不是本机目录扫出来的」，正是组织下发这一来源
    source: 'market',
    enabled: true,
    override: 'on',
  };
  const icon = str(p.icon);
  if (icon) skill.icon = icon;
  const tools = strArray(p.allowedTools);
  if (tools !== undefined) skill.allowedTools = tools;
  const version = str(p.version);
  if (version) skill.version = version;
  if (typeof p.userInvocable === 'boolean') skill.userInvocable = p.userInvocable;
  return skill;
}

/** 提示词槽位种类闭集（与 `types/prompt.ts` 的三个维度一致，导入前必须校验）。 */
const PROMPT_KINDS = ['mode', 'domain', 'style'] as const;

/**
 * 提示词载荷 → 可直接喂给 `PromptLibrary.save` 的三元组；形状不对返回 `null`。
 *
 * 返回 `null` 而不是抛错：这是「这条资产坏了」，界面提示一句即可，不该让整页崩掉。
 * 槽位是否存在（`domain.code` 之类）由调用方用 `findSlot` 再判一次 —— 那是提示词
 * 目录的能力，不属于本模块。
 */
export function landPrompt(asset: OrgAsset): OrgPromptPayload | null {
  const p = asset.payload as Partial<OrgPromptPayload>;
  const kind = p.kind;
  const key = str(p.key)?.trim() ?? '';
  const text = str(p.text) ?? '';
  if (!kind || !(PROMPT_KINDS as readonly string[]).includes(kind)) return null;
  if (!key || text.trim() === '') return null;
  return { kind, key, text };
}
