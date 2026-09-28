import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ROUTES } from '@/lib/constants';
import { App } from '@/App';
import { ChatPage } from '@/pages/chat/ChatPage';
import { AgentsPage } from '@/pages/agents/AgentsPage';
import { MyAgentsPage } from '@/pages/agents/MyAgentsPage';
import { SkillsPage } from '@/pages/skills/SkillsPage';
import { McpPage } from '@/pages/mcp/McpPage';
import { TasksPage } from '@/pages/tasks/TasksPage';
import { SettingsRoute } from '@/pages/settings/SettingsRoute';
import { ArtifactsPage } from '@/pages/artifacts/ArtifactsPage';
import { AuthPage } from '@/pages/auth/AuthPage';

/**
 * React Router 7 路由表。
 *
 * ⚠️ 这里**只有页面级路由**。记忆 / 人格 / 助理 / 插件在收进设置弹窗后不再是独立
 * 页面（弹窗挂在 `AppLayout`，不属于路由），因此对应的四条路由已删。
 * `/settings` 保留但语义变了：打开弹窗 + 重定向，见 `SettingsRoute`。
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.chat} replace /> },
      { path: ROUTES.chat, element: <ChatPage /> },
      { path: ROUTES.agents, element: <AgentsPage /> },
      { path: ROUTES.myAgents, element: <MyAgentsPage /> },
      { path: ROUTES.skills, element: <SkillsPage /> },
      { path: ROUTES.mcp, element: <McpPage /> },
      { path: ROUTES.tasks, element: <TasksPage /> },
      { path: ROUTES.settings, element: <SettingsRoute /> },
      { path: ROUTES.artifacts, element: <ArtifactsPage /> },
      // 登录 / 注册页。**不是受保护页**：local-first，未登录不拦截任何本地路由，
      // 只把入口收在设置「账户」分区 / 状态徽章里；点进去才到这里。
      { path: ROUTES.auth, element: <AuthPage /> },
      { path: '*', element: <Navigate to={ROUTES.chat} replace /> },
    ],
  },
]);
