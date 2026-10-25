/**
 * 通用快照式撤销 / 重做栈（与具体数据结构无关的纯函数集合）。
 *
 * 设计取舍 —— 为什么用快照而非命令：
 * - 宿主是 contentEditable **非受控 DOM**，浏览器原生 undo 栈在我们手动操作 DOM
 *   （插入附件徽章等）后会失效或错乱，必须自管；
 * - 输入区内容量级是聊天文本（通常几 KB），快照的内存开销完全可接受；
 * - 快照能「一次还原 DOM + 附件状态 + 光标」三个数据源，不会出现半还原的不一致态；
 * - 命令式（记录 insert/delete 反向执行）虽省内存，但 DOM 位置映射极易出错。
 *
 * 连续输入合并：`pushSnapshot` 的 `coalesceMs` 窗口内只更新 present 不入栈，
 * 避免「每敲一个字就产生一个快照」。结构性变更（粘贴 / 插入或删除附件 / 剪贴）
 * 应传 `coalesceMs: 0` 强制入栈。
 */

/** 撤销栈状态（不可变：所有操作返回新对象） */
export interface UndoStack<T> {
  /** 过去的快照，最旧在前 */
  past: T[];
  /** 当前快照 */
  present: T;
  /** 被撤销的快照，最新在前（redo 时从头部取） */
  future: T[];
  /** 栈深上限（超出丢弃最旧） */
  limit: number;
  /** 上次入栈时间戳（毫秒），用于连续输入合并 */
  lastPushAt: number;
}

/** 新建撤销栈；initial 为初始快照 */
export function createUndoStack<T>(initial: T, limit = 50): UndoStack<T> {
  return {
    past: [],
    present: initial,
    future: [],
    limit,
    lastPushAt: 0,
  };
}

/**
 * 记录新快照。
 *
 * @param coalesceMs 合并窗口：距上次入栈小于该值时只更新 present 不入栈。
 *   为 0 表示强制入栈。注意 past 为空时（尚未真正入栈过）不合并，
 *   否则初始状态会丢失、导致首次 undo 无效。
 * @param now 时间戳注入点（便于单测用假时间）
 */
export function pushSnapshot<T>(
  stack: UndoStack<T>,
  next: T,
  opts: { coalesceMs?: number; now?: number } = {},
): UndoStack<T> {
  const now = opts.now ?? Date.now();
  const coalesceMs = opts.coalesceMs ?? 0;
  const canCoalesce =
    coalesceMs > 0 &&
    stack.past.length > 0 &&
    now - stack.lastPushAt < coalesceMs;
  if (canCoalesce) {
    // 合并：present 更新，past 不动（撤销一步退到本次连续输入之前）
    return { ...stack, present: next, future: [], lastPushAt: stack.lastPushAt };
  }
  const past = [...stack.past, stack.present];
  if (past.length > stack.limit) {
    past.splice(0, past.length - stack.limit);
  }
  return { ...stack, past, present: next, future: [], lastPushAt: now };
}

/** 撤销一步：past 尾部出栈作为 present，原 present 压入 future */
export function undo<T>(stack: UndoStack<T>): UndoStack<T> {
  if (stack.past.length === 0) return stack;
  const past = stack.past.slice(0, -1);
  const present = stack.past[stack.past.length - 1];
  return { ...stack, past, present, future: [stack.present, ...stack.future] };
}

/** 重做一步：future 头部出栈作为 present，原 present 压回 past */
export function redo<T>(stack: UndoStack<T>): UndoStack<T> {
  if (stack.future.length === 0) return stack;
  const [present, ...future] = stack.future;
  return { ...stack, past: [...stack.past, stack.present], present, future };
}

export function canUndo<T>(stack: UndoStack<T>): boolean {
  return stack.past.length > 0;
}

export function canRedo<T>(stack: UndoStack<T>): boolean {
  return stack.future.length > 0;
}

/** 重置为全新状态（发送成功后清空历史，避免撤回上一条已发消息的内容） */
export function resetStack<T>(stack: UndoStack<T>, present: T): UndoStack<T> {
  return { ...stack, past: [], present, future: [], lastPushAt: 0 };
}
