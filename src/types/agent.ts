/**
 * 自定义 Agent 实体（FR-002）。
 * 首版单模型字符串；P2 多供应商扩展在 model 字段。
 * IM 远程控制绑定（imBinding）为 FR-010 能力：UI 层可配置平台/账号/状态，
 * 真实绑定动作依赖 nanobot 运行时（经 IM 网关），当前为本地记录 + 占位同步。
 */

import type { SyncMetaFields } from './sync';

/** 支持的 IM 平台 */
export type IMPlatform = 'wecom' | 'feishu' | 'dingtalk' | 'slack' | 'telegram' | 'other';

/** IM 绑定状态 */
export type IMBindingStatus = 'unbound' | 'online' | 'offline';

/** IM 远程控制绑定信息 */
export interface IMBinding {
  platform: IMPlatform;
  /** 平台账号 / 机器人标识 */
  account: string;
  status: IMBindingStatus;
  /** 最近一次同步时间（ISO） */
  lastSyncAt?: string;
}

/** Agent 来源。
 * - builtin：随应用发布的官方预设（不可删除，可启用切换/自定义提示词）
 * - user：用户在 Agent 管理页自定义添加的
 */
export type AgentSource = 'builtin' | 'user';

export interface Agent extends SyncMetaFields {
  id: string;
  name: string;
  /** 系统身份提示 */
  systemPrompt: string;
  /** 绑定的技能 id 列表 */
  skillIds: string[];
  /**
   * 工具白名单（FR-2.2）：省略 = 不限制；**空数组** = 一个工具都不许。
   *
   * 两者语义不同，UI 必须能表达「未设置」而不是把它落成空数组——否则用户
   * 只是没碰过这个开关，Agent 就被锁成了什么都做不了。
   */
  toolAllow?: string[];
  /** 工具黑名单（FR-2.2）：优先级高于 `toolAllow` */
  toolDeny?: string[];
  /**
   * 领域模板覆盖（§13.1 / §13.4「同一模式可挂多套领域模板，**按 Agent 选择**」）。
   *
   * 省略 = 用全局设置 `Settings.promptDomain`。与 `toolAllow` 同理：字段的
   * **存在性**有意义，不要用 `?? 'general'` 把它填成确定值——那会抹掉
   * 「跟随全局」这个状态，全局改了它也不动。
   */
  promptDomain?: string;
  /** 风格模板覆盖（§13.1 语气风格）；省略 = 用全局设置 `Settings.promptStyle` */
  promptStyle?: string;
  /**
   * 模型绑定（FR-2.3）：专家自带模型，省得每次召唤都再选一遍。
   *
   * 存的是**预设名**（`modelsStore` 下拉项的 `id`），与 `Session.model` 同一个取值域
   * —— 两者同源才能比较、才能回落，否则会变成「专家绑的是模型名、会话存的是预设名」
   * 这种看起来都对、实现里永远对不上的两套坐标。
   *
   * 省略 = 不绑定（跟随会话选择，会话也没选则用网关默认）。
   *
   * ⚠️ **下发前必须校验预设仍存在**（见 `lib/agentBinding.ts` 的 `resolveTurnModel`）：
   * 预设被删或改名后这个字符串就失效了，而引擎收到未知预设会直接报错——
   * 不拦的话，「删掉一个预设」会变成「所有绑过它的专家每一轮都发不出消息」。
   */
  model?: string;
  /** IM 远程控制绑定（FR-010）；null 表示未绑定 */
  imBinding: IMBinding | null;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间 ISO 8601 UTC */
  createdAt: string;
  /** 来源（builtin/user）；老数据无此字段时按 'user' 处理 */
  source?: AgentSource;
  /**
   * 头像：可以是 emoji 字符（如 "🌱"）或图片 URL/dataURL。
   * 未设置时用 name[0] 派生，背景色由 name 哈希到固定色相——保证同一名字稳定同色。
   * 仅自定义 Agent 支持设置；内置 Agent 始终走派生占位（mergeAgents 不消费此字段）。
   */
  avatar?: string;
}

/**
 * 内置 Agent 的稳定 id 前缀，便于与用户条目区分、序列化兼容。
 * 用户自定义条目则使用 genId() 生成的随机 id。
 */
export const BUILTIN_AGENT_PREFIX = 'builtin:' as const;

/** 内置 Agent id 是否命中 builtin 前缀 */
export function isBuiltinAgentId(id: string): boolean {
  return id.startsWith(BUILTIN_AGENT_PREFIX);
}
