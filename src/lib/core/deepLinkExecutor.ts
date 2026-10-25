/**
 * 深链动作的**执行器**（B4-02）。
 *
 * ## 为什么抽成纯函数
 *
 * 这段逻辑原先内联在 `App.tsx` 的 useEffect 里。要测它就得渲染整棵 App
 * （连带一堆 store 副作用），而真正想钉住的行为其实只有三条：
 * 「open-session 选了会话」「new-chat 建了会话」「prompt 经路由 state 传走」。
 *
 * 抽出来之后，这几条能直接单测；`App.tsx` 只剩接线。
 *
 * ## 契约（与 `App.tsx` 原先的注释一致，行为未改）
 *
 * - `open-session`：会话不存在也不报错——`selectSession` 只是把 activeId 指过去，
 *   页面表现为空会话。坏链接不该炸应用。
 * - `new-chat`：先建会话（标题取自 prompt 前 24 字，空则用「新会话」），
 *   再把 prompt 经路由 state 交给 ChatPage。
 *
 * why 不用 store 传 prompt：这是一次性意图，路由 state 天然随本次导航消费掉，
 * 不需要额外清理，也不会在刷新后幽灵般复现。
 */

import {
  DEEP_LINK_PROMPT_KEY,
  type DeepLinkAction,
  type DeepLinkRouteState,
} from '@/types/deepLink';

/** 会话 store 上用得到的两个动作。刻意只声明需要的方法，便于测试替身。 */
export interface DeepLinkSessionActions {
  selectSession(id: string): void;
  createSession(session: undefined, title: string): void;
}

export interface DeepLinkExecutorDeps {
  /** 每次执行都取最新 store（`getState()` 语义，避免闭包持有旧快照）。 */
  getSessions: () => DeepLinkSessionActions;
  navigate: (to: string, options?: { state?: DeepLinkRouteState }) => void;
  /** 聊天页路由，由调用方注入以避免本模块依赖 `ROUTES`（保持纯函数可测）。 */
  chatRoute: string;
}

/** 会话标题：prompt 前 24 字，空白则回落。 */
export function deepLinkSessionTitle(prompt: string): string {
  return prompt.trim().slice(0, 24) || '新会话';
}

export function createDeepLinkExecutor(
  deps: DeepLinkExecutorDeps,
): (action: DeepLinkAction) => void {
  return (action: DeepLinkAction) => {
    const sessions = deps.getSessions();
    if (action.kind === 'open-session') {
      sessions.selectSession(action.sessionId);
      deps.navigate(deps.chatRoute);
      return;
    }
    const title = deepLinkSessionTitle(action.prompt);
    sessions.createSession(undefined, title);
    deps.navigate(deps.chatRoute, { state: { [DEEP_LINK_PROMPT_KEY]: action.prompt } });
  };
}
