/**
 * 会话事件记录器（D2 Phase C 的写入侧）。
 *
 * ## 它解决三件事
 *
 * 1. **`seq` / `parentId` 的连续性**：`EventFactory` 是有状态的（seq 单调、
 *    链尖跟着走）。进程内每个会话常驻一个工厂；打开已有会话时先
 *    `resumeFrom` 历史事件，才能安全续写而不撞号、不断链。
 * 2. **每会话写序**：同一会话的写入必须严格按 `seq` 顺序落盘。Electron 侧主
 *    进程虽已按文件串行，但 Web 实现的追加是「读数组 → 拼接 → 回写」，并发
 *    会丢事件；且「搬迁作用域」这类多步操作天然需要先后关系。故在渲染层
 *    再持一条按会话的串行队列。
 * 3. **分支点定位**：记住 `messageId → message 事件 id`，供「编辑后重发」
 *    从被替换的消息处分叉（见 `project.ts` 的 `messageEventIndex`）。
 *
 * ## 为什么 `record` 是同步的
 *
 * 事件**构造**（分配 id / seq / timestamp）在调用方栈上同步完成，只有**写盘**
 * 异步入队。这样才能做到两件看起来矛盾的事：
 *
 * - store 的动作保持同步返回（既有调用点全部是 `setSessionWorkdir(id, dir)`
 *   这种即取即用写法，改造为异步会波及约 20 个组件）；
 * - 内存视图与磁盘事件**来自同一批事件对象**（构造一次、两处消费），
 *   而不是各自推导一遍——后者才是漂移的根源。
 *
 * 代价是「写盘失败」不回滚内存视图：视图此时仍是本次会话内唯一权威，
 * 失败只提示不清空（下次启动以磁盘为准，见 `sessionsStore.loadSessions`）。
 *
 * ## 边界
 *
 * 本模块不 import 任何 store，错误经 `setRecordErrorSink` 注入的回调上抛，
 * 避免与 `sessionsStore` 形成循环依赖。
 */

import type { SessionEvent } from '@/types/event';
import { EventFactory } from './factory';
import { getEventStore } from './index';
import { activePath, messageEventIndex } from './project';

/** 写盘失败的上报出口（由 store 注入，通常接一个 toast） */
export type RecordErrorSink = (sessionId: string, error: unknown) => void;

let errorSink: RecordErrorSink | null = null;

/** 注入写盘失败的上报出口（幂等，测试可置 null 关闭） */
export function setRecordErrorSink(sink: RecordErrorSink | null): void {
  errorSink = sink;
}

interface RecorderState {
  /** 事件工厂：持有 seq 与链尖 */
  factory: EventFactory;
  /**
   * 当前落点作用域（会话的**落盘分片**）；决定 `projects/<slug>/`。
   *
   * 与 `session.workdir` 在「会话已有消息又切了工作空间」时分叉：那时分片冻结，
   * 记录器不再改作用域，后续追加继续落原目录（见 `Session.streamWorkdir`）。
   */
  workdir?: string;
  /** `messageId` → 活跃链上该消息 `message` 事件 id */
  messageEventIds: Map<string, string>;
  /**
   * **本回合**已落盘的事件（自上次 `takeTurnEvents` 起）。
   *
   * 用途只有一个：回合收尾时把这一批事件交给 trace 构建器（FR-11.2）。之所以
   * 记在记录器里，而不是让调用方自己攒——**只有这里知道「一个回合从哪开始」**：
   * 事件由若干个不相邻的 `recordFor` 调用产出（思考段、工具行、产物、助手终值、
   * 回合结束），而它们全都经过本模块。放在调用方攒，就要在十几处各加一行。
   *
   * 不担心无限增长：`takeTurnEvents` 每次取完即清空，而回合结束必然调用它。
   */
  turnEvents: SessionEvent[];
}

/**
 * 回合缓冲上限。
 *
 * 正常回合是几十条事件；到量说明出了别的状况（例如某个循环在猛发工具事件）。
 * 到量后**丢最早的一半**而不是拒绝新增——trace 里最近的步骤比开头的更有用，
 * 而且这样也不会让「缓冲满了」变成一次内存事故。
 */
const MAX_TURN_EVENTS = 2000;

const recorders = new Map<string, RecorderState>();
/** 每会话串行写队列：队列尾始终是一个「永不拒绝」的 Promise */
const queues = new Map<string, Promise<void>>();

/** 把任务接到该会话队列尾；失败经 `errorSink` 上报且不阻断后续写入 */
function enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous.then(task).catch((error: unknown) => {
    errorSink?.(sessionId, error);
  });
  queues.set(sessionId, next);
  return next;
}

/**
 * 为**新建**会话建立记录器（seq 从 1 开始）。
 *
 * 已存在时**不覆盖**——重复调用只会重置 seq，可能造成撞号。
 */
export function createRecorder(sessionId: string, workdir?: string): void {
  if (recorders.has(sessionId)) return;
  recorders.set(sessionId, {
    factory: new EventFactory({ sessionId }),
    workdir,
    messageEventIds: new Map(),
    turnEvents: [],
  });
}

/**
 * 用磁盘上的既有事件建立记录器（打开会话 / 启动水合时调用）。
 *
 * - `seq` 与链尖对齐到历史末尾，续写不撞号；
 * - 分支点索引只取**活跃时间线**，废弃分支的消息不作为重发目标。
 *
 * 已存在时按 `events` 重新对齐（幂等；重复打开同一会话不会漂移）。
 */
