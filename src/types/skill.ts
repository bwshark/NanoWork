/**
 * 技能 / Expert Kit（FR-003）。
 * 技能是一段可复用的前置提示词（prompt），可在 Composer 中临时挂载到本会话，
 * 发送时按顺序拼接到 user 消息前，从而改变模型在本次回复中的行为。
 */

/** 技能来源 */
export type SkillSource = 'builtin' | 'local' | 'market';

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
  /** 当前是否启用 */
  enabled: boolean;
  /** 版本号 */
  version?: string;
  /** 本地技能所在目录或文件路径 */
  path?: string;
  /** 安装/扫描时间 ISO 8601 UTC */
  installedAt?: string;
}
