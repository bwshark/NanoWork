/**
 * DevTools 手开快捷键的判据（纯函数，便于单测）。
 *
 * ## 为什么需要它
 *
 * 应用的菜单被 `Menu.setApplicationMenu(null)` 置空，Chromium 默认的
 * 「Toggle Developer Tools」加速键（`Ctrl+Shift+I` / `Cmd+Opt+I`）随之失效。
 * 而 DevTools 的**自动打开**又被改成了显式开关（默认关，理由见 `main.ts` 的
 * `autoOpenDevTools`：DevTools 前端会请求 CDP 的 `Autofill.enable`，Electron 的
 * 裁剪版 Chromium 没有这个域，一开面板就刷两条 `ERROR:CONSOLE` 噪声）。
 * 两件事叠加的结果是：不补这个入口，开发态就**再也进不去 DevTools**。
 *
 * ## 判据为什么值得单测
 *
 * 它同时守着两个相反的风险，且都很容易写错：
 * - **漏判**（`Ctrl+Shift+I` 不生效）→ 用户失去唯一的 DevTools 入口；
 * - **误判**（把普通按键当成快捷键）→ 在输入框里打一个 `i` 就弹出 DevTools，
 *   比没有这个功能更糟。
 * 所以「裸 `i` 不算」「只按 `Shift+I` 不算」这两条否定判据和肯定判据同等重要。
 *
 * 键位与 Chromium 的既有约定一致：Windows / Linux 是 `Ctrl+Shift+I`，
 * macOS 是 `Cmd+Opt+I`；`F12` 三平台通用。
 */

/** `before-input-event` 事件里我们关心的字段（只取用到的，避免依赖 Electron 类型） */
export interface DevToolsShortcutInput {
  key: string;
  type?: string;
  control?: boolean;
  shift?: boolean;
  meta?: boolean;
  alt?: boolean;
}

/** 唯一的 DevTools 手开判据：`F12` / `Ctrl+Shift+I` / `Cmd+Opt+I` */
export function isDevToolsShortcut(input: DevToolsShortcutInput): boolean {
  const key = (input.key ?? '').toLowerCase();
  if (key === 'f12') return true;
  if (key !== 'i') return false;
  // Windows / Linux：Ctrl+Shift+I（**必须**同时按住，只按 Ctrl+I 是「斜体」）
  if (input.control === true && input.shift === true) return true;
  // macOS：Cmd+Opt+I（Chromium 的既有约定）
  return input.meta === true && input.alt === true;
}
