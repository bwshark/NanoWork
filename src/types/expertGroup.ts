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

/** 协作模式 */
export type ExpertGroupMode = 'sequential' | 'parallel' | 'coordinator';

/** 协作模式展示标签 */
export const EXPERT_GROUP_MODE_LABEL: Record<ExpertGroupMode, string> = {
  sequential: '顺序流水线',
  parallel: '并行会诊',
  coordinator: '主从协调',
};

/** 协作模式简介，hover 信息使用 */
export const EXPERT_GROUP_MODE_DESC: Record<ExpertGroupMode, string> = {
  sequential: '按成员顺序逐个执行，前者结果作为后者输入。',
  parallel: '并行召唤所有成员，整合多视角结论。',
  coordinator: '由首位成员担任协调 Agent，调度其余成员协作。',
};

/** 专家团来源 */
export type ExpertGroupSource = 'builtin' | 'user';

export interface ExpertGroup {
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
