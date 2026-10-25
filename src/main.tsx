import React, { useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { router } from '@/router';
import { buildMuiTheme } from '@/theme/muiTheme';
import { applyTheme, useResolvedTheme } from '@/lib/ui/themeMode';
import { useSettingsStore } from '@/stores/settingsStore';
import { startCronMirrorWatcher } from '@/ai/cronMirrorWatcher';
import { startCronRunsPoller } from '@/ai/cronRunsPoller';
import '@/theme/index.css';

/** 动态主题包裹组件（必须位于 Store 之内）：按偏好生成 MUI 主题 */
function ThemeGate({ children }: { children: ReactNode }) {
  const preference = useSettingsStore((s) => s.settings.theme);
  const mode = useResolvedTheme(preference);
  const theme = useMemo(() => buildMuiTheme(mode), [mode]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}

// 启动时先应用一次主题偏好（html.dark class / color-scheme）：由于 zustandStorage 是异步存储，
// 此处拿到的通常是内存默认值；持久化值靠异步 hydration 回填后经下方订阅二次应用。
// 真正的防闪烁由 index.html 内联脚本（Web）与主进程初始背景色（Electron）承担。
let lastAppliedTheme = useSettingsStore.getState().settings.theme;
applyTheme(lastAppliedTheme);
useSettingsStore.subscribe((state) => {
  if (state.settings.theme !== lastAppliedTheme) {
    lastAppliedTheme = state.settings.theme;
    applyTheme(state.settings.theme);
  }
});

// 启动 cron 镜像监视器（幂等，仅此处调用一次）：
// 聊天中智能体经内置 cron 工具创建的定时任务，其工具执行行经 SSE
// 聚合进 message.process，监视器将其镜像进任务列表（去重幂等，
// 持久化恢复重放不会重复建任务）。
startCronMirrorWatcher();
// 全局轮询定时任务执行记录：使已完成的定时任务自动同步进会话列表，
// 不再依赖用户手动打开定时任务页（TasksPage 已移除自身定时器）
startCronRunsPoller();

const container = document.getElementById('root');
if (!container) throw new Error('未找到 #root 挂载点');

createRoot(container).render(
  <React.StrictMode>
    <ThemeGate>
      <RouterProvider router={router} />
    </ThemeGate>
  </React.StrictMode>,
);
