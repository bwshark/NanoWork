import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { platform, zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import {
  channelSecretKeysByKind,
  channelVaultName,
  pickChannelSecrets,
  stripChannelSecrets,
} from '@/lib/channelSecrets';
import { ensureMetaList, withTombstone, withoutTombstone } from '@/lib/syncMeta';
import { metaForDelete, metaForEdit, metaForNew } from '@/lib/syncStamp';
import { changedFieldNames, recordAppAudit } from '@/lib/appAudit';
import { getRuntime, type SyncResult } from '@/ai/runtime';
import type { ChannelRuntimeHealth, CredentialVaultStatus, SecretWriteResult } from '@/platform/types';
import type { ChannelConfig, ChannelKind, SyncTombstones } from '@/types';

/**
 * IM 频道配置 store（FR-010）。
 * 每个渠道至多一条配置（与 IM 频道页「一卡一配置」交互对齐）；
 * 持久化经 platform.storage。任何配置变更（保存 / 启停 / 删除）都会
 * 防抖后自动同步进 nanobot 运行时（合并 config.json + 重启网关），
 * 无需用户手动点击「同步」。
 *
 * ## 凭据的落点（V1.5 批次 3：保险库化）
 *
 * 渠道密钥（`clientSecret` / `appSecret` / `botSecret` / `token`）**不再明文落
 * `channels.json`**——持久化时由 `partialize` 剥掉，值交给主进程加密保险库
 * （`~/.nanowork/connectors/.credentials.v3.json`，经 `platform.secrets*`，
 * 命名与归属见 `lib/channelSecrets.ts`）。
 *
 * 三条随之而来的约束，缺一条就会出现「配置看着对、渠道连不上」：
 *
 * 1. **引擎侧仍必须拿到凭据**：`syncAll` 提交的片段天然不带密钥（本机已剥），
 *    由主进程合并 `config.json` 前从保险库回补（`electron/channelSecretInjection.ts`）；
 * 2. **保险库不可用时不能丢数据**：`partialize` 仅在保险库**确认可用**时才剥明文，
 *    否则退回今日的明文落盘（浏览器端同理：无保险库，只能明文落 localStorage）；
 * 3. **回读链路要把凭据收进保险库**：扫码接入的凭据由引擎直接写进 `config.json`，
 *    回读时若只留在内存，重启后就只剩「配置在、凭据没了」。
 */

/** 自动同步防抖间隔（毫秒）：合并连续的保存/启停为一次网关重启 */
const AUTO_SYNC_DEBOUNCE_MS = 600;

/** 防抖定时器句柄（模块级，跨 store 调用共享） */
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;

/** FR-6.6 健康轮询间隔（毫秒）：约 30s 拉一次渠道实时状态 */
const HEALTH_POLL_MS = 30_000;
/** FR-6.6 token 类渠道自动重连的最大尝试次数（退避，超出后交手动按钮） */
const AUTO_RECONNECT_MAX = 3;
/** 健康轮询定时器句柄（模块级，跨调用共享） */
let healthTimer: ReturnType<typeof setInterval> | null = null;

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
  /**
   * 保险库可用性（`null` = 尚未查询）。
   *
   * 它同时是**持久化剥明文的开关**（见 `partialize`）：不可用时如实退回明文落盘，
   * 而不是把凭据丢弃——用户以为加密了、实际什么都没存，是比明文更糟的结果。
   */
  vaultAvailable: boolean | null;
  /** 各渠道已配置凭据的 **key 名清单**（值为空：密钥不出主进程） */
  secretKeys: Record<string, string[]>;
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
  /** 读取保险库可用性与渠道凭据的 key 名清单（启动时与写入后各调一次） */
  refreshSecrets: () => Promise<CredentialVaultStatus>;
  /**
   * 保存某渠道的凭据到加密保险库。
   * - electron：写保险库（fail-closed，加密不可用时返回 ok=false 且**不**降级明文）；
   * - web：无系统凭据库，保持明文落 localStorage（浏览器环境的既有限制）。
   */
  saveSecrets: (kind: ChannelKind, secrets: Record<string, string>) => Promise<SecretWriteResult>;
  /**
   * 把**存量明文**凭据（升级前落盘的那批）一次性收进保险库，之后持久化才敢剥明文。
   * 启动时调一次；无明文可迁时是空操作。
   */
  vaultExistingSecrets: () => Promise<void>;
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
  /**
   * FR-6.6 实时健康：按 ChannelKind 归一的渠道运行时状态（区别于磁盘配置）。
   * 仅 electron 有效；web 恒为空（无网关）。
   */
  health: Partial<Record<ChannelKind, ChannelRuntimeHealth>>;
  /** 最近一次健康查询结果（ok=false 时的原因）；不参与持久化 */
  healthError: string | null;
  /** 网关是否在运行且可达（null = 尚未查询 / web 端） */
  gatewayUp: boolean | null;
  /** 最近一次取数时间（ISO 8601 UTC）；不参与持久化 */
  lastHealthAt: string | null;
  /** 各渠道自动重连已尝试次数（模块级退避计数；不入持久化） */
  reconnectAttempts: Partial<Record<ChannelKind, number>>;
  /**
   * 查询并合并渠道实时健康（FR-6.6）。失败 / web 端安全降级，不抛异常。
   * 对 token 类渠道（weixin）检测到 failed/stopped 且已启用时，
   * 按退避自动触发 syncAll 重连（最多 {@link AUTO_RECONNECT_MAX} 次）。
   */
  refreshHealth: () => Promise<void>;
  /** 启动 ~30s 健康轮询（页面挂载时调用，幂等） */
  startHealthPolling: () => void;
  /** 停止健康轮询（页面卸载时调用） */
  stopHealthPolling: () => void;
  /**
   * 手动重连某渠道：重置自动重连计数并触发重连。
   * - weixin（token 类）：syncAll 重连（重新合并配置 + 重启网关）；
   * - feishu / lark（QR 类）：需用户重新扫码，由 UI 唤起接入流程，本方法仅刷新健康。
   */
  reconnectChannel: (kind: ChannelKind) => Promise<void>;
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
      /**
       * 清除某渠道在保险库里的凭据条目（electron；web 空操作，幂等）。
       *
       * 两个入口都要调：**删除渠道**与**断开连接**。不删的后果各不相同但同样难查——
       * 删除后不删会让「删掉又配回来」时主进程把旧密钥原样回补（用户没填也被连上）；
       * 断开后不删会让下一次同步把凭据补回 `config.json`（界面显示已断开却自己连上了）。
       */
      const clearVaultEntry = (kind: ChannelKind) => {
        if (platform.env !== 'electron') return;
        void platform
          .secretsDelete(channelVaultName(kind))
          .then(() => get().refreshSecrets())
          .catch((err) => console.warn('[channels] 清除渠道凭据失败：', err));
      };

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
        vaultAvailable: null,
        secretKeys: {},
        health: {},
        healthError: null,
        gatewayUp: null,
        lastHealthAt: null,
        reconnectAttempts: {},

        refreshSecrets: async () => {
          const status = await platform.secretsStatus();
          const keys = await platform.secretsKeys();
          // 保险库是 MCP 服务器与渠道**共用**的一张表（键是名字）：只认 channel: 前缀的条目，
          // 否则 MCP 的条目会被误当成某条渠道「已配置凭据」
          set({ vaultAvailable: status.available, secretKeys: channelSecretKeysByKind(keys) });
          return status;
        },

        saveSecrets: async (kind, secrets) => {
          if (platform.env !== 'electron') {
            // Web 端没有系统凭据库：凭据只能明文落 localStorage（浏览器环境的既有限制，
            // 界面会标注）。刻意**不**返回 ok:false——那会让用户以为保存失败，实际成功了。
            return { ok: true };
          }
          // 空集合显式拦截：保险库 write 的语义是「整条替换，空对象即删除」，
          // 透传空值会把「用户没填」执行成「删除已有凭据」
          if (Object.keys(secrets).length === 0) return { ok: true };
          const result = await platform.secretsSet(channelVaultName(kind), secrets);
          // 写入成功才刷新「已设置」视图：否则界面显示已设置、保险库里其实没有，
          // 而失败是静默的——用户永远不会自己发现
          if (result.ok) await get().refreshSecrets();
          return result;
        },

        vaultExistingSecrets: async () => {
          if (platform.env !== 'electron') return;
          const status = await get().refreshSecrets();
          // 保险库不可用时不剥明文（partialize 的开关也是它），此处的迁移自然无事可做
          if (!status.available) return;
          const pending = get()
            .configs.map((c) => ({ kind: c.kind, secrets: pickChannelSecrets(c) }))
            .filter((x) => Object.keys(x.secrets).length > 0);
          if (pending.length === 0) return;
          for (const { kind, secrets } of pending) {
            await get().saveSecrets(kind, secrets);
          }
          /*
           * 强制一次持久化：`partialize` 只在**这次写入**时才把明文剥掉，而 zustand
           * 只在 setState 时写盘。不推这一下，升级后的 `channels.json` 会带着明文一直
           * 躺到用户下次改配置——「已保险库化」就成了一句空话（而验收恰恰看这个文件）。
           */
          set((s) => ({ configs: s.configs.map((c) => ({ ...c })) }));
        },

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
          /*
           * 凭据入保险库：`saveConfig` 是「用户保存了这条渠道」的唯一入口，由它自己负责
           * 写保险库，而不是交给调用方记得——漏调一处就是「配置保存成功、重启后凭据没了」。
           * 空值（表单留空 = 不修改）不会被 `pickChannelSecrets` 收进载荷，故不会误删既有凭据。
           * 失败不改本地保存结果（配置已落盘），由界面按 `vaultAvailable` 如实提示。
           */
          if (platform.env === 'electron') {
            const secrets = pickChannelSecrets(result);
            if (Object.keys(secrets).length > 0) {
              void get()
                .saveSecrets(result.kind, secrets)
                .catch((err) => console.warn('[channels] 凭据写入保险库失败：', err));
            }
          }
          scheduleAutoSync();
          /*
           * 审计一行而不是两行：渠道凭据是**跟着配置表单一起保存**的（不像连接器有
           * 独立的「保存密钥」按钮），拆成 `channel.update` + `channel.secret.write`
           * 会让一次点击变成两条账。所以密钥只以**字段名**出现在 detail 里。
           */
          const secretNames = Object.keys(pickChannelSecrets(result));
          const nonSecretPatch: Record<string, unknown> = { ...partial };
          for (const key of secretNames) delete nonSecretPatch[key];
          recordAppAudit({
            action: 'channel.update',
            targetId: partial.kind,
            targetLabel: partial.kind,
            detail: {
              created: !existing,
              fields: changedFieldNames(
                existing as unknown as Record<string, unknown>,
                nonSecretPatch,
              ),
              secrets: secretNames,
            },
          });
          return result;
        },

        removeConfig: (kind) => {
          const existing = get().configs.find((c) => c.kind === kind);
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
          // 凭据一并清理（同 mcpStore.removeConfig）：条目没了而密钥还在保险库里，
          // 是一份没有归属的密钥，且「删掉又配回来」时会被原样回补进引擎配置
          clearVaultEntry(kind);
          scheduleAutoSync();
          // 早退那条路径（本来就没配）不该留一条「删过」的账
          if (existing) {
            recordAppAudit({ action: 'channel.delete', targetId: kind, targetLabel: kind });
          }
        },

        setEnabled: (kind, enabled) => {
          set((s) => ({
            configs: s.configs.map((c) =>
              c.kind === kind ? { ...c, enabled, ...metaForEdit(c) } : c,
            ),
          }));
          scheduleAutoSync();
          if (get().configs.some((c) => c.kind === kind)) {
            recordAppAudit({
              action: enabled ? 'channel.enable' : 'channel.disable',
              targetId: kind,
              targetLabel: kind,
            });
          }
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
            /*
             * 回读到的凭据一并收进保险库：它们是**引擎侧直接写入 config.json** 的
             * （用户手改配置 / 迁移过来的老数据），本地此前没有。只留在内存的话，
             * 重启后本地就没有凭据可写回，而下次同步会把引擎侧的抹掉——渠道直接不可用。
             */
            if (platform.env === 'electron') {
              for (const cfg of missing) {
                const secrets = pickChannelSecrets(cfg);
                if (Object.keys(secrets).length > 0) {
                  await get().saveSecrets(cfg.kind, secrets);
                }
              }
            }
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
            /*
             * 扫码接入的凭据由**引擎直接写入 config.json**（飞书 appSecret 只存在于该文件），
             * 必须回读才能拿到。这里把它同步收进保险库：不这么做的话，凭据只活在内存里，
             * 重启后本地无凭据可写回，下次同步就会把引擎侧那份抹掉（渠道直接不可用）。
             */
            const secrets = pickChannelSecrets(entry);
            if (platform.env === 'electron' && Object.keys(secrets).length > 0) {
              await get().saveSecrets(kind, secrets);
            }
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
          // 保险库条目一并清除（主进程断开时也会删，这里是双保险，幂等）
          clearVaultEntry(kind);
        },

        refreshHealth: async () => {
          try {
            // web 端无网关：platform 直接返回 null，安全降级为空健康
            const report = await platform.getChannelRuntimeStatus();
            if (!report) {
              set({ gatewayUp: null, healthError: null, lastHealthAt: null });
              return;
            }
            set({
              health: report.health,
              gatewayUp: report.gatewayUp,
              healthError: report.error ?? null,
              lastHealthAt: report.fetchedAt,
            });
            // 自动重连：仅 token 类（weixin），且已启用却 failed/stopped
            if (report.ok && report.gatewayUp) {
              const configs = get().configs;
              for (const cfg of configs) {
                if (cfg.kind !== 'weixin') continue;
                if (!cfg.enabled) {
                  set((s) => ({ reconnectAttempts: { ...s.reconnectAttempts, weixin: 0 } }));
                  continue;
                }
                const h = report.health.weixin;
                const down = !!h && (h.state === 'failed' || h.state === 'stopped');
                if (!down) {
                  set((s) => ({ reconnectAttempts: { ...s.reconnectAttempts, weixin: 0 } }));
                  continue;
                }
                const attempts = get().reconnectAttempts.weixin ?? 0;
                if (attempts < AUTO_RECONNECT_MAX) {
                  set((s) => ({
                    reconnectAttempts: { ...s.reconnectAttempts, weixin: attempts + 1 },
                  }));
                  // 退避：指数间隔（1s / 2s / 4s，封顶 8s）后触发 syncAll 重连
                  const delay = Math.min(8000, 1000 * 2 ** attempts);
                  setTimeout(() => {
                    void get().syncAll().catch(() => undefined);
                  }, delay);
                }
              }
            }
          } catch {
            set({ healthError: '渠道健康查询失败', gatewayUp: false });
          }
        },

        startHealthPolling: () => {
          if (healthTimer) return;
          void get().refreshHealth();
          healthTimer = setInterval(() => {
            void get().refreshHealth();
          }, HEALTH_POLL_MS);
        },

        stopHealthPolling: () => {
          if (healthTimer) {
            clearInterval(healthTimer);
            healthTimer = null;
          }
        },

        reconnectChannel: async (kind) => {
          // 手动优先：重置该渠道自动重连计数
          set((s) => ({ reconnectAttempts: { ...s.reconnectAttempts, [kind]: 0 } }));
          // 重新合并配置 + 重启网关：所有渠道运行时随之重载。
          // - token 类（weixin）：凭证在 config.json，重启即重连；
          // - QR 类（feishu / lark）：若凭证仍在则重载恢复，若已失效用户可走「断开 + 重新扫码」。
          await get().syncAll().catch(() => undefined);
          void get().refreshHealth().catch(() => undefined);
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
      /*
       * 持久化时剥掉渠道密钥明文（见文件头「凭据的落点」）。
       *
       * 开关刻意是 `vaultAvailable === true` 而不是「是不是 electron」：**只有确认保险库
       * 真的可用**才敢剥。剥掉的语义是「值已在别处」，而环境没有系统凭据库（Linux 无
       * keyring、`safeStorage` 拒绝加密）时它并没有别处可去——那等于把用户刚填的凭据
       * 在「已保存」的提示下丢掉。此时退回明文落盘（与 V1.5 之前的行为一致），
       * 由界面按 `vaultAvailable` 标注「未加密」。
       * Web 端恒为 false（浏览器无 OS 凭据库），同样维持明文。
       */
      partialize: (s) =>
        platform.env === 'electron' && s.vaultAvailable === true
          ? {
              configs: s.configs.map((c) => stripChannelSecrets(c)),
              tombstones: s.tombstones,
            }
          : { configs: s.configs, tombstones: s.tombstones },
    },
  ),
);
