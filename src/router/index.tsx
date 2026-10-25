import { Suspense, lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ROUTES } from '@/lib/core/constants';
import { App } from '@/App';
import { AppLayout } from '@/layout/AppLayout';
import { RouteFallback } from '@/layout/RouteFallback';

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
 *
 * ## [LOCAL PATCH] FR-13.5：页面全部改为懒加载
 *
 * 改之前 10 个页面**全是静态 import**，于是「侧栏 + 聊天页 + 技能页 + 审计页 +
 * 任务页 + 产物页 + mermaid + markdown」被一次性压进入口 chunk 的**静态依赖图**，
 * Vite 据此在 `index.html` 里给它们全打 `modulepreload` —— 首屏为一个用户可能
 * 永远不打开的页面付了全款（实测 `markdown` 一块 772 KB 就在首屏）。
 * 懒加载之后每个页面各自成 chunk，**只有真正被访问的那个才下载**。
 *
 * 三条边界（都不是随手定的）：
 *
 * 1. **`App` / `AppLayout` / `RouteFallback` 保持静态**。它们是**所有**路由的壳，
 *    懒加载它们等于「每次切页都要先等壳」，净收益为负 —— 壳本身就是首屏。
 * 2. **`Suspense` 边界放在 `<AppLayout>` 内的 `<Outlet />` 外**，不在这一层的
 *    路由表上：放这里能让侧栏 / 标题栏 / 产物面板在切页期间**保持挂载**，只有
 *    内容区走 fallback。挂在路由表上会让整棵带壳布局一起卸载重建 ——
 *    表现是「切个页侧栏闪一下、滚动位置全丢」。
 * 3. **`/auth` 自己一个边界**：它在 `AppLayout` 之外（全屏页），拿不到上面那个。
 *    少了它，`/auth` 的懒加载会一路上抛到最近的边界——而根级**没有**边界，
 *    React 会直接抛错（这是懒加载最常见的第一次踩坑：首页正常、全屏页白屏）。
 */

/**
 * 把「具名导出的页面」包成一个 `React.lazy` 组件。
 *
 * 为什么不直接把页面改成 `export default`：这些页面都写成具名导出，且被测试与
 * 别处直接 `import { ChatPage }`。为了让懒加载而给每个页面加一个默认导出，是把
 * **路由层**的实现细节泄漏给**所有**调用方。映射一次，只在这里。
 *
 * `导出缺失`时**抛错而不是渲染 undefined**：页面改名 / 大小写写错时，抛错会立刻
 * 在控制台指出缺哪个导出；而返回 `undefined` 会让 React 报一句与真因无关的
 * 「Element type is invalid」，然后页面白屏 —— 那是本次改动最该避免的症状。
 */
function lazyPage(
  loader: () => Promise<unknown>,
  exportName: string,
): LazyExoticComponent<ComponentType> {
  return lazy(async () => {
    const module = (await loader()) as Record<string, ComponentType | undefined>;
    const Page = module[exportName];
    if (Page === undefined) {
      throw new Error(`路由页导出缺失：${exportName}`);
    }
    return { default: Page };
  });
}

// ⚠️ 这些 `const` **必须**写在 `createBrowserRouter([...])` **之前**：模块求值时
// 路由表会立刻读它们，而 `const` 没有提升 —— 写在后面就是
// `ReferenceError: Cannot access 'ChatPage' before initialization`，
// 表现为「应用一行都没跑起来」（tsc 的 TS2448/TS2454 正是这条）。
const ChatPage = lazyPage(() => import('@/pages/chat/ChatPage'), 'ChatPage');
const AgentsPage = lazyPage(() => import('@/pages/agents/AgentsPage'), 'AgentsPage');
const MyAgentsPage = lazyPage(() => import('@/pages/agents/MyAgentsPage'), 'MyAgentsPage');
const SkillsPage = lazyPage(() => import('@/pages/skills/SkillsPage'), 'SkillsPage');
const McpPage = lazyPage(() => import('@/pages/mcp/McpPage'), 'McpPage');
const TasksPage = lazyPage(() => import('@/pages/tasks/TasksPage'), 'TasksPage');
const SettingsRoute = lazyPage(() => import('@/pages/settings/SettingsRoute'), 'SettingsRoute');
const ArtifactsPage = lazyPage(() => import('@/pages/artifacts/ArtifactsPage'), 'ArtifactsPage');
const AuditPage = lazyPage(() => import('@/pages/audit/AuditPage'), 'AuditPage');
const KnowledgePage = lazyPage(() => import('@/pages/knowledge/KnowledgePage'), 'KnowledgePage');
const AuthPage = lazyPage(() => import('@/pages/auth/AuthPage'), 'AuthPage');

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.chat} replace /> },
      // 登录 / 注册页。**不是受保护页**：local-first，未登录不拦截任何本地路由，
      // 入口在侧栏账户菜单 / 设置「账户」分区里；点进去才到这里。
      {
        path: ROUTES.auth,
        element: (
          <Suspense fallback={<RouteFallback label="正在打开登录页…" />}>
            <AuthPage />
          </Suspense>
        ),
      },
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
          { path: ROUTES.audit, element: <AuditPage /> },
          { path: ROUTES.knowledge, element: <KnowledgePage /> },
          { path: '*', element: <Navigate to={ROUTES.chat} replace /> },
        ],
      },
    ],
  },
]);
