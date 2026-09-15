import { globalShortcut } from 'electron';

/**
 * 系统级全局快捷键管理（应用未聚焦时同样生效）。
 *
 * 设计要点：
 * - 单一快捷键：同一时刻只注册一个唤起键，重复设置会先注销旧的，
 *   避免残留注册把新键位"抢注失败"（globalShortcut.register 对已占用返回 false）。
 * - 空串表示用户主动禁用，此时不注册任何键。
 * - 注册结果以 { ok, error } 返回，由渲染层提示用户（被占用/非法键位）。
 */

/** 当前已注册的 accelerator；null 表示未注册（禁用或注册失败） */
let current: string | null = null;

/** 最近一次注册时绑定的回调；注销后一并清空，避免闭包持有过期窗口 */
let currentHandler: (() => void) | null = null;

export interface HotkeyResult {
  /** 是否注册成功（空串禁用也算成功） */
  ok: boolean;
  /** 失败原因：被系统或其他应用占用、或 accelerator 语法非法 */
  error?: string;
}

/** 当前生效的快捷键；未注册返回 null */
export function getCurrentHotkey(): string | null {
  return current;
}

/** 注销当前快捷键（重复调用安全） */
export function unregisterHotkey(): void {
  if (!current) return;
  try {
    globalShortcut.unregister(current);
  } catch {
    // 注销失败多为重复注销或应用已处于退出流程，忽略即可
  }
  current = null;
  currentHandler = null;
}

/**
 * 注册（或热更新）全局快捷键。
 * @param accelerator Electron accelerator 语法，如 'Ctrl+Alt+S'；空串表示禁用
 * @param handler 触发时执行的回调（由调用方注入窗口显隐逻辑，避免本模块依赖 mainWindow）
 */
export function registerHotkey(accelerator: string, handler: () => void): HotkeyResult {
  // 必须先注销旧键，否则旧注册仍占用系统热键，新键可能注册失败
  unregisterHotkey();

  const acc = accelerator.trim();
  // 空串 = 用户主动关闭全局快捷键
  if (!acc) return { ok: true };

  currentHandler = handler;
  let ok = false;
  try {
    ok = globalShortcut.register(acc, () => currentHandler?.());
  } catch (err) {
    currentHandler = null;
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!ok) {
    currentHandler = null;
    return {
      ok: false,
      error: `快捷键 ${acc} 注册失败，可能已被系统或其他应用占用`,
    };
  }

  current = acc;
  return { ok: true };
}

/** 应用退出前清理所有全局快捷键 */
export function unregisterAllHotkeys(): void {
  unregisterHotkey();
  try {
    globalShortcut.unregisterAll();
  } catch {
    // 忽略退出阶段的清理异常
  }
}
