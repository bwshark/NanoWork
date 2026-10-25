/**
 * 「这一轮正在被实时观察」的会话登记表（模块级、无依赖）。
 *
 * ## 为什么需要它
 *
 * 助理视图的占位助手消息是**纯本地**的：它不在引擎磁盘上，一旦 `openExternal`
 * 用磁盘记录整体替换会话，它就没了。而引擎在轮次进行中会**多次落盘**
 * （`_persist_user_message_early` 在开工时就写一次用户消息，每个工具轮次后还会再写），
 * 4 秒轮询看到的 `updatedAt` 因此会变——不拦住它，实时过程刚出现就被冲掉，
 * 表现成「看了眼实时思考，一秒后又空了」。
 *
 * 收尾时主动解除登记（`settle` 之前），并立刻拉一次详情，让真实记录接管。
 *
 * 单独一个小模块是为了避免循环依赖：`channelSessionsStore` 与
 * `channelTurnLive` 都要用它，而后者已经依赖前者。
 */

const watching = new Set<string>();

/** 该会话是否有正在进行的实时观察（有则抑制磁盘刷新替换） */
export function isChannelTurnWatching(sessionId: string): boolean {
  return watching.has(sessionId);
}

/** 登记 / 解除登记（幂等） */
export function setChannelTurnWatching(sessionId: string, on: boolean): void {
  if (on) watching.add(sessionId);
  else watching.delete(sessionId);
}
