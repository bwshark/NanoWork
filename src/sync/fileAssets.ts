/**
 * C 类文件型资产同步适配器——引擎与「记忆 / 身份文件 / 提示词覆盖」的**唯一耦合点**
 * （批次 6b，规格 `docs/batch-6b-file-assets-spec.md`）。
 *
 * ## 为什么是第三类通道（与 `syncRegistry` / `eventStream` 并列）
 *
 * 与批次 5 对事件流的裁决**同款**：`SyncCollectionSpec.read()` 是**同步**的，而本类资产的
 * 读取是**异步**的（`platform.storage.get`）。塞进 registry 只能得到一个撒谎的 `read()`
 * （返回空或过期缓存），而改全体 spec 契约的回归面过大。故走可选注入的适配器。
 *
 * ## 内容即版本（D3-2）
 *
 * 三个资产的写入路径加起来有十余处（`MemoryService` / `IdentityService` / `PromptLibrary`
 * 各自的 `save` / `append` / `clear` / `remove`），在每一处打 `markDirty` 必然漏。
 * 这里反过来：**不挂钩写入，只比对内容**——`hydrate()` 时算 `hashContent(content)`，
 * 与持久化的 hash 不同即视为「本机改过」→ `rev + 1` / `updatedAt = now()`。
 * 新增写入入口无需记得通知同步层。
 *
 * ## 两种合并粒度
 *
 * | 资产 | 粒度 | 为什么 |
 * |---|---|---|
 * | 用户级记忆 | **段落级**（2P-Set + LWW） | 两台机器各自沉淀，段并集保证**谁都不丢**（J-1） |
 * | 身份文件 / 提示词覆盖 | **文件级 LWW** | 整体是一份文档，没有可切分的稳定段 |
 *
 * 记忆**不参与** LWW 的「谁新谁胜」——段并集是单调的，永远合并。文件级仍走
 * `compareVersions`（与服务端同一套三级 tie-break），本地更新则不落地。
 */

import { platform } from '@/platform';
import {
  IDENTITY_STORAGE_KEYS,
  PROMPT_KEY_PREFIX,
  USER_MEMORY_KEY,
} from '@/lib/constants';
import { PROMPT_SLOTS } from '@/lib/promptCatalog';
import {
  diffRemovedKeys,
  mergeMemory,
  mergeTombstones,
  parseMemory,
  renderMemory,
} from '@/lib/memoryMerge';
import { hashContent } from '@/lib/workspaceKey';
import { compareVersions } from './SyncEngine';
import { FILE_ASSETS_STORAGE_KEY } from './types';
import type { SyncChange, VersionStamp } from './types';

/** C 类资产的三个 collection 名（**不登记进 `syncRegistry`**，见文件头） */
export const FILE_ASSET_COLLECTIONS = {
  memoryUser: 'memoryUser',
  identityFiles: 'identityFiles',
  promptOverrides: 'promptOverrides',
} as const;

/** 一个可同步的 C 类资产 */
interface AssetDef {
  collection: string;
  /** collection 内的唯一键 */
  id: string;
  /** `platform.storage` 的 key */
  storageKey: string;
  /** true = 段落级合并（记忆）；false = 文件级 LWW */
  paragraphLevel: boolean;
}

/**
 * 资产清单。
 *
 * **`BOOTSTRAP.md` 刻意不在内**（D1-2）：它是出厂预置的一次性引导种子、引导完成即删除，
 * 同步它会让「A 已完成引导 / B 新装」互相污染。它由安装生成、由本机消费。
 */
function assetDefs(): AssetDef[] {
  const defs: AssetDef[] = [
    {
      collection: FILE_ASSET_COLLECTIONS.memoryUser,
      id: 'user',
      storageKey: USER_MEMORY_KEY,
      paragraphLevel: true,
    },
  ];

  // 身份文件：soul / identity / user（不含 bootstrap）
  for (const kind of ['soul', 'identity', 'user'] as const) {
    defs.push({
      collection: FILE_ASSET_COLLECTIONS.identityFiles,
      id: kind,
      storageKey: IDENTITY_STORAGE_KEYS[kind],
      paragraphLevel: false,
    });
  }

  // 提示词覆盖：按 `PROMPT_SLOTS` **静态表**枚举（D1-1：StorageAdapter 没有 keys()）
  for (const slot of PROMPT_SLOTS) {
    defs.push({
      collection: FILE_ASSET_COLLECTIONS.promptOverrides,
      id: `${slot.kind}.${slot.key}`,
      storageKey: `${PROMPT_KEY_PREFIX}${slot.kind}.${slot.key}`,
      paragraphLevel: false,
    });
  }

  return defs;
}

