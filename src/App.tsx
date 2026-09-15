import { useEffect } from 'react';
import { AppLayout } from '@/layout/AppLayout';
import { ToastContainer } from '@/components/Toast';
import { PermissionDialog } from '@/components/PermissionDialog';
import { connectionManager } from '@/ai/connectionManager';
import { platform } from '@/platform';
import { useSkillsStore } from '@/stores/skillsStore';
import { useModelsStore } from '@/stores/modelsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useChannelsStore } from '@/stores/channelsStore';
import { useChannelSessionsStore } from '@/stores/channelSessionsStore';
import { useMcpStore } from '@/stores/mcpStore';

/**
 * 顶层壳：AppLayout（侧栏 + 横幅 + Outlet）+ 全局 Toast + 权限门控弹窗。
 * 挂载时等待网关就绪（带退避重试，吸收 Python 进程冷启动空窗），
 * 并刷新本地技能目录与模型目录（来源 nanobot 配置）；
 * 桌面端还会把已保存的 IM 频道配置校准进 nanobot（幂等，无变化不重启网关）。
 */
export function App() {
  useEffect(() => {
    // 桌面端主进程与窗口是并行启动的：nanobot 为 Python 进程，spawn 后需数秒
    // 才真正 listen。若此处只探测一次，首探必然 ECONNREFUSED 并永久固化离线。
    void (async () => {
      const status = await connectionManager.waitUntilReady();
      if (status !== 'connected') return;
      // 首轮 refresh 发生在网关 listen 之前、必然失败且不会自动重试
      // （目录为空 + inflight 去重），就绪后补一次强制拉取
      await useModelsStore.getState().refresh();
      void useModelsStore.getState().refresh(true);
    })().catch(() => undefined);
    // 稳态心跳：网关中途重启 / 用户手动拉起后自动恢复「已连接」
    connectionManager.startHeartbeat();
    void useSkillsStore.getState().refresh();
    // 重新合并内置 Agent 与持久化数据，保证内置专家（如牧场专家）重启后恒在
    void useAgentsStore.getState().refresh();
    // 启动回读：本地缺失的渠道配置从 nanobot config.json 反向补齐（回显）；
    // 随后校准：把本地已保存的频道配置同步进 nanobot，保证历史配置自动生效。
    // 主进程合并是幂等的（配置一致时返回 changed=false 且不重启网关）；
    // Web 端无文件系统权限，跳过以免每次加载触发下载。
    if (platform.env === 'electron') {
      void (async () => {
        await useChannelsStore.getState().hydrateFromNanobot();
        if (useChannelsStore.getState().configs.length > 0) {
          await useChannelsStore.getState().syncAll();
        }
        // MCP 回读：本地缺失的 MCP 配置从 nanobot config.json 反向补齐（仅追加，不覆盖）
        await useMcpStore.getState().hydrateFromNanobot();
      })().catch(() => undefined);
    }
    // 频道会话列表轮询：IM 新对话 / 新消息以秒级延迟进入「频道」列表与聊天页
    useChannelSessionsStore.getState().startPolling();
    return () => {
      useChannelSessionsStore.getState().stopPolling();
      connectionManager.stopHeartbeat();
    };
  }, []);

  return (
    <>
      <AppLayout />
      <ToastContainer />
      <PermissionDialog />
    </>
  );
}
