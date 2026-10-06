/**
 * 事件构造器：把「业务动作」翻译成合法的事件节点（D2，见第 9 章）。
 *
 * ## 职责边界
 *
 * 本模块**只做纯计算**（id / seq / parentId / timestamp 的分配与串联），
 * 不碰 IO、不碰 store、不依赖平台。落盘在 `store.ts`，业务翻译在调用方。
 * 这样「事件链的合法性」可以用普通单测穷举，无需文件系统或浏览器环境。
 *
 * ## 链式约定
 *
 * 默认形成**线性链**：每条新事件的 `parentId` 指向「上一条产出的事件」。
 * 这是绝大多数情况的正确语义（一次对话就是一条时间线）。需要分支/重放时，
 * 通过 `opts.parentId` 显式指定分叉点——此时链的「尖端」随之切换，后续事件
 * 挂在新分叉上，从而天然支持「从第 N 步重走」。
 */

import { genId as defaultGenId } from '@/lib/id';
import type { BaseEvent, EventOfType, EventProvider, EventType, SessionEvent } from '@/types/event';

/** 构造事件时由调用方提供的载荷（去掉所有公共字段） */
export type EventPayload<T extends EventType> = Omit<
  EventOfType<T>,
  'id' | 'sessionId' | 'parentId' | 'seq' | 'type' | 'timestamp' | 'provider'
>;

/** 单条事件的产出选项 */
export interface EmitOptions {
  /**
   * 显式指定父节点：
   * - 不传 → 继承当前链尖（线性追加）；
   * - `null` → 作为新的根（开分叉）；
   * - 字符串 → 从该事件处分叉。
   */
  parentId?: string | null;
  /** 引擎侧链路信息（逐事件落盘，见 EventProvider） */
  provider?: EventProvider;
}

export interface EventFactoryOptions {
  sessionId: string;
  /** 起始序号；续写已有会话时传 `lastSeq + 1`，缺省 1 */
  startSeq?: number;
  /** 起始父节点；续写时传历史上最后一条事件的 id，缺省 null */
  rootParentId?: string | null;
  /** 时间源（测试注入用），缺省 `Date.now` */
  now?: () => number;
  /** id 生成（测试注入用），缺省 `genId` */
  genId?: () => string;
}

/**
 * 事件工厂。
 *
 * 用法：
 * ```ts
 * const f = new EventFactory({ sessionId: 's1' });
 * const start = f.sessionStart({ agentId: 'a1', mode: 'craft', permissionMode: 'restricted' });
 * const msg = f.message({ role: 'user', content: '你好' });   // parentId = start.id
 * ```
 */
export class EventFactory {
  private seq: number;
  private parentId: string | null;
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: EventFactoryOptions) {
    this.sessionId = opts.sessionId;
    this.seq = (opts.startSeq ?? 1) - 1;
    this.parentId = opts.rootParentId ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.genId ?? defaultGenId;
  }

  /** 当前链尖（下一次线性追加的父节点） */
  get tip(): string | null {
    return this.parentId;
  }

  /** 已分配的最大序号 */
  get lastSeq(): number {
    return this.seq;
  }

  /**
   * 从既有事件恢复：把 seq 与链尖对齐到历史末尾，从而安全续写。
   *
   * 传入的事件**不要求有序**（按 seq 自行归一）；空数组为 no-op。
   */
  resumeFrom(events: readonly SessionEvent[]): void {
    if (events.length === 0) return;
    let maxSeq = 0;
    let tipEvent: SessionEvent | null = null;
    for (const ev of events) {
      if (ev.seq > maxSeq) {
        maxSeq = ev.seq;
        tipEvent = ev;
      }
    }
    this.seq = maxSeq;
    if (tipEvent) this.parentId = tipEvent.id;
  }

  /** 统一产出：分配 id / seq / parentId / timestamp 并推进链尖 */
  private emit<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    opts?: EmitOptions,
  ): EventOfType<T> {
    const id = this.newId();
    const parentId = opts?.parentId !== undefined ? opts.parentId : this.parentId;
    const base: BaseEvent = {
      id,
      sessionId: this.sessionId,
      parentId,
      seq: ++this.seq,
      type,
      timestamp: this.now(),
      ...(opts?.provider ? { provider: opts.provider } : {}),
    };
    const event = { ...payload, ...base } as EventOfType<T>;
    this.parentId = id;
    return event;
  }

  sessionStart(
    payload: EventPayload<'session-start'>,
    opts?: EmitOptions,
  ): EventOfType<'session-start'> {
    return this.emit('session-start', payload, opts);
  }

  message(payload: EventPayload<'message'>, opts?: EmitOptions): EventOfType<'message'> {
    return this.emit('message', payload, opts);
  }

  reasoning(payload: EventPayload<'reasoning'>, opts?: EmitOptions): EventOfType<'reasoning'> {
    return this.emit('reasoning', payload, opts);
  }

  functionCall(
    payload: EventPayload<'function-call'>,
    opts?: EmitOptions,
  ): EventOfType<'function-call'> {
    return this.emit('function-call', payload, opts);
  }

  functionCallResult(
    payload: EventPayload<'function-call-result'>,
    opts?: EmitOptions,
  ): EventOfType<'function-call-result'> {
    return this.emit('function-call-result', payload, opts);
  }

  permissionDecision(
    payload: EventPayload<'permission-decision'>,
    opts?: EmitOptions,
  ): EventOfType<'permission-decision'> {
    return this.emit('permission-decision', payload, opts);
  }

  plan(payload: EventPayload<'plan'>, opts?: EmitOptions): EventOfType<'plan'> {
    return this.emit('plan', payload, opts);
  }

  planDecision(
    payload: EventPayload<'plan-decision'>,
    opts?: EmitOptions,
  ): EventOfType<'plan-decision'> {
    return this.emit('plan-decision', payload, opts);
  }

  expertGroupMember(
    payload: EventPayload<'expert-group-member'>,
    opts?: EmitOptions,
  ): EventOfType<'expert-group-member'> {
    return this.emit('expert-group-member', payload, opts);
  }

  artifact(payload: EventPayload<'artifact'>, opts?: EmitOptions): EventOfType<'artifact'> {
    return this.emit('artifact', payload, opts);
  }

  fileSnapshot(
    payload: EventPayload<'file-history-snapshot'>,
    opts?: EmitOptions,
  ): EventOfType<'file-history-snapshot'> {
    return this.emit('file-history-snapshot', payload, opts);
  }

  commit(payload: EventPayload<'commit'>, opts?: EmitOptions): EventOfType<'commit'> {
    return this.emit('commit', payload, opts);
  }

  aiTitle(payload: EventPayload<'ai-title'>, opts?: EmitOptions): EventOfType<'ai-title'> {
    return this.emit('ai-title', payload, opts);
  }

  usage(payload: EventPayload<'usage'>, opts?: EmitOptions): EventOfType<'usage'> {
    return this.emit('usage', payload, opts);
  }

  error(payload: EventPayload<'error'>, opts?: EmitOptions): EventOfType<'error'> {
    return this.emit('error', payload, opts);
  }

  modeChange(
    payload: EventPayload<'mode-change'>,
    opts?: EmitOptions,
  ): EventOfType<'mode-change'> {
    return this.emit('mode-change', payload, opts);
  }

  sessionEnd(
    payload: EventPayload<'session-end'>,
    opts?: EmitOptions,
  ): EventOfType<'session-end'> {
    return this.emit('session-end', payload, opts);
  }
}
