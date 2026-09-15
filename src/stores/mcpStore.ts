import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import { platform } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { syncToNanobotRuntime, toNanobotMCP, fromNanobotMCP } from '@/ai/nanobotConfig';
import { MCP_SERVERS } from '@/ai/builtinMcps';
import {
  BUILTIN_MCP_PREFIX,
  isBuiltinMcpId,
  type MCPConfig,
  type MCPStatus,
} from '@/types';

interface McpState {
  configs: MCPConfig[];
  addConfig: (partial?: Partial<MCPConfig>) => MCPConfig;
  updateConfig: (id: string, patch: Partial<MCPConfig>) => void;
  removeConfig: (id: string) => void;
  /** 切换启用状态（builtin/user 通用） */
  toggleMcp: (id: string) => void;
  setMcpEnabled: (id: string, enabled: boolean) => void;
  /** 连接测试（短暂 syncing 后 connected） */
  testConfig: (id: string) => Promise<void>;
  /**
   * 同步到 nanobot 运行时：
   * - electron：主进程把已启用条目合并写入 config.json tools.mcpServers，
   *   并按需重启 serve 子进程；
   * - web：无文件系统权限，降级为下载合并后的片段文件，
   *   返回 needsRestart=true，由用户手动合并并重启网关。
   * 返回主进程/平台层的同步结果描述。
   */
  syncConfig: (id: string) => Promise<MCPSyncResult>;
  /** 同步全部已启用条目（同 syncConfig 的批量版） */
  syncEnabled: () => Promise<MCPSyncResult>;
  /** 启动回读：从 nanobot config.json 反向补齐本地缺失的 MCP 条目（仅追加，不覆盖） */
  hydrateFromNanobot: () => Promise<void>;
  setStatus: (id: string, status: MCPStatus) => void;
}