/** 单个资产的同步元数据 */
interface AssetMeta {
  /** 上次已知内容的哈希（内容即版本的判据） */
  hash: string;
  rev: number;
  updatedAt: string;
  updatedBy: string;
  /** 仅段落级：上次已知的段键集合（用它 diff 出「被删掉的段」） */
  knownKeys?: string[];
  /** 仅段落级：段级墓碑（`段键 → 删除时刻`） */
  tombstones?: Record<string, string>;
}

/** 持久化形状：外层按**账户分片**，内层键是 `<collection>:<id>` */
type PersistedState = Record<string, AssetMeta>;
/** 落盘形状：`Record<userId, PersistedState>`（未登录归一到 `''`） */
type PersistedTable = Record<string, PersistedState>;

/**
 * C 类资产同步适配器（与 `SessionEventStreamAdapter` 同款：全异步、可选注入）。
 */
export interface FileAssetsAdapter {
  /**
   * 读全部资产的当前文本，按内容哈希推进 `rev` / `updatedAt`，并 diff 出段级墓碑。
   *
   * 引擎在 **pull 之前**调用（内容即版本必须在组装上行负载之前生效）。
   */
  hydrate(): Promise<void>;
  /** 上行负载（每个资产一条）；未 `hydrate()` 返回空数组——**绝不推未水合的空值**。 */
  collect(): SyncChange[];
  /** 落地一条远端变更；返回是否真的改动了本机（0 / 1）。 */
  apply(change: SyncChange): Promise<number>;
}

function metaKey(def: AssetDef): string {
  return `${def.collection}:${def.id}`;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 取两个 ISO 时刻中较晚者（无法解析视为最旧） */
function laterAt(a: string, b: string): string {
  const ta = Date.parse(a ?? '');
  const tb = Date.parse(b ?? '');
  if (!Number.isFinite(ta)) return b;
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
}

/** 把未知值收敛成段级墓碑表（脏值一律丢弃，不让它污染合并） */
function parseTombstones(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at === 'string' && at !== '') out[key] = at;
  }
  return out;
}

function stampOf(id: string, meta: AssetMeta): VersionStamp {
  return { id, rev: meta.rev, updatedAt: meta.updatedAt, deletedAt: null };
}

/**
 * 装配适配器。
 *
 * `scopeOf` 返回**当前账户**（未登录 `''`）。元数据**必须按账户分片**——与事件水位、
 * 冲突快照同一条纪律：runtime 全应用复用同一套内存态，不分片则 B 会继承 A 留下的
 * `rev` / `updatedAt`。
 *
 * 内部状态（`state` / `contents`）是**进程内**的；`hydrate()` 每次都重新loadState()，
 * 故换号后自然读到新账户那一份。
 */
