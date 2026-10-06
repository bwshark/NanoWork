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

/**
 * 专家团成员的生命周期相位（FR-2.4 第 3 步）。
 *
 * 与工具行不同，成员**内部**的工具调用不上报（成员跑在子代理里，没有回传通道），
 * 所以能拿到的就是这五个相位。够表达「谁在做、做完没有、产出是什么」，
 * 不够表达「成员内部每一步做了什么」——**这是引擎侧的现状，不是渲染层的省略**。
 */
export type MemberEventPhase = 'planned' | 'started' | 'finished' | 'failed' | 'aggregating';

/**
 * 专家团成员事件（过程时间线里的「成员」行）。
 *
 * ⚠️ 为什么它是**独立**一类过程行，而不是给工具行加个 `memberId`：
 * 成员产出根本没有对应的工具行（既不是工具调用、也不是深度思考），
 * 硬塞进 `ProcessToolRow` 会让「工具」这个词再也说不清自己指什么；
 * 而按成员分组渲染又要求同一成员的事件能被稳定地认出来（靠 `memberId`）。
 */
export interface MemberEvent {
  id: string;
  kind: 'member';
  /** 成员 id（同一成员的多个相位共用 → 分组键） */
  memberId: string;
  /** 成员名（展示用；引擎在缺名时回退成 id） */
  memberName: string;
  phase: MemberEventPhase;
  /** 产出文本（finished）/ 团队计划（planned）——按 phase 二选一 */
  text?: string;
  /** 失败原因（failed 时携） */
  error?: string;
}

/** 过程时间线事件联合 */
export type ProcessEvent = ReasoningEvent | ProcessToolRow | MemberEvent;
