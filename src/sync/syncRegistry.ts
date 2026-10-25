/**
 * 各 store 的读 / 写注册表——**引擎与 store 的唯一耦合点**（客户端不变量 2）。
 *
 * ## 为什么要有这一层
 *
 * 引擎若直接 `import` 各个 store，那么反过来每个 store 都要知道「同步」这件事的
 * 存在，而它们的职责是本地 CRUD。收进注册表后：
 * - **引擎不 import 任何 store**，只读注册表；
 * - 新增一个 collection = 在这里注册一个 spec，引擎代码一行不改。
 *
 * 批次 2 只注册了 `agents` 一个样板；批次 4 补齐其余 7 个（`expertGroups` /
 * `tasks` / `mcp` / `channels` / `skillOverrides` / `settings` / `sessionMeta`），
 * 并把 `channels` 的墓碑键裁决为 `kind`（见 §四 collection 契约表 / §B）。
 * **`sessionEvents` 刻意不注册**：它是 append-only（无「被改写」语义）、事实源是
 * 异步的事件流（与 `read()` 的同步契约冲突），且跨设备落点未定（批次 5）。
 *
 * ## 落地语义：浅合并 + 墓碑键控
 *
 * `applyEntity()` 是 pull 落地的**唯一**写入动作，两条规则（§六 #9）：
 * - **墓碑**：入墓碑表 + 从存活数组键控摘除（删除可传播，且列表天然干净）；
 * - **存活**：键控 upsert + 清同名墓碑（「删除后又建了同 id 的条目」不留幽灵墓碑）。
 *
 * 合并（`{ ...local, ...payload }`）由引擎在调用 `apply` **之前**完成，`apply` 只负责
 * 「按这个最终形状写进 store」。这样「本机事实字段不被抹掉」既属于引擎的落地策略，
 * 又能被 `applyEntity` 的键控语义配合实现。
 */

import { useAgentsStore } from '@/stores/agentsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';
import { useTasksStore } from '@/stores/tasksStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useChannelsStore } from '@/stores/channelsStore';
import { useSkillsStore } from '@/stores/skillsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { genId } from '@/lib/core/id';
import { isTombstone, normalizeMeta, withTombstone, withoutTombstone } from '@/lib/sync/syncMeta';
import { pickSyncable } from '@/lib/sync/syncSelect';
import { toChannelSyncPayload, toMcpSyncPayload } from '@/lib/sync/syncPayloads';
import { toSyncPayload } from '@/lib/sync/settingsSync';
import { pickSyncFields } from '@/lib/session/sessionSyncMeta';
import { applyOverrides, pinnedSkillIds } from '@/lib/agent/skillOverrideTable';
import type {
  Agent,
  ChannelConfig,
  ExpertGroup,
  MCPConfig,
  Session,
  Settings,
  SkillOverrideEntry,
  SyncMetaInput,
  SyncTombstones,
  TaskConfig,
  TranscriptionConfig,
} from '@/types';
import type { SyncCollection } from './types';

/** 引擎视角的实体：一个普通记录（元数据四个字段在其中）。 */
export type SyncEntityRecord = Record<string, unknown>;

/**
 * 一个 collection 的注册项。
 *
 * 泛型 `T` 是**该 collection 的实体类型**；引擎内部以 `Record<string, unknown>` 统一
 * 处理（`SyncRegistry` 存的是这个默认形态）。`keyOf` 与 `payload` 是唯一两处「实体
 * 特有」的逻辑：前者回答「这条是谁」，后者回答「上行要带哪些字段」。
 */
export interface SyncCollectionSpec<
  T extends { [k: string]: unknown } = Record<string, unknown>,
> {
  /** collection 名（引擎按它索引） */
  collection: SyncCollection | string;
  /** 取实体的唯一键（`agents` 用 `id`；`channels` 批次 4 会用 `kind`） */
  keyOf: (entity: T) => string;
  /** 读当前存活条目与墓碑表 */
  read(): { entities: T[]; tombstones: SyncTombstones };
  /** 落地一条已合并的实体（见 `applyEntity`） */
  apply(entity: T): void;
  /** 上行负载裁剪（如 `pickSyncable` / `toChannelSyncPayload`） */
  payload(entity: T): Record<string, unknown>;
}

export class SyncRegistry {
  private readonly specs = new Map<string, SyncCollectionSpec>();

  /** 登记（或覆盖）一个 collection。 */
  register<T extends { [k: string]: unknown }>(spec: SyncCollectionSpec<T>): void {
    this.specs.set(spec.collection, spec as unknown as SyncCollectionSpec);
  }