export function createFileAssetsAdapter(scopeOf: () => string = () => ''): FileAssetsAdapter {
  const defs = assetDefs();
  let state: PersistedState = {};
  /** `hydrate()` 读到的当前正文（`collect()` 与 `apply()` 都基于它，不再重复读盘） */
  const contents = new Map<string, string>();
  let hydrated = false;

  async function loadState(): Promise<PersistedState> {
    try {
      const raw = await platform.storage.get<string>(FILE_ASSETS_STORAGE_KEY);
      if (typeof raw !== 'string' || raw.trim() === '') return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      const forScope = (parsed as PersistedTable)[scopeOf()];
      return (forScope ?? {}) as PersistedState;
    } catch {
      // 坏值 / 存储不可用 → 当作全新（首次 hydrate 会为有内容的资产建元数据）
      return {};
    }
  }

  /** 读-改-写：只替换**当前账户**那一份分片，其它账户原样保留 */
  async function persist(): Promise<void> {
    try {
      const raw = await platform.storage.get<string>(FILE_ASSETS_STORAGE_KEY);
      let all: PersistedTable = {};
      if (typeof raw === 'string' && raw.trim() !== '') {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) all = parsed as PersistedTable;
      }
      all[scopeOf()] = state;
      await platform.storage.set(FILE_ASSETS_STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* 丢失不影响正确性：下一轮 hydrate 会按内容重建版本号 */
    }
  }

  async function readText(storageKey: string): Promise<string> {
    try {
      const raw = await platform.storage.get<string>(storageKey);
      return typeof raw === 'string' ? raw : '';
    } catch {
      return '';
    }
  }

  return {
    async hydrate(): Promise<void> {
      const current = await loadState();
      const deviceId = (await platform.appInfo())?.deviceId ?? '';
      let dirty = false;

      for (const def of defs) {
        const key = metaKey(def);
        const content = await readText(def.storageKey);
        contents.set(key, content);

        const hash = hashContent(content);
        const known = current[key];

        if (!known) {
          // 首次见到这个资产：建**基线**。
          // - 空内容 → 不认领版本（rev 0 / updatedAt ''），否则一台空机器会冒充「最新」
          //   把对端内容顶掉；
          // - 有内容 → 记一次变更。两台机器都已有内容时必须有**决定性次序**，
          //   否则两端 rev/updatedAt 完全相同，LWW 三级 tie-break 全部打平，
          //   谁也说服不了谁（身份文件会永久各持一份）。
          const meta: AssetMeta = {
            hash,
            rev: content.trim() === '' ? 0 : 1,
            updatedAt: content.trim() === '' ? '' : new Date().toISOString(),
            updatedBy: deviceId,
          };
          if (def.paragraphLevel) {
            meta.knownKeys = parseMemory(content).blocks.map((b) => b.key);
            meta.tombstones = {};
          }
          current[key] = meta;
          dirty = true;
          continue;
        }

        if (known.hash === hash) {
          current[key] = known;
          continue;
        }

        const meta = known;
        meta.hash = hash;
        meta.rev = asNumber(meta.rev) + 1;
        meta.updatedAt = new Date().toISOString();
        meta.updatedBy = deviceId;

        if (def.paragraphLevel) {
          const snap = parseMemory(content);
          const keys = snap.blocks.map((b) => b.key);
          // 段级墓碑只能靠 diff 得出：上次已知的段这次不在 → 被删了（D2-5）
          meta.tombstones = mergeTombstones(
            meta.tombstones ?? {},
            diffRemovedKeys(meta.knownKeys ?? [], keys, meta.updatedAt),
          );
          meta.knownKeys = keys;
        }

        current[key] = meta;
        dirty = true;
      }

      state = current;
      hydrated = true;
      if (dirty) await persist();
    },

    collect(): SyncChange[] {
      if (!hydrated) return [];
      const out: SyncChange[] = [];
      for (const def of defs) {
        const key = metaKey(def);
        const meta = state[key];
        if (!meta) continue;
        const entity: Record<string, unknown> = {
          id: def.id,
          content: contents.get(key) ?? '',
          rev: meta.rev,
          updatedAt: meta.updatedAt,
          updatedBy: meta.updatedBy,
          deletedAt: null, // C 类无墓碑（D1-3：空串 = 回到默认）
        };
        if (def.paragraphLevel) entity.tombstones = meta.tombstones ?? {};
        out.push({ collection: def.collection, entity });
      }
      return out;
    },

    async apply(change: SyncChange): Promise<number> {
      if (!hydrated) return 0;
      const id = asString(change?.entity?.id);
      const def = defs.find((d) => d.collection === change?.collection && d.id === id);
      if (!def) return 0;

      const key = metaKey(def);
      const incoming = change.entity ?? {};
      const incContent = asString(incoming.content);
      const localContent = contents.get(key) ?? '';
      const meta = state[key] ?? { hash: '', rev: 0, updatedAt: '', updatedBy: '' };

      if (def.paragraphLevel) {
        // 段落级：**永远合并**（段并集是单调的，不存在「谁胜」）
        const merged = mergeMemory(
          { blocks: parseMemory(localContent).blocks, tombstones: meta.tombstones ?? {} },
          { blocks: parseMemory(incContent).blocks, tombstones: parseTombstones(incoming.tombstones) },
        );
        const text = renderMemory(merged);

        meta.rev = Math.max(asNumber(meta.rev), asNumber(incoming.rev));
        meta.updatedAt = laterAt(meta.updatedAt, asString(incoming.updatedAt));
        meta.tombstones = merged.tombstones;
        meta.knownKeys = merged.blocks.map((b) => b.key);
        meta.hash = hashContent(text);
        state[key] = meta;

        if (text === localContent) {
          // 正文没变，但墓碑可能变了（对端删了本机没有的段）→ 仍要落盘
          await persist();
          return 0;
        }
        contents.set(key, text);
        await platform.storage.set(def.storageKey, text);
        await persist();
        return 1;
      }

      // 文件级 LWW：与服务端同一套三级 tie-break；本地更新 / 同版 → 不落地
      const incomingStamp: VersionStamp = {
        id: def.id,
        rev: asNumber(incoming.rev),
        updatedAt: asString(incoming.updatedAt),
        deletedAt: null,
      };
      if (compareVersions(stampOf(def.id, meta), incomingStamp) >= 0) return 0;
      if (incContent === localContent) return 0;

      contents.set(key, incContent);
      await platform.storage.set(def.storageKey, incContent);
      meta.hash = hashContent(incContent);
      meta.rev = incomingStamp.rev;
      meta.updatedAt = incomingStamp.updatedAt;
      meta.updatedBy = asString(incoming.updatedBy);
      state[key] = meta;
      await persist();
      return 1;
    },
  };
}
