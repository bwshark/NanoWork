/**
 * 专家包的生成、解析与导入对账（FR-3.3）。
 *
 * 三个函数各管一段，**互不依赖**（build 不知道 store、parse 不碰磁盘、plan 不发请求），
 * 这样每条反直觉的边界都能被单测直接钉住：
 *
 * - `buildExpertPackage`：本地实体 → 包（剔除超限头像，绝不让导出失败）
 * - `parseExpertPackage`：不可信文本 → 包（分类报错，供界面给不同指引）
 * - `planExpertImport`：包 + 本机现状 → 落地草稿（重名改名、缺技能放行、缺模型丢弃）
 */

import type { Agent } from '@/types';
import {
  EXPERT_PACKAGE_FILE_SUFFIX,
  EXPERT_PACKAGE_MAX_AVATAR_CHARS,
  EXPERT_PACKAGE_SCHEMA,
  type ExpertAgentDraft,
  type ExpertImportPlan,
  type ExpertPackage,
  type ExpertPackageAgent,
  type ExpertPackageParseResult,
  type ExpertPackageSkillRef,
} from '@/types/expertPackage';

/** 默认包版本。用户没有「版本」这个概念，所以不放进编辑表单，只在重导出时沿用。 */
export const DEFAULT_EXPERT_PACKAGE_VERSION = '1.0.0';

/**
 * 从专家名派生 slug（导出文件名主干）。
 *
 * 只去掉文件系统与 URL 里真的会出问题的字符，**中文原样保留**——把「前端架构师」
 * 音译成 `frontend-architect` 需要词典，而文件名是给人看的，不是给程序解析的。
 */
export function expertPackageSlug(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'expert';
}

/** 导出文件名。 */
export function expertPackageFileName(name: string): string {
  return `${expertPackageSlug(name)}${EXPERT_PACKAGE_FILE_SUFFIX}`;
}

/** 头像是否超过载荷上限（按字符数算：JSON 里就是这些字符）。 */
function avatarOversized(avatar: string | undefined): boolean {
  return typeof avatar === 'string' && avatar.length > EXPERT_PACKAGE_MAX_AVATAR_CHARS;
}

/** 复制一份可选字符串数组：**空数组必须原样保留**（语义是「一个都不许」）。 */
function copyOptionalList(list: string[] | undefined): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.filter((v): v is string => typeof v === 'string');
}

/** 可选字符串字段：空串与缺省同义（对齐 `resolveTurnModel` 的取值约定）。 */
function optionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? value : undefined;
}

export interface BuildExpertPackageResult {
  pkg: ExpertPackage;
  /** 非致命问题（目前只有头像超限）。界面对导出也要提示，否则用户以为头像跟着走了 */
  warnings: string[];
}

/**
 * 本地专家 → 专家包。
 *
 * 内置专家（`source === 'builtin'`）也允许导出：它的提示词可能与代码版本不同
 * （用户改过），导出正是「把这个改动带走」的手段。是否给入口由 UI 决定，这里不管。
 */
export function buildExpertPackage(
  agent: Agent,
  skillNameOf: (id: string) => string,
  opts?: { version?: string; description?: string },
): BuildExpertPackageResult {
  const warnings: string[] = [];
  const skills: ExpertPackageSkillRef[] = (agent.skillIds ?? [])
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => ({ id, name: skillNameOf(id) || id }));

  let avatar = optionalText(agent.avatar);
  if (avatar && avatarOversized(avatar)) {
    // 宁可不带头像也不让导出失败：包是给人转发的，超限 base64 会把包变成几百 KB
    warnings.push(
      `头像超过 ${Math.round(EXPERT_PACKAGE_MAX_AVATAR_CHARS / 1024)}K 字符上限，已从包中剔除`,
    );
    avatar = undefined;
  }

  const payload: ExpertPackageAgent = {
    name: agent.name,
    systemPrompt: agent.systemPrompt ?? '',
    ...(avatar ? { avatar } : {}),
    ...(agent.toolAllow ? { toolAllow: copyOptionalList(agent.toolAllow) } : {}),
    ...(agent.toolDeny ? { toolDeny: copyOptionalList(agent.toolDeny) } : {}),
    ...(optionalText(agent.promptDomain) ? { promptDomain: agent.promptDomain } : {}),
    ...(optionalText(agent.promptStyle) ? { promptStyle: agent.promptStyle } : {}),
    ...(optionalText(agent.model) ? { model: agent.model } : {}),
  };

  return {
    pkg: {
      schema: EXPERT_PACKAGE_SCHEMA,
      slug: expertPackageSlug(agent.name),
      version: opts?.version?.trim() || DEFAULT_EXPERT_PACKAGE_VERSION,
      description: opts?.description ?? '',
      expertType: 'agent',
      skills,
      agent: payload,
      exportedAt: new Date().toISOString(),
    },
    warnings,
  };
}

