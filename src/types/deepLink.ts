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
