/**
 * 深链动作（FR-13.x / B4-02）。
 *
 * **这是 IPC 线上形态，不是 UI 状态**：主进程只负责把 `nanowork://…` 解析成
 * 这两种动作之一，渲染层负责执行（选会话 / 建新会话并预填 prompt）。
 *
 * 放在 `src/types` 而不是 `electron/`：主进程与渲染层都要用它，而渲染层绝不能
 * import `electron/**`（CI 检查一：只有 `src/platform/**` 认识 `window.electronAPI`）。
 * 主进程反向依赖 `src/types/*` 是本仓既有做法（见 `electron/main.ts` 对
 * `../src/types/engine` 的 import）。
 */
export type DeepLinkAction =
  | {
      /** 打开一条既有会话（按 id）。 */
      kind: 'open-session';
      sessionId: string;
    }
  | {
      /**
       * 新建会话并预填提示词。
       *
       * `prompt` 可以为空串：那等价于「打开一个新的空白会话」，仍然是合法动作。
       */
      kind: 'new-chat';
      prompt: string;
    };

/**
 * 深链「一次性意图」在路由 state 里的键名。
 *
 * ⚠️ **必须唯一**：App.tsx 写这份 state、ChatPage.tsx 读它，两边各写一个字符串
 * 字面量时，任一边拼错都不会报错——表现是「点深链接开了新会话，但输入框是空的」，
 * 这类静默失配正是本键存在的理由。两边都从这里取值，错误在编译期就暴露。
 */
export const DEEP_LINK_PROMPT_KEY = 'deepLinkPrompt';

/** 路由 state 里深链意图部分的形态。 */
export type DeepLinkRouteState = Partial<Record<typeof DEEP_LINK_PROMPT_KEY, string | undefined>>;

/**
 * 从路由 state 里取出深链 prompt。
 *
 * 非字符串一律当作「没有」：state 来自 URL/历史条目，理论上可被第三方塞成任意值，
 * 而输入框初值只接受字符串。宽松取值而不是抛错——深链是「锦上添花」，
 * 不该因为一段脏 state 让整个聊天页崩掉。
 */
export function readDeepLinkPrompt(state: unknown): string | undefined {
  if (state === null || typeof state !== 'object') return undefined;
  const value = (state as Record<string, unknown>)[DEEP_LINK_PROMPT_KEY];
  return typeof value === 'string' ? value : undefined;
}
