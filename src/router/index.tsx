import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ROUTES } from '@/lib/constants';
import { App } from '@/App';
import { AppLayout } from '@/layout/AppLayout';
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
 * 三层结构，每层各管一件事：
 *
 * 1. **根级 `'/'` → `<App>`**：只负责**启动副作用**（会话水合、设备号预热、模型 / 技能
 *    刷新、同步运行时装配）+ 全局 Toast，本身不画任何布局；
 * 2. **`<AppLayout>` 分组**：带壳的页面（侧栏 + 标题栏 + 设置弹窗 + 产物面板）；
 * 3. **`/auth` 与它平级**：全屏页，独占窗口。
 *
 * ⚠️ 全屏页**不能**提到根级去（另起一棵 `<AuthPage/>` 的树）：那样用户在 `/auth` 冷启动
 * （刷新 / 从书签进）会跳过整条启动链，登录成功跳回聊天页时会话列表还是空的。所以它
 * 留在 `<App>` 之下、只是**不在 `AppLayout` 之下**——这是「无侧栏」的唯一正确落点：
 * 藏侧栏（CSS / 条件渲染）会让 `100vh` 和弹窗层级都变得不可推理。
 *
 * ⚠️ 这里**只有页面级路由**。记忆 / 人格 / 助理 / 插件收进设置弹窗后不再是独立页面
 * （弹窗挂在 `AppLayout`，不属于路由），对应路由已删。`/settings` 保留但语义变了：
 * 打开弹窗 + 重定向，见 `SettingsRoute`。
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.chat} replace /> },
      // 登录 / 注册页。**不是受保护页**：local-first，未登录不拦截任何本地路由，
      // 入口在侧栏账户菜单 / 设置「账户」分区里；点进去才到这里。
      { path: ROUTES.auth, element: <AuthPage /> },
      {
        element: <AppLayout />,
        children: [
          { path: ROUTES.chat, element: <ChatPage /> },
          { path: ROUTES.agents, element: <AgentsPage /> },
          { path: ROUTES.myAgents, element: <MyAgentsPage /> },
          { path: ROUTES.skills, element: <SkillsPage /> },
          { path: ROUTES.mcp, element: <McpPage /> },
          { path: ROUTES.tasks, element: <TasksPage /> },
          { path: ROUTES.settings, element: <SettingsRoute /> },
          { path: ROUTES.artifacts, element: <ArtifactsPage /> },
          { path: '*', element: <Navigate to={ROUTES.chat} replace /> },
        ],
      },
    ],
  },
]);
