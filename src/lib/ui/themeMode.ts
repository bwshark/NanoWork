import { useEffect, useState } from 'react';
import { normalizeTheme } from '@/stores/settingsStore';

/** 用户主题偏好（持久化于 settings） */
export type ThemePreference = 'light' | 'dark' | 'system';

/** 解析后的实际模式 */
export type ResolvedMode = 'light' | 'dark';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** 系统当前是否为深色（无 matchMedia 时兜底为深色，与 index.html 初始 class 一致） */
function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

/** 偏好 → 实际模式：入口先归一化（非法值兜底 'dark'），system 时读取操作系统偏好 */
export function resolveTheme(pref: ThemePreference): ResolvedMode {
  const normalized = normalizeTheme(pref);
  if (normalized === 'light' || normalized === 'dark') return normalized;
  return systemPrefersDark() ? 'dark' : 'light';
}

/** 同步 document：html.dark class + color-scheme（驱动 index.css 的 CSS 变量） */
function applyModeToDocument(mode: ResolvedMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  root.style.colorScheme = mode;
}

/** system 偏好下的 matchMedia 监听器（单例，避免重复注册） */
let removeSystemListener: (() => void) | null = null;

function ensureSystemListener(): void {
  if (removeSystemListener) return;
  if (typeof window === 'undefined' || !window.matchMedia) return;
  const mq = window.matchMedia(DARK_MEDIA_QUERY);
  const onChange = () => applyModeToDocument(mq.matches ? 'dark' : 'light');
  mq.addEventListener('change', onChange);
  removeSystemListener = () => mq.removeEventListener('change', onChange);
}

function dropSystemListener(): void {
  removeSystemListener?.();
  removeSystemListener = null;
}

/**
 * 应用主题偏好：同步 document（dark class + color-scheme），
 * 偏好为 system 时注册系统外观监听，否则移除旧监听。
 */
export function applyTheme(pref: ThemePreference): void {
  applyModeToDocument(resolveTheme(pref));
  if (pref === 'system') ensureSystemListener();
  else dropSystemListener();
}

/** React Hook：解析偏好为实际模式；system 下随系统外观变化实时更新 */
export function useResolvedTheme(pref: ThemePreference): ResolvedMode {
  const normalized = normalizeTheme(pref);
  const [mode, setMode] = useState<ResolvedMode>(() => resolveTheme(normalized));

  useEffect(() => {
    if (normalized !== 'system') {
      setMode(normalized);
      return;
    }
    if (typeof window === 'undefined' || !window.matchMedia) {
      setMode('dark');
      return;
    }
    const mq = window.matchMedia(DARK_MEDIA_QUERY);
    const update = () => setMode(mq.matches ? 'dark' : 'light');
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [normalized]);

  return mode;
}
