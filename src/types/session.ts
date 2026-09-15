import type { Message } from './message';
import type { PermissionLog } from './permission';

/** 一个会话（绑定某个 Agent，含消息流与权限决策记录） */
export interface Session {
  id: string;
  /** 绑定的 Agent id（专家团模式下为团内执行代表，完整编排依赖 nanobot 运行时 P2） */
  agentId: string;
  /** 绑定的专家团 id；召唤专家团时设置（与 agentId 绑定对称），null 表示显式解除团绑定 */
  groupId?: string | null;
  /** 本会话临时挂载的技能 id 列表 */
  skillIds?: string[];
  /** 会话级工作空间（工作目录）；未设置时归入「默认工作空间」分组 */
  workdir?: string;
  /**
   * 会话级权限策略：true = 允许完全访问（工具可在工作空间外执行）。
   * 默认 false（默认权限：操作在安全沙箱约束内进行）。
   */
  fullAccess?: boolean;
  /**
   * 会话级逐条批准（FR-1.5）：true = 副作用工具（写文件 / 执行命令 /
   * MCP 调用等）执行**前**必须由用户逐条授权，引擎会挂起等待裁决。
   *
   * 与 `fullAccess` 是正交两轴——前者管「能碰哪里」，本字段管「要不要先问」。
   * 但 `fullAccess` 是更粗的开关：开启后不再逐条询问（见 sessionsStore
   * 中 approvalMode 的推导）。
   */
  toolApproval?: boolean;
  /** 会话级模型覆盖；未设置时回退全局默认模型 */
  model?: string;
  /** 会话来源 IM 频道（如 dingtalk / feishu）；缺省为本地会话 */
  channel?: string;
  /** 只读会话（如定时任务执行留痕）：聊天页隐藏输入框，不参与持久化 */
  readonly?: boolean;
  /** 是否置顶：分组内始终排在最前，便于快速访问高频任务（持久化） */
  pinned?: boolean;
  /** 会话标题（首条消息摘要） */
  title: string;
  messages: Message[];
  /** 敏感操作权限决策记录（FR-009） */
  permissionLog: PermissionLog[];
  /**
   * 本会话创建时读取到的记忆原文快照（未包裹标签）。
   * send 时复用该快照注入 system 段，避免每次请求重复 IO。
   * 永不写回 agent.systemPrompt。
   */
  memory?: string;
  createdAt: string;
  updatedAt: string;
}
