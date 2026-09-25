import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import { platform } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { ensureMetaList, pickMeta, withTombstone, withoutTombstone } from '@/lib/syncMeta';
import { metaForDelete, metaForEdit, metaForNew } from '@/lib/syncStamp';
import { getRuntime, type SyncResult } from '@/ai/runtime';
import { MCP_SERVERS } from '@/ai/builtinMcps';
import {
  BUILTIN_MCP_PREFIX,
  isBuiltinMcpId,
  type MCPConfig,
  type MCPStatus,
  type SyncTombstones,
} from '@/types';
import type {
  CredentialVaultStatus,
  McpProbeResult,
  SecretWriteResult,
} from '@/platform/types';

interface McpState {
  configs: MCPConfig[];
  /**
   * 已删除条目的墓碑表（`id → 删除元数据`）。
   * 与 `configs` 分开存，理由同 `agentsStore.tombstones`。
   */
  tombstones: SyncTombstones;
  /**
   * 凭据保险库可用性（`null` = 尚未查询）。
   * 用来决定「凭据是否加密保存」这句提示怎么写——不可用时必须显式告知，
   * 而不是让用户以为已经加密。
   */
  vaultAvailable: boolean | null;
  /** 各 server 已配置的凭据 **key 名清单**（值为空：密钥不出主进程） */
  secretKeys: Record<string, string[]>;
  addConfig: (partial?: Partial<MCPConfig>) => MCPConfig;
  updateConfig: (id: string, patch: Partial<MCPConfig>) => void;
  removeConfig: (id: string) => void;
  /** 切换启用状态（builtin/user 通用） */
  toggleMcp: (id: string) => void;
  setMcpEnabled: (id: string, enabled: boolean) => void;
  /**
   * 真实连接测试（FR-3.2）。
   *
   * 走主进程探针：真实 `initialize` + `tools/list` 握手，并把发现的工具清单
   * 缓存到配置上（工具级授权的候选来源）。**探测失败不清空已有清单**——
   * 一次网络抖动不该把用户的授权视图擦掉。
   */
  testConfig: (id: string) => Promise<McpProbeResult>;
  /** 切换单个工具的授权（黑名单：列入即不注册进引擎） */
  setToolDisabled: (id: string, toolName: string, disabled: boolean) => void;
  /** 读取保险库可用性与 key 名清单（启动时与写入后各调一次） */
  refreshSecrets: () => Promise<CredentialVaultStatus>;
  /**
   * 保存某条 MCP 的凭据。
   * - electron：写加密保险库，成功后才把 key 名清单落到配置上；
   * - web：无系统凭据库，保持既有的明文持久化（界面会明确标注）。
   */
  saveSecrets: (id: string, secrets: Record<string, string>) => Promise<SecretWriteResult>;
  /**
   * 同步到 nanobot 运行时：
   * - electron：主进程把已启用条目合并写入 config.json tools.mcpServers，
   *   并从保险库补齐凭据，按需重启 serve 子进程；
   * - web：无文件系统权限，降级为下载合并后的片段文件，
   *   返回 needsRestart=true，由用户手动合并并重启网关。
   * 返回主进程/平台层的同步结果描述。
   */
  syncConfig: (id: string) => Promise<SyncResult>;
  /** 同步全部已启用条目（同 syncConfig 的批量版） */
  syncEnabled: () => Promise<SyncResult>;
  /** 启动回读：从 nanobot config.json 反向补齐本地缺失的 MCP 条目（仅追加，不覆盖） */
  hydrateFromNanobot: () => Promise<void>;
  setStatus: (id: string, status: MCPStatus) => void;
}

/** 从草稿里取凭据的 key 名清单（排序后稳定，便于比较与展示） */
function secretKeyNames(secrets: Record<string, string> | undefined): string[] {
  if (!secrets) return [];
  return Object.keys(secrets)
    .filter((key) => key !== '' && typeof secrets[key] === 'string' && secrets[key] !== '')
    .sort();
}

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
          // 同步元数据随用户覆盖一起保留（理由同 agentsStore 的 mergeAgents）
          ...pickMeta(over),
        }
      : { ...b };
  });

  // user：保留持久化条目（可能比 builtin 旧，转换老数据为 user）。
  // 本函数只处理**存活**条目——删除的痕迹在 `tombstones` 表里，与此无关
  const user = stored
    .filter((c) => !isBuiltinMcpId(c.id))
    .map((c) => ({ ...c, source: (c.source ?? 'user') as 'user' }));

  return [...builtin, ...user];
}

