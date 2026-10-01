/**
 * 消息内过程时间线事件（对标 WorkBuddy 风格「深度思考 / 工具执行行」）。
 * 由网关 SSE 进度事件（delta.nanobot_event）在 store 内聚合而成，
 * 按到达顺序交错渲染：深度思考段与工具执行行交替出现。
 */

/**
 * 「模型工作步骤」的展示档位。这是**展示**约束（渲染详略），不是数据形态：
 * 它只影响读数据之后的渲染，`Message.process` 的持久化结构永不因档位变化。
 * 放在 process 域类型里，`Settings` 直接引用它（唯一事实源）。
 */
export type ProcessDetailLevel = 'result' | 'key' | 'full';

/** 一段深度思考（reasoning 连续 chunk 聚合；closed 后后续 reasoning 开新段） */
export interface ReasoningEvent {
  id: string;
  kind: 'reasoning';
  /** 累积的思考文本 */
  content: string;
  /** 段已闭合（工具执行 / 正文开始 / reasoning_end 触发） */
  closed?: boolean;
}

/** 工具执行行（read_file / grep / web_search / exec 等） */
export interface ProcessToolRow {
  id: string;
  kind: 'tool';
  /** 工具名（nanobot 工具注册名） */
  tool: string;
  /** 工具入参 */
  args: Record<string, unknown>;
  /** 行状态：执行中 / 完成 / 出错 */
  status: 'running' | 'done' | 'error';
  /** 执行结果（done 时，截断后保留） */
  result?: string;
  /** 错误信息（error 时） */
  error?: string;
}

/** 过程时间线事件联合 */
export type ProcessEvent = ReasoningEvent | ProcessToolRow;