  /** 按 collection 名取注册项；未登记返回 `undefined`（引擎据此静默跳过）。 */
  get(collection: string): SyncCollectionSpec | undefined {
    return this.specs.get(collection);
  }

  /** 全部注册项（**登记顺序**即 push 组装顺序）。 */
  entries(): SyncCollectionSpec[] {
    return Array.from(this.specs.values());
  }
}

/**
 * pull 落地的纯函数：键控地把一条实体应用到「存活数组 + 墓碑表」。
 *
 * **幂等**：
 * - 同一墓碑重复应用：摘除是 `filter`（幂等），`withTombstone` 对已有墓碑连引用都不换；
 * - 同一存活条目重复应用：键控 upsert 原地替换，不产生重复项。
 */
export function applyEntity(
  list: SyncEntityRecord[],
  tombstones: SyncTombstones,
  entity: SyncEntityRecord,
  keyOf: (e: SyncEntityRecord) => string,
): { list: SyncEntityRecord[]; tombstones: SyncTombstones } {
  const key = keyOf(entity);

  if (isTombstone(entity)) {
    return {
      // 摘除是键控的：只删同名条目，别的条目不受影响
      list: list.filter((item) => keyOf(item) !== key),
      tombstones: withTombstone(tombstones, key, normalizeMeta(entity as SyncMetaInput)),
    };
  }

  const index = list.findIndex((item) => keyOf(item) === key);
  const nextList =
    index >= 0 ? list.map((item, i) => (i === index ? entity : item)) : [...list, entity];
  // 清同名墓碑：不留「建回来但同步时仍按已删除推出去」的幽灵墓碑
  return { list: nextList, tombstones: withoutTombstone(tombstones, key) };
}

/** `settings` 是单例：实体恒为这一条，`id` 恒为 `SETTINGS_SINGLETON_ID`（§C.1）。 */
export const SETTINGS_SINGLETON_ID = 'local';

/**
 * 组装 `settings` 的同步实体：`id` + **裁剪后的偏好** + 四元数据。
 *
 * `toSyncPayload`（`@/lib/sync/settingsSync`）剔掉本机环境字段（`gatewayEndpoint` /
 * `apiToken` / `desktop` / 路径类 / `hiddenSessions`）并内层裁剪 `transcription`，
 * 四元数据来自兄弟切片 `syncMeta`（`Settings` 本身不带 `SyncMeta`，见 settingsStore）。
 */
function settingsEntity(): SyncEntityRecord {
  const { settings, syncMeta } = useSettingsStore.getState();
  return { id: SETTINGS_SINGLETON_ID, ...toSyncPayload(settings), ...syncMeta };
}

/**
 * 缺省注册表：登记全部 8 个同步 collection（`agents` + 批次 4 的 7 个）。
 *
 * 直接用 `useXxxStore.getState() / setState()` 访问 store，**引擎不 import 任何 store**。
 * 落地一律走 `applyEntity`（键控：墓碑入表 + 摘除；存活 upsert + 清同名墓碑），
 * **绝不调用 store 的业务动作**（那会 `rev + 1` 污染 incoming 元数据，见 §K）。
 *
 * 各 collection 的 `read/apply/payload` 契约见 `docs/batch-4-entity-wiring-spec.md`
 * §A（`keyOf` 对墓碑记录一律 `e.<field> ?? e.id` 容错）。
 */