export function primeRecorder(
  sessionId: string,
  workdir: string | undefined,
  events: readonly SessionEvent[],
): void {
  const factory = new EventFactory({ sessionId });
  factory.resumeFrom(events);
  recorders.set(sessionId, {
    factory,
    workdir,
    messageEventIds: messageEventIndex(activePath(events)),
    // 历史事件**不进**回合缓冲：缓冲的语义是「本次这一轮」，把整个历史倒进去
    // 会让第一轮的 trace 变成整份会话的记录
    turnEvents: [],
  });
}

/** 取记录器的落点作用域；未就绪返回 `undefined` */
export function recorderWorkdir(sessionId: string): string | undefined {
  return recorders.get(sessionId)?.workdir;
}

/** 记录器是否就绪（未就绪时不得调用 `record`） */
export function hasRecorder(sessionId: string): boolean {
  return recorders.has(sessionId);
}

/**
 * 该会话是否已经有过消息事件（= 有真实内容）。
 *
 * 用途：`sessionsStore.setSessionWorkdir` 据此决定「换工作空间时要不要把记录搬过去」
 * ——**确知为空才搬**，其余一律不搬（见 `Session.streamWorkdir`）。
 *
 * 判据取自记录器的 `messageEventIds`：它由 `recordEvents`（新事件）与
 * `primeRecorder`（磁盘历史）两侧共同填充，因此**不依赖会话是否已水合**——
 * 用 `session.messages.length` 判断会误判：列表里的会话在点进去之前消息是留白的。
 *
 * 返回 `null` = 无从判断（记录器未就绪）：调用方必须按「有内容」处理，
 * 因为搬错方向的代价不对称——把该留的记录搬走是不可逆的。
 */
export function hasSessionMessages(sessionId: string): boolean | null {
  const state = recorders.get(sessionId);
  if (!state) return null;
  return state.messageEventIds.size > 0;
}

/**
 * 更新落点作用域（会话工作空间变更时调用）。
 *
 * 只改「后续写入落哪里」，**不搬迁既有文件**——搬迁（仅在会话尚无消息时发生）由
 * `sessionsStore.setSessionWorkdir` 排进同一队列完成（顺序：先搬后写）。
 *
 * 反向的约束：**会话已有消息时不许调用它**。分片一旦冻结，记录器的作用域就必须
 * 保持不动，否则后续事件会追加到 `streamWorkdir` 之外的目录里，读回时只剩后半段。
 */
export function setRecorderWorkdir(sessionId: string, workdir?: string): void {
  const state = recorders.get(sessionId);
  if (state) state.workdir = workdir;
}

/** 该消息在活跃链上的 `message` 事件 id（用于重发时定位分支点） */
export function messageEventIdOf(sessionId: string, messageId: string): string | undefined {
  return recorders.get(sessionId)?.messageEventIds.get(messageId);
}

/**
 * 取走**本回合**累积的事件并清空缓冲（FR-11.2 的 trace 数据源）。
 *
 * 记录器未就绪时返回空数组而不是抛错：调用点在回合收尾路径上，可观测性拿不到
 * 数据只是少一份 trace，不该把这一轮的收尾打断。
 */
export function takeTurnEvents(sessionId: string): SessionEvent[] {
  const state = recorders.get(sessionId);
  if (!state) return [];
  const events = state.turnEvents;
  state.turnEvents = [];
  return events;
}

/**
 * 构造并落盘一批事件（构造同步、写盘异步）。
 *
 * @param build 在工厂上构造事件；返回单条或多条。**必须同步返回**。
 * @returns 已构造的事件（内存视图直接消费这一批，不再自行推导）
 *
 * @throws 记录器未就绪时抛错——这说明调用方漏了水合，属于编程错误，
 * 静默丢事件会让「刷新前 / 刷新后」不一致且难以追查。
 */
export function recordEvents(
  sessionId: string,
  build: (factory: EventFactory) => SessionEvent | SessionEvent[],
): SessionEvent[] {
  const state = recorders.get(sessionId);
  if (!state) {
    throw new Error(
      `[events] 会话 ${sessionId} 的记录器未就绪：请先 primeRecorder / createRecorder`,
    );
  }
  const produced = build(state.factory);
  const events = Array.isArray(produced) ? produced : [produced];
  if (events.length === 0) return events;

  for (const ev of events) {
    if (ev.type === 'message') state.messageEventIds.set(ev.messageId, ev.id);
  }

  state.turnEvents.push(...events);
  if (state.turnEvents.length > MAX_TURN_EVENTS) {
    state.turnEvents.splice(0, state.turnEvents.length - MAX_TURN_EVENTS);
  }

  const workdir = state.workdir;
  void enqueue(sessionId, async () => {
    await getEventStore().append({ sessionId, workdir, events });
  });
  return events;
}

/**
 * 把一段自定义的存储操作排进该会话的写队列。
 *
 * 供**多步、有先后要求**的操作使用（搬迁作用域、删除会话）：它们必须在
 * 已排队的追加之后执行，否则会出现「删掉文件后又被追加复活」。
 */
export function enqueueSessionTask(sessionId: string, task: () => Promise<void>): Promise<void> {
  return enqueue(sessionId, task);
}

/** 等待该会话已排队的写入全部落地（测试与「搬迁」前的收尾用） */
export function waitForSessionWrites(sessionId: string): Promise<void> {
  return queues.get(sessionId) ?? Promise.resolve();
}

/** 丢弃记录器与写队列（删除会话、测试重置） */
export function dropRecorder(sessionId: string): void {
  recorders.delete(sessionId);
  queues.delete(sessionId);
}

/** 仅供测试：清空全部记录器与队列 */
export function __resetRecordersForTest(): void {
  recorders.clear();
  queues.clear();
  errorSink = null;
}
