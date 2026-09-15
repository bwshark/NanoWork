import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { getRuntime, type SyncResult } from '@/ai/runtime';
import type { ChannelConfig, ChannelKind } from '@/types';

/**
 * IM 频道配置 store（FR-010）。
 * 每个渠道至多一条配置（与 IM 频道页「一卡一配置」交互对齐）；
 * 持久化经 platform.storage。任何配置变更（保存 / 启停 / 删除）都会
 * 防抖后自动同步进 nanobot 运行时（合并 config.json + 重启网关），
 * 无需用户手动点击「同步」。
 */

/** 自动同步防抖间隔（毫秒）：合并连续的保存/启停为一次网关重启 */
const AUTO_SYNC_DEBOUNCE_MS = 600;

/** 防抖定时器句柄（模块级，跨 store 调用共享） */
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;

/** 最近一次同步结果摘要（供 UI 提示；不参与持久化） */
export interface ChannelSyncSummary {
  /** 同步完成时间（ISO 8601 UTC） */
  at: string;
  ok: boolean;
  message: string;
  /** 配置是否实际发生变更（幂等校准时为 false，UI 可据此静默） */
  changed?: boolean;
  needsRestart?: boolean;
}

interface ChannelsState {
  configs: ChannelConfig[];
  /** 最近一次同步结果（UI 据此弹提示） */
  lastSync: ChannelSyncSummary | null;
  /** 保存配置（同 kind 已存在则覆盖更新，否则新增）并触发自动同步；返回保存后的配置 */
  saveConfig: (partial: Partial<ChannelConfig> & { kind: ChannelKind }) => ChannelConfig;
  /** 移除某渠道配置并触发自动同步（同步空片段以清理 nanobot 侧残留） */
  removeConfig: (kind: ChannelKind) => void;
  /** 启用 / 停用某渠道并触发自动同步 */
  setEnabled: (kind: ChannelKind, enabled: boolean) => void;
  /** 同步到 nanobot 运行时（合并 channels 片段进 config.json 并重启网关） */
  syncAll: () => Promise<SyncResult>;
  /** 更新同步状态 */
  setSyncStatus: (id: string, status: ChannelConfig['syncStatus']) => void;
  /**
   * 启动回读：本地无某渠道配置时，从 nanobot config.json 的 channels 段
   * 反向映射补齐（配置可能直接在 nanobot 侧写入），使卡片与弹窗能回显。
   * 仅 electron 生效；本地已有配置的渠道以本地为准，不覆盖。
   * @returns 是否实际补齐了配置
   */
  hydrateFromNanobot: () => Promise<boolean>;
  /**
   * 强制回读（扫码接入成功后用）：从 nanobot config.json 回读指定 kind 的
   * 最新凭证并**覆盖**本地同 kind 配置（本地没有则新增）。
   * 扫码成功后凭证由引擎直接写入 config.json（如飞书 appSecret 仅存在于
   * 该文件），必须回读才能拿到；直接 set 覆盖，**不触发** scheduleAutoSync，
   * 避免回读又引发同步（旧片段反向覆盖引擎刚写入的凭证）。
   * 仅 electron 生效。
   * @returns 是否成功更新（回读到该 kind 条目并写入）
   */
  refreshFromNanobot: (kind: ChannelKind) => Promise<boolean>;
  /**
   * 断开扫码渠道连接后清本地状态（主进程断开成功后调用）：
   * 清该渠道本地凭证字段（微信 token；飞书 / Lark appId + appSecret），
   * 置 enabled=false；保留策略字段（allowFrom / groupPolicy / topicIsolation 等，
   * 重连后沿用）。直接 set，**不触发** scheduleAutoSync，并取消已排队的防抖同步、
   * 重置该渠道同步状态（防旧片段回写覆盖断开结果 / 卡片残留旧时间戳）——
   * 引擎侧凭证已由主进程直写清除，卡片自然回到未连接态。
   */
  disconnectChannel: (kind: ChannelKind) => void;
}

/** 回读并发保护：启动期多次调用只执行一次 */
let hydratePromise: Promise<boolean> | null = null;

/** 新建配置的缺省值（策略类字段对齐 manifest 默认值） */
function defaultsFor(kind: ChannelKind): ChannelConfig {
  const isFeishuLike = kind === 'feishu' || kind === 'lark';
  return {
    id: genId(),
    kind,
    enabled: true,
    // 缺省放开接入（"*"）：nanobot 中空白名单 = 仅配对码模式，无法直接对话
    allowFrom: ['*'],
    groupPolicy: isFeishuLike ? 'mention' : undefined,
    topicIsolation: isFeishuLike ? true : undefined,
    syncStatus: 'idle',
  };
}