/** 包 → 文本。2 空格缩进：这个文件是给人看、给 diff 看的。 */
export function serializeExpertPackage(pkg: ExpertPackage): string {
  return JSON.stringify(pkg, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * 不可信文本 → 包。
 *
 * 严格度取舍：**必填字段错一个字就拒**（`name` / `systemPrompt` / `skills` / `agent`），
 * 可选字段错了就丢（并在 warnings 里说）。理由是导入是「别人给的东西进我的机器」，
 * 半懂不懂地猜比明确拒绝更危险；但可选字段（比如一个奇怪的 `promptDomain`）不值得
 * 让整份配置作废。
 */
export function parseExpertPackage(text: string): ExpertPackageParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      kind: 'not-json',
      error: '文件内容不是合法 JSON，确认选的是导出的专家包文件',
    };
  }

  if (!isRecord(raw)) {
    return { ok: false, kind: 'not-object', error: '专家包根节点必须是一个对象' };
  }

  if (raw.schema !== EXPERT_PACKAGE_SCHEMA) {
    return {
      ok: false,
      kind: 'schema-mismatch',
      error: `不是本版本支持的专家包（需要 ${EXPERT_PACKAGE_SCHEMA}，实际 ${
        typeof raw.schema === 'string' ? raw.schema : '缺失'
      }）`,
    };
  }

  if (raw.expertType !== 'agent') {
    // 团队包要带 memberAgents 的互相引用，本期没做——明确拒绝，不按个体硬导
    return {
      ok: false,
      kind: raw.expertType === 'team' ? 'unsupported-expert-type' : 'invalid-field',
      error:
        raw.expertType === 'team'
          ? '团队专家包暂不支持导入（本期只支持单个专家）'
          : '专家包的 expertType 必须是 agent',
    };
  }

  if (!isRecord(raw.agent)) {
    return { ok: false, kind: 'missing-field', error: '专家包缺少 agent 段' };
  }
  const agentRaw = raw.agent;

  if (typeof agentRaw.name !== 'string' || !agentRaw.name.trim()) {
    return { ok: false, kind: 'missing-field', error: '专家包缺少专家名（agent.name）' };
  }
  if (typeof agentRaw.systemPrompt !== 'string') {
    return {
      ok: false,
      kind: 'missing-field',
      error: '专家包缺少初始提示词（agent.systemPrompt）',
    };
  }

  if (!Array.isArray(raw.skills)) {
    return { ok: false, kind: 'missing-field', error: '专家包缺少技能清单（skills）' };
  }
  const skills: ExpertPackageSkillRef[] = [];
  const warnings: string[] = [];
  for (const item of raw.skills) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()) {
      // 单条坏引用不废整包：技能引用是「多绑一个少绑一个」的粒度
      warnings.push('包内有一条技能引用格式不正确，已忽略');
      continue;
    }
    skills.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : item.id,
    });
  }

  const agent: ExpertPackageAgent = {
    name: agentRaw.name,
    systemPrompt: agentRaw.systemPrompt,
  };

  if (agentRaw.avatar !== undefined) {
    if (typeof agentRaw.avatar === 'string' && agentRaw.avatar.trim()) {
      if (avatarOversized(agentRaw.avatar)) {
        warnings.push(
          `头像超过 ${Math.round(EXPERT_PACKAGE_MAX_AVATAR_CHARS / 1024)}K 字符上限，已忽略`,
        );
      } else {
        agent.avatar = agentRaw.avatar;
      }
    } else {
      warnings.push('包内头像字段格式不正确，已忽略');
    }
  }

  for (const key of ['toolAllow', 'toolDeny'] as const) {
    const value = agentRaw[key];
    if (value === undefined) continue;
    if (isStringList(value)) agent[key] = value;
    else warnings.push(`包内 ${key} 不是字符串数组，已忽略`);
  }

  for (const key of ['promptDomain', 'promptStyle', 'model'] as const) {
    const value = agentRaw[key];
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim()) agent[key] = value;
    else warnings.push(`包内 ${key} 不是有效字符串，已忽略`);
  }

  const pkg: ExpertPackage = {
    schema: EXPERT_PACKAGE_SCHEMA,
    slug:
      typeof raw.slug === 'string' && raw.slug.trim()
        ? raw.slug
        : expertPackageSlug(agent.name),
    version:
      typeof raw.version === 'string' && raw.version.trim()
        ? raw.version
        : DEFAULT_EXPERT_PACKAGE_VERSION,
    description: typeof raw.description === 'string' ? raw.description : '',
    expertType: 'agent',
    skills,
    agent,
    ...(typeof raw.exportedAt === 'string' ? { exportedAt: raw.exportedAt } : {}),
  };

  return { ok: true, pkg, warnings };
}