/** 同步结果描述（与 platform.syncNanobotMcp 形态对齐） */
export interface MCPSyncResult {
  ok: boolean;
  message: string;
  /** 配置是否实际发生变更 */
  changed?: boolean;
  /** 已写入但网关由外部进程托管，需用户自行重启 */
  needsRestart?: boolean;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 回读并发保护：启动期多次调用只执行一次 */
let hydratePromise: Promise<void> | null = null;

/**
 * 合并 builtin 与持久化条目：
 *   - builtin：以当前代码中的 MCP_SERVERS 为准，保留用户覆盖的 enabled 状态；
 *   - user：完全保留持久化条目。
 */
function mergeConfigs(stored: MCPConfig[]): MCPConfig[] {
  const storedMap = new Map(stored.map((c) => [c.id, c]));

  // builtin：取代码版本，enabled 走用户覆盖
  const builtin = MCP_SERVERS.map((b) => {
    const over = storedMap.get(b.id);
    return over && isBuiltinMcpId(b.id)
      ? {
          ...b,
          enabled: over.enabled ?? b.enabled,
          status: over.status ?? b.status,
        }
      : { ...b };
  });

  // user：保留持久化条目（可能比 builtin 旧，转换老数据为 user）
  const user = stored
    .filter((c) => !isBuiltinMcpId(c.id))
    .map((c) => ({ ...c, source: (c.source ?? 'user') as 'user' }));

  return [...builtin, ...user];
}

/**
 * 把 Chat UI 需要的「候选 MCP 列表」挑出来：
 * 已启用条目（builtin/user 统一语义：enabled !== false，
 * 老数据 undefined 默认启用，向后兼容）。
 */
export function selectEnabledConfigs(configs: MCPConfig[]): MCPConfig[] {
  return configs.filter((c) => c.enabled !== false);
}

export const useMcpStore = create<McpState>()(
  persist(
    (set, get) => ({
      configs: mergeConfigs([]),

      addConfig: (partial) => {
        const config: MCPConfig = {
          id: genId(),
          name: partial?.name ?? '新 MCP 服务',
          transport: (partial?.transport ?? 'url') as MCPConfig['transport'],
          endpoint: partial?.endpoint,
          command: partial?.command,
          auth: partial?.auth,
          status: 'idle',
          source: 'user',
          enabled: true,
        };
        set((s) => ({ configs: [...s.configs, config] }));
        return config;
      },

      updateConfig: (id, patch) =>
        set((s) => ({
          configs: s.configs.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        })),

      /** 删除自定义 MCP；builtin 拒绝删除（保护内置目录） */
      removeConfig: (id) => {
        const cfg = get().configs.find((c) => c.id === id);
        // builtin 不可删，保持现有语义
        if (!cfg || isBuiltinMcpId(cfg.id)) return;
        // 先从 store 移除，再触发同步，确保提交的是删除后的 configs
        set((s) => ({ configs: s.configs.filter((c) => c.id !== id) }));
        // 删除后立即全量同步（后台非阻塞）：把被删条目从 config.json 的
        // tools.mcpServers 中真正移除，避免下次启动 hydrate 重新回显；
        // 同步失败不影响本地删除结果。Web 端无文件系统权限，跳过。
        if (platform.env === 'electron') {
          void get()
            .syncEnabled()
            .catch((err) => console.warn('[mcp] 删除后同步失败：', err));
        }
      },

      toggleMcp: (id) =>
        set((s) => ({
          configs: s.configs.map((c) =>
            c.id === id ? { ...c, enabled: !(c.enabled ?? !isBuiltinMcpId(c.id)) } : c,
          ),
        })),

      setMcpEnabled: (id, enabled) =>
        set((s) => ({
          configs: s.configs.map((c) => (c.id === id ? { ...c, enabled } : c)),
        })),

      setStatus: (id, status) =>
        set((s) => ({
          configs: s.configs.map((c) => (c.id === id ? { ...c, status } : c)),
        })),

      testConfig: async (id) => {
        get().setStatus(id, 'syncing');
        await delay(700);
        get().setStatus(id, 'connected');
      },

      syncConfig: async (id) => {
        const cfg = get().configs.find((c) => c.id === id);
        if (!cfg) {
          return { ok: false, message: '未找到对应 MCP 配置' };
        }
        get().setStatus(id, 'syncing');
        // 主进程对 tools.mcpServers 是全量替换语义：单条提交会误删其它条目，
        // 故任何一次同步都完整写回全部启用条目（与 syncEnabled 一致）；
        // 删除语义不变：删除条目后再同步即从 config.json 移除。
        const targets = selectEnabledConfigs(get().configs);
        try {
          // 转为 nanobot 形态（以 server 名为键的字典），直接合并进
          // config.json 的 tools.mcpServers；web 端降级为下载片段。
          const fragmentJson = JSON.stringify(toNanobotMCP(targets));
          const result = await syncMcpViaPlatform(fragmentJson);
          get().setStatus(id, 'connected');
          return result;
        } catch (err) {
          get().setStatus(id, 'error');
          return {
            ok: false,
            message: `同步失败：${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },

      syncEnabled: async () => {
        const targets = selectEnabledConfigs(get().configs);
        // 仅 web 端对空集提前返回（无文件系统权限，避免下载空片段）；
        // electron 端空集必须照常提交：主进程对 tools.mcpServers 是全量替换语义，
        // 提交空字典（toNanobotMCP([]) → {}）可把已停用/已删除条目从 config.json
        // 真正清空，否则网关重启仍会加载残留条目，且 hydrate 会按名称回读「复活」。
        if (targets.length === 0 && platform.env !== 'electron') {
          return { ok: true, changed: false, message: '未启用任何 MCP，无需同步' };
        }
        targets.forEach((c) => get().setStatus(c.id, 'syncing'));
        try {
          const fragmentJson = JSON.stringify(toNanobotMCP(targets));
          const result = await syncMcpViaPlatform(fragmentJson);
          targets.forEach((c) => get().setStatus(c.id, 'connected'));
          // 空集提交成功：改写 message 以准确描述「清空运行时」语义
          if (targets.length === 0 && result.ok) {
            return {
              ...result,
              message: '未启用任何 MCP，已清空运行时的 MCP 同步',
            };
          }
          return result;
        } catch (err) {
          targets.forEach((c) => get().setStatus(c.id, 'error'));
          return {
            ok: false,
            message: `同步失败：${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },

      hydrateFromNanobot: () => {
        if (hydratePromise) return hydratePromise;
        hydratePromise = (async () => {
          try {
            if (platform.env !== 'electron') return;
            const snapshot = await platform.getNanobotMcp();
            if (!snapshot) return;
            const remote = fromNanobotMCP(snapshot);
            if (remote.length === 0) return;
            // 按名称去重：仅追加本地缺失的条目，不覆盖本地已有配置
            const localNames = new Set(get().configs.map((c) => c.name));
            const missing = remote.filter((c) => !localNames.has(c.name));
            if (missing.length === 0) return;
            set((s) => ({ configs: [...s.configs, ...missing] }));
          } catch {
            // 回读失败不影响主流程：保持本地状态
          } finally {
            hydratePromise = null;
          }
        })();
        return hydratePromise;
      },
    }),
    {
      name: STORAGE_KEYS.mcp,
      storage: zustandStorage,
      partialize: (s) => ({ configs: s.configs }),
      merge: (persisted, current) => {
        // 反序列化时再合并一次，以确保 builtin 与新版本代码同步
        const persistedConfigs =
          (persisted as { configs?: MCPConfig[] } | undefined)?.configs ?? [];
        return {
          ...current,
          configs: mergeConfigs(persistedConfigs),
        };
      },
    },
  ),
);

/**
 * 经 platform 层同步 MCP 到 nanobot。
 * 若 platform 提供 syncNanobotMcp，则优先走它（electron 合并写盘 / web 下载）；
 * 否则降级为写一个 nanobot.mcp.json 片段文件（保留旧行为兼容）。
 */
async function syncMcpViaPlatform(fragmentJson: string): Promise<MCPSyncResult> {
  const platformWithMcp = platform as Partial<{
    syncNanobotMcp: (json: string) => Promise<MCPSyncResult>;
  }>;
  if (platformWithMcp.syncNanobotMcp) {
    return platformWithMcp.syncNanobotMcp(fragmentJson);
  }
  // 兜底：仅 web 端未启用新接口时（开发期）才会走到这里
  const target = await syncToNanobotRuntime(
    JSON.parse(fragmentJson).mcpServers as MCPConfig[],
  );
  return {
    ok: true,
    changed: true,
    needsRestart: true,
    message: `片段已导出到 ${target}，请手动合并进 nanobot config.json 并重启网关`,
  };
}