export const useChannelsStore = create<ChannelsState>()(
  persist(
    (set, get) => {
      /** 防抖自动同步：把短时间内的多次配置变更合并为一次 nanobot 同步 */
      const scheduleAutoSync = () => {
        if (autoSyncTimer) clearTimeout(autoSyncTimer);
        autoSyncTimer = setTimeout(() => {
          autoSyncTimer = null;
          // 同步失败已反映在各配置的 syncStatus=error，这里不再额外打断用户
          void get().syncAll().catch(() => undefined);
        }, AUTO_SYNC_DEBOUNCE_MS);
      };

      return {
        configs: [],
        lastSync: null,

        saveConfig: (partial) => {
          const existing = get().configs.find((c) => c.kind === partial.kind);
          let result: ChannelConfig;
          if (existing) {
            result = { ...existing, ...partial, id: existing.id };
            set((s) => ({
              configs: s.configs.map((c) => (c.id === existing.id ? result : c)),
            }));
          } else {
            result = { ...defaultsFor(partial.kind), ...partial };
            set((s) => ({ configs: [...s.configs, result] }));
          }
          scheduleAutoSync();
          return result;
        },

        removeConfig: (kind) => {
          set((s) => ({ configs: s.configs.filter((c) => c.kind !== kind) }));
          scheduleAutoSync();
        },

        setEnabled: (kind, enabled) => {
          set((s) => ({
            configs: s.configs.map((c) => (c.kind === kind ? { ...c, enabled } : c)),
          }));
          scheduleAutoSync();
        },

        setSyncStatus: (id, status) =>
          set((s) => ({
            configs: s.configs.map((c) => (c.id === id ? { ...c, syncStatus: status } : c)),
          })),

        syncAll: async () => {
          const configs = get().configs;
          configs.forEach((c) => get().setSyncStatus(c.id, 'syncing'));
          try {
            const result = await getRuntime().sync('channels', configs);
            const at = new Date().toISOString();
            if (!result.ok) {
              set((s) => ({
                configs: s.configs.map((c) => ({ ...c, syncStatus: 'error' })),
                lastSync: { at, ok: false, message: result.message },
              }));
              return result;
            }
            set((s) => ({
              configs: s.configs.map((c) => ({
                ...c,
                syncStatus: 'synced',
                lastSyncAt: at,
              })),
              lastSync: {
                at,
                ok: true,
                message: result.message,
                changed: result.changed,
                needsRestart: result.needsRestart,
              },
            }));
            return result;
          } catch {
            set((s) => ({
              configs: s.configs.map((c) => ({ ...c, syncStatus: 'error' })),
              lastSync: {
                at: new Date().toISOString(),
                ok: false,
                message: '频道配置同步失败，请重试',
              },
            }));
            throw new Error('sync channels failed');
          }
        },

        hydrateFromNanobot: () => {
          if (hydratePromise) return hydratePromise;
          hydratePromise = (async () => {
          try {
            // web 端无文件系统权限：回读返回空数组，天然短路
            const remote = await getRuntime().read('channels');
            if (remote.length === 0) return false;
            const localKinds = new Set(get().configs.map((c) => c.kind));
            const missing = remote.filter((c) => !localKinds.has(c.kind));
            if (missing.length === 0) return false;
            set((s) => ({ configs: [...s.configs, ...missing] }));
            return true;
          } catch {
              // 回读失败不影响主流程：卡片保持本地状态
              return false;
            } finally {
              hydratePromise = null;
            }
          })();
          return hydratePromise;
        },

        refreshFromNanobot: async (kind) => {
          try {
            // web 端无文件系统权限：回读返回空数组，find 自然落空
            const entry = (await getRuntime().read('channels')).find(
              (c) => c.kind === kind,
            );
            if (!entry) return false;
            // 覆盖式写入：本地同 kind 存在则替换（保留原 id 稳定），否则新增。
            // 注意：直接 set，不调 scheduleAutoSync——回读结果即引擎侧事实，
            // 再同步会用旧片段反向覆盖引擎刚写入的凭证。
            set((s) => {
              const idx = s.configs.findIndex((c) => c.kind === kind);
              if (idx < 0) return { configs: [...s.configs, entry] };
              return {
                configs: s.configs.map((c, i) =>
                  i === idx ? { ...entry, id: c.id } : c,
                ),
              };
            });
            return true;
          } catch {
            return false;
          }
        },

        disconnectChannel: (kind) => {
          // 先清除既有防抖定时器：断开前 600ms 内排队的 syncAll 会用含凭证的
          // 旧片段把主进程刚写入的断开结果覆盖回去，必须连同定时器一起取消。
          // 同时把该渠道同步状态重置为初始态（清 lastSyncAt），
          // 避免卡片残留「已同步」旧时间戳。
          if (autoSyncTimer) {
            clearTimeout(autoSyncTimer);
            autoSyncTimer = null;
          }
          // 清本地凭证并停用（策略字段保留）：
          // 注意：直接 set，不调 scheduleAutoSync——引擎侧凭证已由主进程直写清除，
          // 再同步会用旧片段回写覆盖断开结果（同 refreshFromNanobot 同款说明）。
          set((s) => ({
            configs: s.configs.map((c) => {
              if (c.kind !== kind) return c;
              const cleared: ChannelConfig = {
                ...c,
                enabled: false,
                syncStatus: 'idle',
              };
              delete cleared.lastSyncAt;
              if (kind === 'weixin') delete cleared.token;
              else if (kind === 'feishu' || kind === 'lark') {
                delete cleared.appId;
                delete cleared.appSecret;
              }
              return cleared;
            }),
          }));
        },
      };
    },
    {
      name: STORAGE_KEYS.channels,
      storage: zustandStorage,
      version: 2,
      migrate: (persistedState) => {
        // v2：旧版本空白名单在 nanobot 中是「仅配对码」模式，迁移为放开接入（"*"）
        const state = persistedState as { configs?: ChannelConfig[] } | undefined;
        const configs = (state?.configs ?? []).map((c) =>
          c.allowFrom.length === 0 ? { ...c, allowFrom: ['*'] } : c,
        );
        return { configs };
      },
      partialize: (s) => ({ configs: s.configs }),
    },
  ),
);
