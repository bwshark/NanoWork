import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ROUTES } from '@/lib/constants';
import { App } from '@/App';
import { ChatPage } from '@/pages/chat/ChatPage';
import { AgentsPage } from '@/pages/agents/AgentsPage';
import { MyAgentsPage } from '@/pages/agents/MyAgentsPage';
import { SkillsPage } from '@/pages/skills/SkillsPage';
import { McpPage } from '@/pages/mcp/McpPage';
import { PluginsPage } from '@/pages/plugins/PluginsPage';
import { TasksPage } from '@/pages/tasks/TasksPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';
import { ArtifactsPage } from '@/pages/artifacts/ArtifactsPage';
import { MemoryPage } from '@/pages/memory/MemoryPage';
import { PersonaPage } from '@/pages/persona/PersonaPage';
import { ImChannelsPage } from '@/pages/im/ImChannelsPage';

/** React Router 7 路由表（/artifacts 为 P2 占位/基础；/memory 为记忆页；/persona 为人格页；/im 为 IM 频道页） */
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
      { path: ROUTES.plugins, element: <PluginsPage /> },
      { path: ROUTES.tasks, element: <TasksPage /> },
      { path: ROUTES.settings, element: <SettingsPage /> },
      { path: ROUTES.artifacts, element: <ArtifactsPage /> },
      { path: ROUTES.memory, element: <MemoryPage /> },
      { path: ROUTES.persona, element: <PersonaPage /> },
      { path: ROUTES.im, element: <ImChannelsPage /> },
      { path: '*', element: <Navigate to={ROUTES.chat} replace /> },
    ],
  },
]);