export interface ExpertImportContext {
  /** 本机已有专家名（含内置）。重名会加后缀，不覆盖、不合并 */
  existingNames: Iterable<string>;
  /** 本机可用技能 id */
  skillIds: Iterable<string>;
  /**
   * 本机可用模型预设 id。
   *
   * **省略或空集 = 目录还没加载**，此时按「预设有效」放行。这与
   * `lib/agentBinding.ts` 的同一条教训一致：拿空集当「全都失效」会让冷启动第一轮
   * 静默丢掉用户的配置，而且只有第一轮。
   */
  presetIds?: Iterable<string>;
}

/** 名字归一：去空白 + 小写。中文没有大小写，但英文名要能识别 `Foo` ≡ `foo`。 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** 重名时依次尝试「（导入）」「（导入 2）」……上限之后退回带时间戳的名字。 */
function uniqueExpertName(base: string, taken: Set<string>): { name: string; renamed: boolean } {
  if (!taken.has(normalizeName(base))) return { name: base, renamed: false };
  const withTag = `${base}（导入）`;
  if (!taken.has(normalizeName(withTag))) return { name: withTag, renamed: true };
  for (let i = 2; i <= 50; i += 1) {
    const candidate = `${base}（导入 ${i}）`;
    if (!taken.has(normalizeName(candidate))) return { name: candidate, renamed: true };
  }
  return { name: `${base}（导入 ${Date.now()}）`, renamed: true };
}

/**
 * 包 + 本机现状 → 落地草稿。
 *
 * 三条边界，每条都反直觉：
 * 1. **缺技能不阻塞**：一个专家换台机器就装不进来，比少两个技能糟糕得多；
 * 2. **缺模型要丢弃**：预设名失效会让引擎报错，之后每一轮都发不出消息
 *    （`types/agent.ts` 的 `model` 注释写明了这条）；
 * 3. **`toolAllow: []` 原样保留**：空数组是「一个工具都不许」，与「没设置」不同。
 *    用 `?? undefined` 处理会把它变成「不限制」——把最严的配置变成最松的。
 */
export function planExpertImport(
  pkg: ExpertPackage,
  ctx: ExpertImportContext,
): ExpertImportPlan {
  const taken = new Set<string>();
  for (const name of ctx.existingNames) taken.add(normalizeName(name));
  const { name, renamed } = uniqueExpertName(pkg.agent.name, taken);

  const localSkills = new Set(ctx.skillIds);
  const boundSkillIds: string[] = [];
  const missingSkills: ExpertPackageSkillRef[] = [];
  for (const ref of pkg.skills) {
    if (localSkills.has(ref.id)) boundSkillIds.push(ref.id);
    else missingSkills.push(ref);
  }

  let model = pkg.agent.model;
  let missingModel: string | undefined;
  if (model) {
    const presets = ctx.presetIds ? new Set(ctx.presetIds) : new Set<string>();
    if (presets.size > 0 && !presets.has(model)) {
      missingModel = model;
      model = undefined;
    }
  }

  const draft: ExpertAgentDraft = {
    name,
    systemPrompt: pkg.agent.systemPrompt,
    skillIds: boundSkillIds,
  };
  if (pkg.agent.avatar) draft.avatar = pkg.agent.avatar;
  // 空数组必须原样带过去：见上面第 3 条
  if (pkg.agent.toolAllow !== undefined) draft.toolAllow = [...pkg.agent.toolAllow];
  if (pkg.agent.toolDeny !== undefined) draft.toolDeny = [...pkg.agent.toolDeny];
  if (pkg.agent.promptDomain) draft.promptDomain = pkg.agent.promptDomain;
  if (pkg.agent.promptStyle) draft.promptStyle = pkg.agent.promptStyle;
  if (model) draft.model = model;

  return {
    pkg,
    name,
    renamed,
    missingSkills,
    ...(missingModel ? { missingModel } : {}),
    draft,
  };
}