export function createDefaultRegistry(): SyncRegistry {
  const registry = new SyncRegistry();

  registry.register<Record<string, unknown>>({
    collection: 'agents',
    keyOf: (entity) => String(entity.id),
    read: () => {
      const state = useAgentsStore.getState();
      return {
        entities: state.agents as unknown as SyncEntityRecord[],
        tombstones: state.tombstones,
      };
    },
    apply: (entity) => {
      const state = useAgentsStore.getState();
      const next = applyEntity(
        state.agents as unknown as SyncEntityRecord[],
        state.tombstones,
        entity,
        (item) => String(item.id),
      );
      useAgentsStore.setState({
        agents: next.list as unknown as Agent[],
        tombstones: next.tombstones,
      });
    },
    payload: (entity) => pickSyncable(entity, []) as Record<string, unknown>,
  });

  // A.1 `expertGroups`：与 `agents` 逐字同构（`mergeGroups` + 独立墓碑表，键 = id）
  registry.register<Record<string, unknown>>({
    collection: 'expertGroups',
    keyOf: (entity) => String(entity.id),
    read: () => {
      const state = useExpertGroupsStore.getState();
      return {
        entities: state.groups as unknown as SyncEntityRecord[],
        tombstones: state.tombstones,
      };
    },
    apply: (entity) => {
      const state = useExpertGroupsStore.getState();
      const next = applyEntity(
        state.groups as unknown as SyncEntityRecord[],
        state.tombstones,
        entity,
        (item) => String(item.id),
      );
      useExpertGroupsStore.setState({
        groups: next.list as unknown as ExpertGroup[],
        tombstones: next.tombstones,
      });
    },
    payload: (entity) => pickSyncable(entity, []) as Record<string, unknown>,
  });

  // A.2 `tasks`：`runs` 是 store 级字段、不在 `TaskConfig` 上，永不上行（见规格 §A.2）
  registry.register<Record<string, unknown>>({
    collection: 'tasks',
    keyOf: (entity) => String(entity.id),
    read: () => {
      const state = useTasksStore.getState();
      return {
        entities: state.tasks as unknown as SyncEntityRecord[],
        tombstones: state.tombstones,
      };
    },
    apply: (entity) => {
      const state = useTasksStore.getState();
      const next = applyEntity(
        state.tasks as unknown as SyncEntityRecord[],
        state.tombstones,
        entity,
        (item) => String(item.id),
      );
      useTasksStore.setState({
        tasks: next.list as unknown as TaskConfig[],
        tombstones: next.tombstones,
      });
    },
    payload: (entity) => pickSyncable(entity, []) as Record<string, unknown>,
  });

  // A.3 `mcp`：payload 走 `toMcpSyncPayload`（剔除运行时事实 + `authKeyNames` + `auth`）
  registry.register<Record<string, unknown>>({
    collection: 'mcp',
    keyOf: (entity) => String(entity.id),
    read: () => {
      const state = useMcpStore.getState();
      return {
        entities: state.configs as unknown as SyncEntityRecord[],
        tombstones: state.tombstones,
      };
    },
    apply: (entity) => {
      const state = useMcpStore.getState();
      const next = applyEntity(
        state.configs as unknown as SyncEntityRecord[],
        state.tombstones,
        entity,
        (item) => String(item.id),
      );
      useMcpStore.setState({
        configs: next.list as unknown as MCPConfig[],
        tombstones: next.tombstones,
      });
    },
    payload: (entity) =>
      toMcpSyncPayload(entity as unknown as MCPConfig) as Record<string, unknown>,
  });

  // A.4 / B `channels`：身份是 `kind`（墓碑键也是 `kind`），`id` 只是本地随机数。
  // 落地必须**保住本机 `id`**：对端 `id` 覆盖会打断 `setSyncStatus(id,…)` 寻址与
  // React key 稳定（§B.3）。`keyOf` 对墓碑记录容错（墓碑只有 `id=kind`，无 `kind`）。
  registry.register<Record<string, unknown>>({
    collection: 'channels',
    keyOf: (entity) => String(entity.kind ?? entity.id),
    read: () => {
      const state = useChannelsStore.getState();
      return {
        entities: state.configs as unknown as SyncEntityRecord[],
        tombstones: state.tombstones,
      };
    },
    apply: (entity) => {
      const state = useChannelsStore.getState();
      const key = String(entity.kind ?? entity.id);
      const existing = state.configs.find((c) => c.kind === key);
      // 墓碑：原样落地（走 `applyEntity` 的墓碑分支）；
      // 存活：强制本机既有 `id`，本机没有才分配一个（`genId()`）
      const merged = isTombstone(entity)
        ? entity
        : { ...entity, id: existing?.id ?? genId() };
      const next = applyEntity(
        state.configs as unknown as SyncEntityRecord[],
        state.tombstones,
        merged,
        (item) => String(item.kind ?? item.id),
      );
      useChannelsStore.setState({
        configs: next.list as unknown as ChannelConfig[],
        tombstones: next.tombstones,
      });
    },
    payload: (entity) =>
      toChannelSyncPayload(entity as unknown as ChannelConfig) as Record<string, unknown>,
  });

  // A.5 `skillOverrides`：**无墓碑**（「删掉一条覆盖」= 值回到默认档 `on`，见
  // `types/skill.ts`）。`overrides` 是权威，`skills` / `pinnedIds` 是派生值——
  // 落地后必须**重算派生视图**，否则表与 UI 分叉（§A.5 判据）。
  registry.register<Record<string, unknown>>({
    collection: 'skillOverrides',
    keyOf: (entity) => String(entity.skillId ?? entity.id),
    read: () => {
      const state = useSkillsStore.getState();
      return {
        entities: state.overrides as unknown as SyncEntityRecord[],
        tombstones: {},
      };
    },
    apply: (entity) => {
      const state = useSkillsStore.getState();
      const { list } = applyEntity(
        state.overrides as unknown as SyncEntityRecord[],
        {},
        entity,
        (item) => String(item.skillId ?? item.id),
      );
      const overrides = list as unknown as SkillOverrideEntry[];
      useSkillsStore.setState({
        overrides,
        // 派生视图从权威表重算（与 `commitOverrides` 的同一条不变量）
        skills: applyOverrides(state.skills, overrides),
        pinnedIds: pinnedSkillIds(overrides),
      });
    },
    payload: (entity) => pickSyncable(entity, []) as Record<string, unknown>,
  });

  // A.6 / C `settings`：单例。`read` 合成 `id + 偏好 + 四元数据`；`apply` 浅合并 +
  // `transcription` 内层合并，**本机环境字段绝不被动**（它们本就不在 payload 里，
  // 浅合并天然保留，§C.4）。
  registry.register<Record<string, unknown>>({
    collection: 'settings',
    keyOf: (entity) => String(entity.id ?? SETTINGS_SINGLETON_ID),
    read: () => ({ entities: [settingsEntity()], tombstones: {} }),
    apply: (entity) => {
      const inc = entity as Record<string, unknown>;
      const {
        id: _id,
        rev,
        updatedAt,
        updatedBy,
        deletedAt,
        transcription,
        ...rest
      } = inc;
      const state = useSettingsStore.getState();
      const nextSettings: Settings = {
        ...state.settings, // 本机字段（网关 / 路径 / 桌面）全部保留
        ...(rest as Partial<Settings>), // 只覆盖对端带来的偏好字段
        // ⚠️ `transcription` 是嵌套对象：必须**内层合并**，否则对端那份不含
        // `endpoint` / `apiToken` 的裁剪结果会整块替换、清空本机已配好的地址。
        transcription: {
          ...(state.settings.transcription ?? ({} as TranscriptionConfig)),
          ...((transcription as Partial<TranscriptionConfig>) ?? {}),
        },
      };
      useSettingsStore.setState({
        settings: nextSettings,
        // 元数据以对端为准（本机不是 LWW 的裁判，落地即采用胜者版本）
        syncMeta: {
          rev: typeof rev === 'number' ? rev : 0,
          updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
          updatedBy: typeof updatedBy === 'string' ? updatedBy : '',
          deletedAt: typeof deletedAt === 'string' ? deletedAt : null,
        },
      });
    },
    // 实体已是裁剪后的形态（含 `id` + 四元数据），无需再裁
    payload: (entity) => entity,
  });

  // A.7 / D `sessionMeta`：同步源是 `sessionsStore` 的**内存快照**（引擎
  // `read()` 是同步的，而事件存储异步——见 §D.2）。墓碑在兄弟表 `sessionTombstones`
  // 里；落地双写内存 + 磁盘（`applyRemoteSessionMeta` / `applyRemoteSessionTombstone`）。
  registry.register<Record<string, unknown>>({
    collection: 'sessionMeta',
    keyOf: (entity) => String(entity.id),
    read: () => {
      const state = useSessionsStore.getState();
      return {
        entities: state.sessions as unknown as SyncEntityRecord[],
        tombstones: state.sessionTombstones,
      };
    },
    apply: (entity) => {
      const store = useSessionsStore.getState();
      if (isTombstone(entity)) store.applyRemoteSessionTombstone(entity);
      else store.applyRemoteSessionMeta(entity);
    },
    payload: (entity) => sessionMetaPayload(entity),
  });

  return registry;
}

/**
 * `sessionMeta` 的上行负载（§D.3）：`id` + `SESSION_SYNC_FIELDS` 白名单 + 四元数据。
 *
 * **显式断言 `streamWorkdir` 不上行**：它是本机落盘分片（「记录在哪台机器的哪个
 * 目录」），白名单已排除；这里再确认一次，改坏了会红（§D.3 判据 D-⑥）。
 * 墓碑记录（`SyncMeta & { id }`）经此出来的就是纯元数据负载——白名单字段读到
 * `undefined`，JSON 序列化时自然丢弃。
 */
function sessionMetaPayload(entity: SyncEntityRecord): Record<string, unknown> {
  const s = entity as Partial<Session> & SyncEntityRecord;
  return {
    id: s.id,
    ...pickSyncFields(s as Session),
    rev: s.rev,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
    deletedAt: s.deletedAt ?? null,
  };
}
