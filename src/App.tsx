import { useEffect, useRef } from 'react';
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
import { useSessionsStore } from '@/stores/sessionsStore';
import { useStorageInfoStore } from '@/stores/storageInfoStore';
import { PromptLibrary } from '@/lib/promptLibrary';
import { IdentityService } from '@/lib/identity';
import { getDeviceId } from '@/lib/deviceId';
import { disposeSyncRuntime, initSyncRuntime } from '@/sync';
import type { SyncRuntime } from '@/sync';

/**
 * 顶层壳：AppLayout（侧栏 + 横幅 + Outlet）+ 全局 Toast + 权限门控弹窗。
 * 挂载时等待网关就绪（带退避重试，吸收 Python 进程冷启动空窗），
 * 并刷新本地技能目录与模型目录（来源 nanobot 配置）；
 * 桌面端还会把已保存的 IM 频道配置校准进 nanobot（幂等，无变化不重启网关）。
 */
export function App() {
  // 同步运行时的持有引用：`dispose()` 在卸载清理函数里调用（见下）。
  const syncRuntimeRef = useRef<SyncRuntime | null>(null);

  useEffect(() => {
    // 会话水合：列表来自事件流索引（不扫 JSONL），当前会话的消息按需加载。
    // 这是「事件流是事实源」的读入口——取代了旧版整块持久化的自动恢复。
    // 持有其 Promise：下面的同步运行时启动块要 `await` 它（见 §G.4 顺序约束）。
    const sessionsReady = useSessionsStore.getState().loadSessions();
    // 存储信息：缓存目录 / 卷容量 / 内置默认工作空间目录。
    // **必须在会话创建之前拿到**——新建任务的 workdir 缺省落到默认工作空间，
    // 而内置默认路径（`<home>/NanoWork`）只有主进程算得出来，渲染层同步取不到。
    void useStorageInfoStore.getState().refresh();
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
    // 提示词模板与身份文件（L4）外置库：**只在启动时异步读盘一次**，装配时
    // 用同步快照取用（见 PromptLibrary 的模块注释——注入点不能 await）。
    // 读盘失败/未完成时退化为「内置提示词 + 无身份文件」，不影响发消息。
    void PromptLibrary.loadAll();
    void IdentityService.loadAll();
    // 设备标识（同步元数据 `updatedBy` 的来源）：**启动预热一次**，运行时用
    // `currentDeviceId()` 同步读快照。store 的写动作是同步的，标记 `markDirty` 时
    // 拿不到 Promise——不预热就只能在写的那一刻拿空值。
    // 这里不再单独 `void`：改由下面的同步运行时启动块 `await`（syncMeta.updatedBy 依赖它）。
    //
    // ── 云同步运行时（批次 4，§G.4）──
    // 顺序约束：
    // 1. 必须在 `getDeviceId()` **之后**：`settingsStore.syncMeta` 的 `updatedBy`
    //    （`metaForEdit` → `currentDeviceId()`）与 push 负载的 `updatedBy` 都取设备号，
    //    预热未完成则落空串（`syncStamp.ts` 已说明空串 = 来源未知）；
    // 2. 必须在 `loadSessions()` **之后**：`init()` 可能立即 `engine.start()` → pull →
    //    落地 `sessionMeta`；内存 `sessions` 未就位时会与即将水合的列表产生竞态。
    // 用模块级单例（`initSyncRuntime`）：徽章 / 设置页一律 `getSyncRuntime()` 取用，
    // 避免各造一份 runtime（各订阅一次 8 个 store、各起一条 30s 定时同步）。
    // 卸载标记：异步启动块若在组件卸载后才完成，不应再建 runtime。
    let unmounted = false;
    void (async () => {
      await getDeviceId();
      await sessionsReady;
      if (unmounted) return;
      const runtime = await initSyncRuntime();
      if (unmounted) {
        disposeSyncRuntime();
        return;
      }
      syncRuntimeRef.current = runtime;
    })();
    // 启动回读：本地缺失的渠道配置从 nanobot config.json 反向补齐（回显）；
    // 随后校准：把本地已保存的频道配置同步进 nanobot，保证历史配置自动生效。
    // 主进程合并是幂等的（配置一致时返回 changed=false 且不重启网关）；
    // Web 端无文件系统权限，跳过以免每次加载触发下载。
    if (platform.env === 'electron') {
      void (async () => {
        /*
         * 渠道凭据保险库：**必须最先读**。两个理由：
         * 1. `channelsStore.partialize` 用 `vaultAvailable` 当「敢不敢剥明文」的开关——
         *    晚读一步，这次启动的持久化就会把明文又写一遍；
         * 2. UI 与回读链路要用 key 名清单判「已设置凭据」，并据此决定表单里的密钥字段
         *    是「必填」还是「留空则不修改」。
         * 顺序反了都不会报错，只是静默地少剥一次明文 / 少显示一处状态。
         */
        await useChannelsStore.getState().refreshSecrets();
        // 存量明文凭据（升级前落盘的那批）一次性收进保险库，之后才敢剥明文
        await useChannelsStore.getState().vaultExistingSecrets();
        await useChannelsStore.getState().hydrateFromNanobot();
        if (useChannelsStore.getState().configs.length > 0) {
          await useChannelsStore.getState().syncAll();
        }
        // 凭据保险库：**必须先读 key 名清单**，MCP 回读要用它来标注「已设置凭据」。
        // 顺序反了不会报错，只是回显的凭据状态是空的——静默且难查。
        await useMcpStore.getState().refreshSecrets();
        // MCP 回读：本地缺失的 MCP 配置从 nanobot config.json 反向补齐（仅追加，不覆盖）
        await useMcpStore.getState().hydrateFromNanobot();
      })().catch(() => undefined);
    }
    // 频道会话列表轮询：IM 新对话 / 新消息以秒级延迟进入「频道」列表与聊天页
    useChannelSessionsStore.getState().startPolling();
    return () => {
      unmounted = true;
      useChannelSessionsStore.getState().stopPolling();
      connectionManager.stopHeartbeat();
      // 释放同步运行时：取消 8 个 store 订阅 + 账户订阅并停调度（置空单例，可重 init）
      disposeSyncRuntime();
      syncRuntimeRef.current = null;
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
