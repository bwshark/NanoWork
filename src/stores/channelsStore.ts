import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { ensureMetaList, withTombstone, withoutTombstone } from '@/lib/syncMeta';
import { metaForDelete, metaForEdit, metaForNew } from '@/lib/syncStamp';
import { getRuntime, type SyncResult } from '@/ai/runtime';
import type { ChannelConfig, ChannelKind, SyncTombstones } from '@/types';

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
  /**
   * 已删除渠道的墓碑表，**键是 `kind` 而不是 `id`**。
   *
   * 渠道的实体身份是 `kind`（一个渠道至多一条配置），而 `id` 只是本地随机数
   * 且**会被回读重新生成**（`fromNanobotChannels` 每次 `genId()`）。若按 `id`
   * 键控，回读侧永远匹配不上墓碑——表现成「删掉的渠道下次启动自己回来了」。
   * 与 `agentsStore.tombstones`（按 `id`）的差别仅此一处，但这条差别是必需的。
   */
  tombstones: SyncTombstones;
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
        tombstones: {},
        lastSync: null,

        saveConfig: (partial) => {
          // `configs` 天生只含存活条目（删除走墓碑表），所以同 kind 的存活条目直接找得到
          const existing = get().configs.find((c) => c.kind === partial.kind);
          let result: ChannelConfig;
          if (existing) {
            result = { ...existing, ...partial, id: existing.id, ...metaForEdit(existing) };
            set((s) => ({
              configs: s.configs.map((c) => (c.id === existing.id ? result : c)),
            }));
          } else {
            result = { ...defaultsFor(partial.kind), ...partial, ...metaForNew() };
            set((s) => ({
              configs: [...s.configs, result],
              // 同 kind 重新出现 = 「删掉又配回来」：清掉旧墓碑，否则同步会把这个
              // 刚配好的渠道按「已删除」推出去，而本机看起来一切正常
              tombstones: withoutTombstone(s.tombstones, partial.kind),
            }));
          }
          scheduleAutoSync();
          return result;
        },

        removeConfig: (kind) => {
          set((s) => {
            const target = s.configs.find((c) => c.kind === kind);
            // 没有存活条目可删（重复删除 / 本就没配）：早退，不产生新对象引用
            if (!target) return s;
            return {
              // 删除 = **摘除条目 + 留墓碑**（形态同 agentsStore.removeAgent，
              // 差别只在墓碑键是 kind，理由见 tombstones 的说明）
              configs: s.configs.filter((c) => c.kind !== kind),
              tombstones: withTombstone(s.tombstones, kind, metaForDelete(target)),
            };
          });
          scheduleAutoSync();
        },

        setEnabled: (kind, enabled) => {
          set((s) => ({
            configs: s.configs.map((c) =>
              c.kind === kind ? { ...c, enabled, ...metaForEdit(c) } : c,
            ),
          }));
          scheduleAutoSync();
        },

        setSyncStatus: (id, status) =>
          set((s) => ({
            configs: s.configs.map((c) => (c.id === id ? { ...c, syncStatus: status } : c)),
          })),

        syncAll: async () => {
          /*
           * ⚠️ 提交给**引擎**的负载必须带凭据——引擎要靠它连 IM。
           * 「凭据不上行」那条定案（architecture-syncmeta §5.3）约束的是**云端同步**
           * 负载，不是这里；两者别混。云端负载的裁剪在 `lib/syncPayloads.ts`。
           *
           * `configs` 天生只含存活条目，所以被删渠道不会再被写回引擎配置。
           */
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
            /*
             * 两道判据，缺一不可：
             * - kind：`configs` 只含存活条目，「本地已有」即「用户配过且没删」；
             * - 墓碑：引擎侧配置还没被清理干净时（上一次同步失败、或引擎自行写入），
             *   回读会把用户刚删掉的渠道原样搬回来。删除是**显式事实**，不因回读
             *   而复活——与 mcpStore.hydrateFromNanobot 同一条规则。
             *   判据用 kind 而非 id：回读每次重新 genId()，id 根本对不上。
             */
            const localKinds = new Set(get().configs.map((c) => c.kind));
            const tombstones = get().tombstones;
            const missing = remote.filter(
              (c) => !localKinds.has(c.kind) && !(c.kind in tombstones),
            );
            if (missing.length === 0) return false;
            set((s) => ({
              configs: [...s.configs, ...missing.map((c) => ({ ...c, ...metaForNew() }))],
            }));
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
              // 扫码接入成功 = 这个渠道**重新建立**了：旧墓碑必须清掉，否则同步会
              // 把用户刚扫上的渠道按「已删除」推给对端（本机却显示已连接）。
              const tombstones = withoutTombstone(s.tombstones, kind);
              if (idx < 0) {
                return {
                  configs: [...s.configs, { ...entry, ...metaForNew() }],
                  tombstones,
                };
              }
              return {
                configs: s.configs.map((c, i) =>
                  // 元数据在最后展开：回读的 entry 没有元数据，且 `id` 归一也不该
                  // 影响本次「渠道被重新配置」这个改动的事实
                  i === idx ? { ...entry, id: c.id, ...metaForEdit(c) } : c,
                ),
                tombstones,
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
              // 断开是**改动**（`enabled` 由 true 变 false，是声明字段）：必须标记，
              // 否则「这台断开了、那台还在跑」这个差异传不出去。
              // 元数据在最后展开——上面几个 `delete` 是对 cleared 的原地修改，
              // 顺序反了会被 `...c` 的旧值盖回去
              return { ...cleared, ...metaForEdit(c) };
            }),
          }));
        },
      };
    },
    {
      name: STORAGE_KEYS.channels,
      storage: zustandStorage,
      version: 3,
      migrate: (persistedState, version) => {
        const state = persistedState as
          | { configs?: ChannelConfig[]; tombstones?: SyncTombstones }
          | undefined;
        let configs = state?.configs ?? [];
        // v2：旧版本空白名单在 nanobot 中是「仅配对码」模式，迁移为放开接入（"*"）。
        // 判据是**落盘时的版本号**而非「现在读到的形状」——重跑一次归一虽然幂等，
        // 但把「已经迁移过」当成「需要迁移」会让这段逻辑永远留在执行路径上
        if (version < 2) {
          configs = configs.map((c) =>
            (c.allowFrom?.length ?? 0) === 0 ? { ...c, allowFrom: ['*'] } : c,
          );
        }
        // v3：补同步元数据四字段（缺字段按 `LEGACY_REV` 落盘，见 syncMeta.ensureMetaList）
        // 与空墓碑表
        return { configs: ensureMetaList(configs), tombstones: state?.tombstones ?? {} };
      },
      partialize: (s) => ({ configs: s.configs, tombstones: s.tombstones }),
    },
  ),
);
