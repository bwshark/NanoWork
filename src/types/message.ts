import type { Artifact } from './artifact';
import type { PlanStep } from './event';
import type { ProcessEvent } from './process';
import type { ToolCall } from './toolcall';

/** 消息角色 */
export type Role = 'user' | 'assistant' | 'tool';

/** 计划裁决结果（与 plan-decision 事件的 `decision` 同源） */
export type PlanVerdict = 'approved' | 'rejected';

/**
 * 消息上挂载的计划（FR-1.5）。
 *
 * 由 Plan 模式的 `submit_plan` 产出（`plan` 事件），用户裁决落在
 * `plan-decision` 事件上——二者配合，计划随会话重载后可原样回显，
 * 而不是刷新就消失的临时 UI 态。
 */
export interface MessagePlan {
  planId: string;
  steps: PlanStep[];
  /** pending=待裁决 / approved=已批准 / rejected=已打回 */
  status: PlanVerdict | 'pending';
  /** 打回理由（仅 rejected 时有意义） */
  reason?: string;
  /**
   * 批准范围：被勾选步骤的 id。
   *
   * **缺省 = 全批准**，`[]` = 一项都没勾（合法的「批准了一份空范围」）。
   * 这个「缺值与空值不同义」的约定源自 `PlanDecisionEvent`，视图层不得擅自
   * 把它归一化成数组——否则「全批准」与「批准了零项」在数据上就无从区分。
   */
  approvedStepIds?: string[];
}

/**
 * 附件大类（决定 Composer 预览条 / 消息气泡里的图标与渲染策略）。
 * 与 MIME 解耦：同一大类可对应多种扩展名，便于 UI 统一呈现。
 */
export type AttachmentKind = 'image' | 'document' | 'text' | 'video' | 'audio' | 'other';

/**
 * 随用户消息一起上传的附件（Composer 选择 / 粘贴 / 拖拽产生）。
 *
 * 字段分两层：
 * - 元信息（id/name/size/mime/kind）始终随会话持久化，保证刷新后气泡仍能看到「发过什么」；
 * - 内容（previewUrl / dataUrl）按体积阈值裁剪后再落库，避免撑爆本地存储
 *   （见 `@/lib/attachments` 的 toPersistableAttachment）。
 */
export interface Attachment {
  id: string;
  /** 文件名（含扩展名），服务端据此判别类型 */
  name: string;
  /** 文件字节数 */
  size: number;
  /** MIME 类型（缺失时按扩展名推断） */
  mime: string;
  /** 大类，用于图标与渲染策略 */
  kind: AttachmentKind;
  /** 图片预览地址（本地 object URL；非图片为 undefined，且不持久化） */
  previewUrl?: string;
  /** 完整内容 dataUrl：`data:<mime>;base64,<payload>`，发送时解码为 base64 上传 */
  dataUrl?: string;
  /**
   * 本地来源路径（仅 Electron 桌面端经选择/拖拽文件时可得，Web 与剪贴板粘贴为 undefined）。
   * 随消息持久化，供悬停提示展示「目录 + 名称」。
   */
  localPath?: string;
}

/** 一条消息（用户 / 助手 / 工具） */
export interface Message {
  id: string;
  role: Role;
  /** 文本内容（assistant 流式累积） */
  content: string;
  /** 用户消息携带的附件（上传文件） */
  attachments?: Attachment[];
  /** assistant 触发的工具调用列表 */
  toolCalls?: ToolCall[];
  /** 消息内富产物 */
  artifacts?: Artifact[];
  /** Plan 模式产出的待裁决计划（仅 assistant 消息，FR-1.5） */
  plan?: MessagePlan;
  /** 过程时间线（深度思考段 / 工具执行行，网关进度事件流式聚合，按到达顺序交错） */
  process?: ProcessEvent[];
  /**
   * 富文本副本（仅 user 消息、仅本地持久化）：附件徽章以 `\uE000<attId>\uE001`
   * token 占位，气泡据此把徽章内联渲染在输入时的原始位置；
   * 上传网关仍用纯文本 content，编辑重发后该字段作废。
   */
  richContent?: string;
  /** 创建时间 ISO 8601 UTC */
  createdAt: string;
  /**
   * 本次流式处理耗时（毫秒，仅 assistant 角色、流结束/中断时写入）。
   * 用于消息头回显「已处理 33s」。
   *
   * 历史消息缺该字段时**不做估算**：相邻消息的时间差混入了「用户打字间隔」，
   * 拿它当处理时长会给出系统性偏大的错误数字，宁可留空。
   */
  durationMs?: number;
  /** 助手消息被用户主动中断（仅 assistant 角色设置；用于 UI 显示「（已停止）」标记） */
  aborted?: boolean;
  /**
   * 助手消息因**引擎侧异常**而未正常收尾（仅 assistant 角色设置）。
   *
   * 与 `aborted` 刻意分开：`aborted` 是「用户按了停止」，本字段是「上游断流 / 引擎报错 /
   * 撞上迭代上限」。两者在重建上下文与记忆写入上的处置不同（`aborted` 的轮次会被过滤掉），
   * 文案也不同（「已停止」vs「已中断，结果可能不完整」）。
   *
   * 没有这个字段时，这类轮次与正常完成在数据上完全同形，界面只能显示「已完成」
   * ——2026-09-29 的断流事故正是如此。
   */
  interrupted?: boolean;
}

/** OpenAI 兼容请求消息角色（含 system） */
export type ChatRole = 'system' | 'user' | 'assistant';

/** 发送给 AgentRuntime 的对话消息参数 */
export interface ChatMessageParam {
  role: ChatRole;
  content: string;
  name?: string;
}
