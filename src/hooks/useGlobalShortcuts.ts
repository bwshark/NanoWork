import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '@/lib/constants';
import { isEditableTarget } from '@/lib/editableTarget';
import {
  GLOBAL_SHORTCUTS,
  conflictsWithTyping,
  matchBinding,
  resolveBinding,
  type ShortcutId,
} from '@/lib/shortcuts';
import { platform } from '@/platform';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSettingsUiStore } from '@/stores/settingsUiStore';

/**
 * 全局快捷键派发器。
 *
 * 挂一个窗口级 `keydown` 监听，把事件交给 `lib/shortcuts` 的注册表匹配，
 * 命中就执行对应动作。设计约束：
 *
 * 1. **只处理 `scope: 'global'` 的命令**。输入框内的（发送 / 换行 / 停止生成 / 语音）
 *    由 Composer 自己处理——那里的判定条件复杂得多（输入法组合态、浮层优先级），
 *    放到这里会变成两处都在抢同一个按键。
 * 2. **订阅一次，不随渲染重挂**。键位、会话列表、侧边栏状态全部在事件回调里用
 *    `getState()` 现取：若把它们放进依赖数组，任何一次会话列表刷新都会重建监听，
 *    空窗期内按下的键会丢失。
 * 3. **让路给输入控件**。裸可打印键（`B`、`/` 这类）在输入框聚焦时不能劫持，
 *    否则用户把「切换左侧栏」绑成 `B` 之后就再也打不出字母 b 了。
 *    `Ctrl`/`Alt`/`Meta` 组合不受此限制——`Ctrl+B` 本就该在打字时也生效。
 * 4. **只在真的做了事时吞按键**。当前没有会话就按 `Ctrl+F`，不能把浏览器自带的
 *    查找一起挡掉——那是一个用户明确按下就期待出现的能力。
 */
export function useGlobalShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 默认行为已阻止的按键（如某个浮层已经处理过）不再重复派发
      if (e.defaultPrevented) return;

      const overrides = useSettingsStore.getState().settings.shortcuts;

      for (const def of GLOBAL_SHORTCUTS) {
        const binding = resolveBinding(def.id, overrides);
        if (!binding || !matchBinding(binding, e)) continue;
        if (isEditableTarget(e.target) && conflictsWithTyping(binding)) continue;

        // 只有**真的执行了动作**才吞掉默认行为。
        // 否则 Web 端会出现「没有活跃会话时按 Ctrl+F，浏览器自己的查找也被挡住」——
        // 一个更常用、且用户明确按下就期待出现的能力，被一条用不上的命令顶掉。
        if (!runShortcutAction(def.id, navigate)) continue;
        e.preventDefault();
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);
}

/**
 * 命中后的动作。集中在一处 switch，避免动作散落在监听回调里难以核对覆盖面。
 *
 * @returns 是否真的执行了动作。返回 false 时调用方不吞按键——这样
 * 「当前没有会话，所以 Ctrl+F 无处可搜」不会把浏览器/系统的同名快捷键一起挡掉。
 */
function runShortcutAction(id: ShortcutId, navigate: (path: string) => void): boolean {
  switch (id) {
    case 'settings.open':
      useSettingsUiStore.getState().openSettings();
      return true;

    case 'chat.search': {
      const sessionId = useSessionsStore.getState().activeId;
      if (!sessionId) return false;
      navigate(ROUTES.chat);
      useSessionUiStore.getState().openSearch(sessionId);
      return true;
    }

    case 'chat.new':
      newTask(navigate);
      return true;

    case 'task.prev':
      return stepTask(-1, navigate);

    case 'task.next':
      return stepTask(1, navigate);

    case 'sidebar.toggle': {
      // 与标题栏那个图标同源：Web 端没有标题栏，收起来就再无入口展开，因此不响应
      if (platform.env !== 'electron') return false;
      const store = useSettingsStore.getState();
      const collapsed = store.settings.sidebarCollapsed ?? false;
      store.setSettings({ sidebarCollapsed: !collapsed });
      return true;
    }

    case 'artifact.toggle': {
      const sessionId = useSessionsStore.getState().activeId;
      if (!sessionId) return false;
      useSessionUiStore.getState().toggleArtifactPanel(sessionId);
      return true;
    }

    case 'window.fullscreen':
      return toggleFullscreen();

    default:
      return false;
  }
}

/**
 * 新建任务。语义与侧边栏 / 标题栏的「新建任务」入口完全一致：
 * 工作空间回到默认（不继承），权限策略继承当前任务，专家与技能不继承。
 * 三处各写一遍必然走偏，这里只写这一份。
 */
function newTask(navigate: (path: string) => void) {
  const store = useSessionsStore.getState();
  const current = store.sessions.find((s) => s.id === store.activeId);
  store.createSession(undefined, '新任务', {
    fullAccess: current?.fullAccess,
    toolApproval: current?.toolApproval,
    inheritCapabilities: false,
  });
  navigate(ROUTES.chat);
}

/**
 * 在会话列表里前后移动。
 *
 * 用 `sessions` 数组顺序而不是侧边栏渲染出来的顺序：侧边栏会按工作空间分组、
 * 还会被搜索与筛选收窄，那是一个「视图顺序」，随时可能因为一条筛选条件而
 * 让 Ctrl+] 跳到完全不同的会话上。数组顺序是稳定且可预期的循环。
 *
 * @returns 是否真的切换了会话（只有一个会话时无事可做）
 */
function stepTask(delta: number, navigate: (path: string) => void): boolean {
  const store = useSessionsStore.getState();
  const { sessions, activeId } = store;
  if (sessions.length === 0) return false;

  const currentIndex = sessions.findIndex((s) => s.id === activeId);
  const nextIndex =
    currentIndex < 0
      ? 0
      : (currentIndex + delta + sessions.length) % sessions.length;
  const next = sessions[nextIndex];
  if (!next || next.id === activeId) return false;

  store.selectSession(next.id);
  navigate(ROUTES.chat);
  return true;
}

/** 全屏切换：桌面端走主进程，Web 端退回浏览器 Fullscreen API */
function toggleFullscreen(): boolean {
  const api = window.electronAPI;
  if (platform.env === 'electron' && api) {
    api.windowToggleFullScreen();
    return true;
  }
  // 旧浏览器没有 Fullscreen API：不吞按键，交回给系统（F11 在多数环境本就是全屏）
  if (typeof document.documentElement.requestFullscreen !== 'function') {
    return false;
  }
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
  } else {
    void document.documentElement.requestFullscreen().catch(() => undefined);
  }
  return true;
}
