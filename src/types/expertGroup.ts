/**
 * 专家团（Expert Group）。
 * 把多个 Agent 编排成一个组合：可用于顺序流水线（每个 Agent 接上一步的产物）、
 * 并行专家团（同时跑多 Agent 取最优）或主从协调（一个协调 Agent 调度若干专家 Agent）。
 *
 * 内置专家团（source='builtin'）随应用发布，用户可在 UI 上启用停用、调整成员顺序；
 * 用户自定义专家团（source='user'）可任意编辑、删除。
 *
 * 真实调度 / 多 Agent 编排依赖 nanobot 运行时能力（P2）；
 * 当前 store 只负责持久化与 UI 展示，可由编排面板选择专家团启动会话。
 */

import type { SyncMetaFields } from './sync';

/** 协作模式 */
export type ExpertGroupMode = 'sequential' | 'parallel' | 'coordinator';

/** 协作模式展示标签 */
export const EXPERT_GROUP_MODE_LABEL: Record<ExpertGroupMode, string> = {
  sequential: '顺序流水线',
  parallel: '并行会诊',
  coordinator: '主从协调',
};

/** 协作模式简介，hover 信息使用（描述的是**该模式的语义**，不是「现在会生效」） */
export const EXPERT_GROUP_MODE_DESC: Record<ExpertGroupMode, string> = {
  sequential: '按成员顺序逐个执行，前者结果作为后者输入。',
  parallel: '并行召唤所有成员，整合多视角结论。',
  coordinator: '由首位成员担任协调 Agent，调度其余成员协作。',
};

/**
 * FR-2.4 现状说明：协作模式**当前只保存配置，不改变执行结果**。
 *
 * 原因（2026-10-05 勘查）：引擎没有「按具名成员编排」的能力 —— 它只有**匿名子代理**
 * （`SubagentManager` / `spawn`，system prompt 固定来自 `subagent_system.md`，与团成员
 * 无关联），而 `agent_id` 在引擎侧**只用于工具策略**、不是人设路由。所以无论选哪一档，
 * 一轮对话始终由**团内首位启用成员**完成。
 *
 * ⚠️ 必须显示给用户：`EXPERT_GROUP_MODE_DESC` 里那三句是**将来时**的语义描述，
 * 光看它用户会以为选了就会生效 —— 这与「声明一个不生效的档位」是同一类坑
 * （参见投递档位 `milestone` 的处理）。
 *
 * 文案收在这一个常量里、由两个编辑表单共用：说明性文本一旦散成两份，
 * 一处改了另一处不改，用户会在两个页面看到互相矛盾的说法。
 */
export const EXPERT_GROUP_MODE_NOT_EFFECTIVE_NOTICE =
  '协作模式当前只保存配置，不改变执行结果 —— 一轮对话始终由团内首位启用成员完成（引擎尚未支持按具名成员编排）。';

/** 专家团来源 */
export type ExpertGroupSource = 'builtin' | 'user';

export interface ExpertGroup extends SyncMetaFields {
  id: string;
  /** 专家团名（卡片标题） */
  name: string;
  /** 副标题/角色，缩在标题下方一行 */
  role?: string;
  /** 详细描述 */
  description: string;
  /** 引用的成员 Agent id 列表（不限定 builtin/user） */
  memberIds: string[];
  /** 协作模式 */
  mode: ExpertGroupMode;
  /** 图标：emoji（如 '🧩'）或图片 URL/dataURL；缺省由 name 派生 */
  icon?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间 ISO 8601 UTC */
  createdAt: string;
  /** 来源（builtin/user）；老数据无此字段时按 'user' 处理 */
  source?: ExpertGroupSource;
}

/**
 * 内置专家团稳定 id 前缀，便于与用户条目区分、序列化兼容。
 * 用户自定义条目使用 genId() 生成的随机 id。
 */
export const BUILTIN_GROUP_PREFIX = 'builtingroup:' as const;

/** 内置专家团 id 是否命中 builtin 前缀 */
export function isBuiltinGroupId(id: string): boolean {
  return id.startsWith(BUILTIN_GROUP_PREFIX);
}
