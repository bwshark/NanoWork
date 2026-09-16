/**
 * 技能 / Expert Kit（FR-003 / FR-3.1）。
 * 技能是一段可复用的前置提示词（prompt），可在 Composer 中临时挂载到本会话，
 * 发送时按顺序拼接到 user 消息前，从而改变模型在本次回复中的行为。
 */

/** 技能来源（客户端语境：随应用发布 / 用户级目录扫描 / 本地安装 / 市场） */
export type SkillSource = 'builtin' | 'local' | 'market';

/**
 * 技能的发现层级（对齐 PRD §12.4 的优先级链：内置 < 用户级 < 项目级）。
 *
 * 与 `SkillSource` 的区别：`source` 回答「这个技能是谁给的」（市场 / 本地 / 内置），
 * `scope` 回答「它从哪个目录被扫出来的」——同一个 `local` 技能，
 * 落在 `~/.nanowork/skills` 是 `user`，落在 `<workspace>/skills` 是 `project`。
 * 后者才是决定「改了这台的技能会不会跟着仓库分发给同事」的那个维度。
 */
export type SkillScope = 'builtin' | 'user' | 'project';

/**
 * 技能三态覆盖（FR-3.1，对齐 PRD §12.2 的 `skillOverrides`）。
 *
 * 三态的差别只在「谁能让这个技能跑起来」：
 * - `on` 全可用：模型能在可用技能清单里看到它，用户也能显式挂载；
 * - `user-invocable-only` 仅手动调用：**不列给模型**（模型不知道它存在，
 *   不会自主加载），但用户显式挂载 / `$skill` 调用照常可用；
 * - `off` 停用：当它不存在，两边的入口都不给。
 *
 * 引擎侧同名字段见 `nanobot/nanobot/agent/skills.py` 的 `SKILL_OVERRIDE_*`，
 * 归一规则必须逐字一致（未知取值一律收敛为 `off`，见 `normalizeSkillOverride`）。
 */
export type SkillOverride = 'on' | 'user-invocable-only' | 'off';

export interface Skill {
  id: string;
  name: string;
  /** 能力说明 */
  description: string;
  /** 分类（用于筛选/分组） */
  category: string;
  /** 图标（emoji 或 MUI icon 名） */
  icon?: string;
  /**
   * 技能生效时注入的前置提示词。
   * 发送请求时会以 system 角色追加在 Agent systemPrompt 之后，再整体拼接到 user 消息前。
   */
  prompt: string;
  /** 技能来源 */
  source: SkillSource;
  /**
   * 当前是否启用。
   *
   * **派生字段**：恒等于 `override !== 'off'`，由 skillsStore 统一写入，
   * 不要单独赋值（两处状态会漂移）。保留它是因为消费方（会话挂载过滤、
   * 卡片灰显）只关心「能不能用」，不需要知道被限制到哪一档。
   */
  enabled: boolean;
  /**
   * 三态覆盖（**持久化的真实来源**）。
   * 老数据 / 内置定义里可能没有这个字段，此时按 `enabled` 推导，见
   * `normalizeSkillOverride` 的调用点。
   */
  override?: SkillOverride;
  /** 发现层级（目录扫描结果带此字段；内置技能定义不带） */
  scope?: SkillScope;
  /**
   * SKILL.md frontmatter 的 `allowed-tools`：该技能允许使用的工具。
   * **是真实限制而非建议**——引擎据此收窄工具面，不是写给模型看的提示。
   */
  allowedTools?: string[];
  /**
   * SKILL.md frontmatter 的 `user-invocable`（默认 true）。
   * 为 false 时该技能不出现在用户的直接调用入口（如 `/` 补全）里。
   */
  userInvocable?: boolean;
  /** 版本号 */
  version?: string;
  /** 本地技能所在目录或文件路径 */
  path?: string;
  /** 安装/扫描时间 ISO 8601 UTC */
  installedAt?: string;
}
