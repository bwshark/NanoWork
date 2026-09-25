import type { SyncMeta } from './sync';

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

/**
 * 可同步的技能覆盖表条目（`skillId` → 用户意图 + 同步元数据）。
 *
 * ## 为什么技能**不**整体加 `SyncMeta`（与 Agent / Task / MCP 的区别）
 *
 * `skillsStore` 的 `skills` 数组混着两种东西：
 * - **事实**：从 `~/.nanowork/skills` 与 `<workspace>/skills` 扫出来的清单
 *   （正文、`path`、`installedAt`…）——由磁盘决定，多端自然一致。同步它等于把
 *   「扫描结果」当可变实体，还会把 `path` 这个**机器专属字段**带上云（FR-10.5 禁止）。
 * - **用户意图**：三态覆盖与置顶——**这个才是要同步的**。
 *
 * 所以覆盖态抽成这张独立表：技能正文继续由各设备的磁盘决定，跨端只传「用户把它
 * 调成了哪一档、有没有置顶」。见 `docs/architecture-syncmeta.md` §3.2。
 *
 * **覆盖表条目不做墓碑**：把一条覆盖「删掉」的语义是「回到默认档 `on`」，那是值的
 * 变化而不是删除，直接移除条目即可。`deletedAt` 随 `SyncMeta` 一起带上是类型统一的
 * 结果，恒为 `null`。
 */
export interface SkillOverrideEntry extends SyncMeta {
  skillId: string;
  override: SkillOverride;
  /** 是否置顶（只影响「我安装的」列表顺序，不推引擎） */
  pinned: boolean;
}

/**
 * 技能实体本身。
 *
 * ⚠️ **刻意不 `extends SyncMetaFields`**：技能正文是磁盘扫描的产物、不是可变实体，
 * 用户意图由 `SkillOverrideEntry` 承载。给这里加同步元数据会让「同步扫描结果」
 * 看起来是刻意的设计（详见 `SkillOverrideEntry` 的注释）。
 */
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