/**
 * 把 Chat UI 需要的「候选 MCP 列表」挑出来：
 * 已启用条目（builtin/user 统一语义：enabled !== false，
 * 老数据 undefined 默认启用，向后兼容）。
 *
 * 本函数是两个同步路径（`syncConfig` / `syncEnabled`）取「要写进引擎的条目」的
 * 唯一入口。列表天生只含存活条目，所以被用户删掉的 MCP 不会再被写回 `config.json`。
 */
export function selectEnabledConfigs(configs: MCPConfig[]): MCPConfig[] {
  return configs.filter((c) => c.enabled !== false);
}

export const useMcpStore = create<McpState>()(
  persist(
    (set, get) => ({
      configs: mergeConfigs([]),
      tombstones: {},
      vaultAvailable: null,
      secretKeys: {},

      addConfig: (partial) => {
        // createdAt 与同步元数据的 updatedAt 取同一时刻：两处各自 `nowIso()`
        // 会差几毫秒，「创建时间」与「首次修改时间」对不上而没人知道为什么
        const stamp = metaForNew();
        const config: MCPConfig = {
          id: genId(),
          name: partial?.name ?? '新 MCP 服务',
          transport: (partial?.transport ?? 'url') as MCPConfig['transport'],
          endpoint: partial?.endpoint,
          // 传输方式必须一起带上：漏掉它，用户在下拉里选的 SSE 会被静默丢弃，
          // 表现成「选了还报 405」——最难自查的一类（配置看着对、写出去的是别的值）
          urlType: partial?.urlType,
          command: partial?.command,
          auth: partial?.auth,
          status: 'idle',
          source: 'user',
          enabled: true,
          createdAt: stamp.updatedAt,
          ...stamp,
        };
        set((s) => ({
          configs: [...s.configs, config],
          // 同 id 重新出现 = 「删除后又建回来」：清掉旧墓碑，否则同步会把这个刚建好
          // 的条目按「已删除」推出去，而本机看起来一切正常（理由同 agentsStore）
          tombstones: withoutTombstone(s.tombstones, config.id),
        }));
        return config;
      },

      // 元数据在 patch 之后展开，理由同 agentsStore.updateAgent
      updateConfig: (id, patch) =>
        set((s) => ({
          configs: s.configs.map((c) => (c.id === id ? { ...c, ...patch, ...metaForEdit(c) } : c)),
        })),

      /** 删除自定义 MCP；builtin 拒绝删除（保护内置目录） */
      removeConfig: (id) => {
        const cfg = get().configs.find((c) => c.id === id);
        // builtin 不可删，保持现有语义
        if (!cfg || isBuiltinMcpId(cfg.id)) return;
        /*
         * 删除 = **摘除条目 + 留墓碑**（与 agentsStore.removeAgent 同一形态）。
         * 摘除让 `configs` 天生只含存活条目——UI（`s.configs`）与下面两条同步路径
         * （`selectEnabledConfigs`）都不必再过滤；墓碑让删除能被 LWW 传播到别的设备。
         * 见 `types/sync.ts` 的 `SyncTombstones`。
         */
        set((s) => ({
          configs: s.configs.filter((c) => c.id !== id),
          tombstones: withTombstone(s.tombstones, id, metaForDelete(cfg)),
        }));
        // 凭据一并清理：条目没了而密钥还留在保险库里，是一份没有归属的明文
        // （且下次同名 server 会被"自动带上旧凭据"，是最难排查的一类串味）
        if (platform.env === 'electron') {
          void platform
            .secretsDelete(cfg.name)
            .then(() => get().refreshSecrets())
            .catch((err) => console.warn('[mcp] 删除凭据失败：', err));
        }
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
            c.id === id
              ? { ...c, enabled: !(c.enabled ?? !isBuiltinMcpId(c.id)), ...metaForEdit(c) }
              : c,
          ),
        })),

      setMcpEnabled: (id, enabled) =>
        set((s) => ({
          configs: s.configs.map((c) => (c.id === id ? { ...c, enabled, ...metaForEdit(c) } : c)),
        })),

      setStatus: (id, status) =>
        set((s) => ({
          configs: s.configs.map((c) => (c.id === id ? { ...c, status } : c)),
        })),

      refreshSecrets: async () => {
        const status = await platform.secretsStatus();
        const keys = await platform.secretsKeys();
        set({ vaultAvailable: status.available, secretKeys: keys });
        return status;
      },

      saveSecrets: async (id, secrets) => {
        const cfg = get().configs.find((c) => c.id === id);
        if (!cfg) return { ok: false, error: '未找到对应 MCP 配置' };
        const names = secretKeyNames(secrets);

        if (platform.env !== 'electron') {
          // Web 端没有系统凭据库：保持既有的明文持久化，界面会标注"未加密"。
          // 这里刻意不返回 ok:false——Web 端的凭据本来就不落保险库，
          // 报错只会让用户以为保存失败了。
          get().updateConfig(id, { auth: { ...secrets }, authKeyNames: names });
          return { ok: true };
        }

        const result = await platform.secretsSet(cfg.name, secrets);
        if (!result.ok) return result;
        // 写入成功才更新"已配置"视图：否则界面显示已设置、实际保险库里没有，
        // 而失败是静默的——用户永远不会自己发现。
        get().updateConfig(id, { auth: undefined, authKeyNames: names });
        await get().refreshSecrets();
        return { ok: true };
      },

      testConfig: async (id) => {
        const cfg = get().configs.find((c) => c.id === id);
        if (!cfg) {
          return {
            ok: false,
            status: 'error',
            tools: [],
            error: '未找到对应 MCP 配置',
            latencyMs: 0,
          };
        }
        get().setStatus(id, 'syncing');
        // 探针按 name 自己查凭据：渲染层手上没有明文密钥，也不需要知道
        const result = await platform.probeMcpServer({
          name: cfg.name,
          transport: cfg.transport,
          endpoint: cfg.endpoint,
          command: cfg.command,
          urlType: cfg.urlType,
        });
        // 实测到的传输方式要落回配置：引擎按它挑 client（sse / streamableHttp），
        // 与实际不符就是「测试通过、聊天时连不上」。只在探测成功且与当前不同时写，
        // 避免每次点测试都动一次 state（会白白触发重渲染与持久化）。
        const urlTypeChanged = Boolean(
          result.ok && result.transport && result.transport !== cfg.urlType,
        );
        /*
         * 刻意**不走 `updateConfig`**：探测结果（`status` / `tools` / `lastProbedAt`）
         * 是运行时事实，本机重算，不算「用户改过这条配置」——走 updateConfig 会让
         * 每点一次「测试」就递增一次 `rev`，版本号里掺进噪声，同步层就没法用它判
         * 「谁的改动更新」。
         *
         * 但 `urlType` 是**声明**：实测值落回时必须标记，否则「测试通过、聊天连不上」
         * 的这次修复传不到别的设备。两类字段混在同一次 set 里，所以要分开判断。
         */
        set((s) => ({
          configs: s.configs.map((c) => {
            if (c.id !== id) return c;
            const next: MCPConfig = {
              ...c,
              status: result.ok ? 'connected' : 'error',
              // 失败时保留上次清单：一次抖动不该让授权视图变成空白
              tools: result.ok ? result.tools : c.tools,
              lastProbedAt: result.ok ? Date.now() : c.lastProbedAt,
              ...(urlTypeChanged ? { urlType: result.transport } : {}),
            };
            return urlTypeChanged ? { ...next, ...metaForEdit(c) } : next;
          }),
        }));
        return result;
      },

      setToolDisabled: (id, toolName, disabled) =>
        set((s) => ({
          configs: s.configs.map((c) => {
            if (c.id !== id) return c;
            const next = new Set(c.disabledTools ?? []);
            if (disabled) next.add(toolName);
            else next.delete(toolName);
            const list = [...next].sort();
            // 空黑名单收敛为 undefined：让"无限制"只有一种表示，
            // 避免 [] 与 undefined 两态在比较/序列化时来回抖动
            return {
              ...c,
              disabledTools: list.length > 0 ? list : undefined,
              ...metaForEdit(c),
            };
          }),
        })),

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
          const result = await getRuntime().sync('connectors', targets);
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
        // 空集的特殊语义（web 短路 / electron 提交空字典以清空运行时）已收敛到
        // 契约层实现（nanobotHttp/config.ts 的 syncMcpToRuntime），store 不再重复判断。
        targets.forEach((c) => get().setStatus(c.id, 'syncing'));
        try {
          const result = await getRuntime().sync('connectors', targets);
          targets.forEach((c) => get().setStatus(c.id, 'connected'));
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
            // web 端无文件系统权限：回读返回空数组，天然短路
            const remote = await getRuntime().read('connectors');
            if (remote.length === 0) return;
            // 引擎配置里的凭据是**明文**（引擎消费必需）。electron 上不回灌它：
            // 回灌等于把明文又搬进渲染层，白加密一遍。改为从保险库取 key 名清单。
            const secretKeys = get().secretKeys;
            const sanitized = remote.map((c) => {
              if (platform.env !== 'electron') return c;
              const names = secretKeys[c.name];
              return {
                ...c,
                auth: undefined,
                authKeyNames: names && names.length > 0 ? names : undefined,
              };
            });
            // 按名称去重：仅追加本地缺失的条目，不覆盖本地已有配置。
            // 两道判据：
            // - 名字：`configs` 只含存活条目，所以「被用户删掉的」不会阻止回读；
            // - 墓碑：引擎侧 job/配置还没被清理干净时（上一次同步失败、或引擎自行
            //   写入了同名条目），回读会把用户刚删掉的 MCP 原样搬回来。删除是**显式
            //   事实**，不因回读而复活——与 tasksStore.addTask 对墓碑的处理同一条规则。
            const localNames = new Set(get().configs.map((c) => c.name));
            const tombstones = get().tombstones;
            const missing = sanitized.filter(
              (c) => !localNames.has(c.name) && !(c.id in tombstones),
            );
            if (missing.length === 0) return;
            set((s) => ({
              configs: [...s.configs, ...missing.map((c) => ({ ...c, ...metaForNew() }))],
            }));
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
      /**
       * 持久化时**剔除凭据明文**（electron）。
       *
       * `auth` 是编辑草稿，不是持久化字段：密钥的落地形态只有加密保险库与
       * 引擎配置两份。若不剔除，`~/.nanowork/mcp.json` 里就是一串明文
       * `Bearer xxx`——那正是本次要消掉的那份副本。
       *
       * Web 端没有保险库，凭据只能落在 localStorage（浏览器环境的既有限制，
       * 界面会明确标注"未加密"），因此 Web 保持原样。
       */
      partialize: (s) => ({
        configs:
          platform.env === 'electron'
            ? s.configs.map((c) => ({ ...c, auth: undefined }))
            : s.configs,
        tombstones: s.tombstones,
      }),
      // v1：给存量数据补同步元数据四字段（缺字段按 `LEGACY_REV` 落盘）、补空墓碑表
      version: 1,
      migrate: (persisted) => {
        const p = persisted as
          | { configs?: MCPConfig[]; tombstones?: SyncTombstones }
          | undefined;
        return {
          configs: ensureMetaList(p?.configs),
          tombstones: p?.tombstones ?? {},
        };
      },
      merge: (persisted, current) => {
        // 反序列化时再合并一次，以确保 builtin 与新版本代码同步
        const persistedConfigs =
          (persisted as { configs?: MCPConfig[] } | undefined)?.configs ?? [];
        return {
          ...current,
          configs: mergeConfigs(persistedConfigs),
          tombstones:
            (persisted as { tombstones?: SyncTombstones } | undefined)?.tombstones ??
            current.tombstones,
        };
      },
    },
  ),
);
