/**
 * 同步运行时：把「账户 / HTTP 客户端 / 注册表 / 引擎」装配成一个生命周期对象。
 *
 * ## 为什么独立成文件
 *
 * `SyncEngine.ts` 的四条客户端不变量之一是「**不 `import` 任何 store**」（引擎与 store
 * 的唯一耦合点是 `syncRegistry`）。而「本地变更 → `notifyLocalChange()`」必须在**装配处**
 * `useXxxStore.subscribe(...)`——那是 store 依赖，故只能放在这里，不进引擎。
 *
 * ## 三个机制（§G.1 / §G.3）
 *
 * 1. **`suppress` / `missed` 抑制**：pull 落地 = `set` = 触发订阅 = 再同步，形成
 *    「自激环」。同步执行期间置 `suppress`，此时订阅回调只置 `missed`；同步结束时若
 *    `missed` 为真，补一次 `notifyLocalChange()`（保证同步窗口内的**用户改动**不丢）。
 * 2. **账户生命周期**：登录 → `engine.start()`；登出 → `engine.stop()` + `resetSyncStatus()`。
 *    订阅 `account.subscribe` 是**唯一入口**，避免「登录 UI 记一次、别处忘了」。
 * 3. **单例访问器**（`getSyncRuntime` / `initSyncRuntime` / `disposeSyncRuntime` /
 *    `subscribeSyncRuntime`）：runtime 订阅了 8 个 store 且持有定时器，必须**全应用一个**
 *    ——否则登录页、侧栏账户入口、设置页各造一个，就会有 N 份订阅与 N 条 30s 定时同步
 *    同时在跑。`subscribeSyncRuntime` 是给**常驻 UI** 用的：它在单例出现前就已经挂载了。
 *
 * ## `suppress` 如何覆盖引擎自己的同步
 *
 * 引擎的定时器 / `online` / `notifyLocalChange` 都在内部调 `this.syncNow()`。若不拦截，
 * 那些同步期间落地的 `set` 仍会触发订阅的 `onChange`（`suppress` 仍为 false）→ 自激。
 * 故本对象在构造时把引擎实例的 `syncNow` **替换为受抑制包装**：所有入口（外部调用、
 * 定时器、防抖、`online`）都会命中替换后的自有属性，捕获同一份 `suppress`。
 */

import { useAgentsStore } from '@/stores/agentsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';
import { useTasksStore } from '@/stores/tasksStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useChannelsStore } from '@/stores/channelsStore';
import { useSkillsStore } from '@/stores/skillsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { APP_AUDIT_LOCAL_ACTOR, setAppAuditActorProvider } from '@/lib/audit/appAudit';
import { setKnowledgeSearchProvider } from '@/lib/agent/agentKnowledgeTurn';
import { setProjectMemoryProvider } from '@/lib/agent/projectMemoryTurn';
import { createKbGateway } from '@/lib/kb/kbClient';
import { createProjectGateway } from '@/lib/project/projectClient';
import { resolveSyncBaseUrl } from './baseUrl';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { SyncClient } from './SyncClient';
import { SyncEngine, createMemoryCursorStore } from './SyncEngine';
import { createSessionEventStreamAdapter } from './eventStream';
import { createFileAssetsAdapter } from './fileAssets';
import { createArtifactsAdapter } from './artifacts';
import { createStorageSyncAccount } from './syncAccount';
import { createDefaultRegistry } from './syncRegistry';
import { resetSyncStatus } from './useSyncStatus';
import type { SyncAccount } from './syncAccount';
import type { SyncRegistry } from './syncRegistry';
import type { AccountSession } from './types';

/** `createSyncRuntime` 的可选注入项（测试注入假 fetch / 假时钟）。 */
export interface SyncRuntimeOptions {
  /** 服务端根地址（缺省 `DEFAULT_SYNC_BASE_URL`） */
  baseUrl?: string;
  /** 可注入的 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 取当前时刻（毫秒）；缺省 `Date.now` */
  now?: () => number;
}

/** 同步运行时（装配产物）：账户 + 客户端 + 注册表 + 引擎 + 生命周期。 */
export interface SyncRuntime {
  account: SyncAccount;
  client: SyncClient;
  registry: SyncRegistry;
  engine: SyncEngine;
  /** 载入已持久化账户并（若已登录）启动调度；App 启动时 `await` 一次。 */
  init(): Promise<void>;
  /** 登录后的启动入口（内部由 `account.subscribe` 触发，一般不用手调）。 */
  start(): void;
  /** 登出：停调度 + 复位状态。 */
  stop(): void;
  /** 释放：取消所有 store / 账户订阅。 */
  dispose(): void;
}

/**
 * 需要订阅「本地变更」的 store（§G.3）。
 *
 * zustand 的 `subscribe` 在**任何 `set`** 后触发——不依赖调用方记得 notify，新增 store
 * 动作自动纳入。`sessionsStore` 也在其中：`updateSession` / `deleteSession` 都会 `set`。
 * 订阅「过灵」（`syncing` / `lastSync` 等运行时字段也触发）只会产生一次**合并后**的
 * 额外同步（`notifyLocalChange` 自带 1s 防抖且未登录即 no-op），无副作用。
 */
const SUBSCRIBED_STORES: Array<{
  subscribe: (listener: () => void) => () => void;
}> = [
  useAgentsStore,
  useExpertGroupsStore,
  useTasksStore,
  useMcpStore,
  useChannelsStore,
  useSkillsStore,
  useSettingsStore,
  useSessionsStore,
  useArtifactsStore,
];

/** 装配一个同步运行时（不入单例；单例用 `initSyncRuntime`）。 */
export function createSyncRuntime(opts: SyncRuntimeOptions = {}): SyncRuntime {
  const account = createStorageSyncAccount({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
  const client = new SyncClient({
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    getAccessToken: () => account.getAccessToken(),
    refreshAccessToken: () => account.refresh(),
  });
  const registry = createDefaultRegistry();
  const engine = new SyncEngine({
    client,
    account,
    registry,
    now: opts.now,
    cursorStore: createMemoryCursorStore(),
    // 事件流通道（批次 5）：装配适配器并注入引擎——引擎因此**不 import 任何 store**
    eventStream: createSessionEventStreamAdapter(),
    // C 类文件型资产通道（批次 6b）：记忆 / 身份文件 / 提示词覆盖。
    // 账户分片用同一个 `userId`——元数据必须按账户隔离（与事件水位同一条纪律）
    fileAssets: createFileAssetsAdapter(() => account.getSession()?.userId ?? ''),
    // 产物同步通道（批次 6）：索引条目（LWW 实体）+ 内容池（内容寻址 blob）。
    // 引擎因此**不 import 任何 store**（不变量 2）；store 的本地写入直接经适配器可见。
    artifacts: createArtifactsAdapter(),
  });

  // ── 本地变更 → 防抖同步（§G.3）──
  // `suppress`：同步执行期间抑制订阅触发的再同步（自激环）；
  // `missed`：该窗口内发生过的本地改动，同步结束后补一次，保证不丢。
  let suppress = false;
  let missed = false;
  const onChange = (): void => {
    if (suppress) missed = true;
    else engine.notifyLocalChange();
  };
  const unsubscribers = SUBSCRIBED_STORES.map((store) => store.subscribe(onChange));

  // ── 把引擎的 `syncNow` 包成「受抑制的执行」──
  // 覆盖实例自有属性后，引擎内部（定时器 / 防抖 / online）与外部调用都会走到这里，
  // 于是「同步期间落地的 set」统一被 `suppress` 抑制（见文件头「suppress 如何覆盖…」）。
  const runSyncNow = engine.syncNow.bind(engine);
  engine.syncNow = async (): Promise<Awaited<ReturnType<SyncEngine['syncNow']>>> => {
    suppress = true;
    try {
      return await runSyncNow();
    } finally {
      suppress = false;
      // 同步窗口内有过本地改动（用户点了、或 pull 落地）→ 补一次合并后的同步
      if (missed) {
        missed = false;
        engine.notifyLocalChange();
      }
    }
  };

  // ── 登录 / 登出 生命周期（订阅是唯一入口，§G.2）──
  const onSession = (session: AccountSession | null): void => {
    // 账户变化（登录 / 登出到 null / 换号）：复位「账户态」——pull 游标 + 内存事件水位。
    // runtime 全应用复用同一个 engine，且服务端为每个账户维护独立的 `server_seq` 空间：
    // 不复位则 B 会继承 A 的游标（`pull(since=A的值)` 拉不到任何数据）与水位（本机
    // `seq ≤ 水位` 的事件永不上行），两者都**不报错**。只清内存；持久化水位分片不动，切回可恢复。
    engine.resetAccountScopedState();
    if (session) {
      engine.start();
    } else {
      engine.stop();
      resetSyncStatus();
    }
  };
  const unsubAccount = account.subscribe(onSession);

  /*
   * 把「当前账户」注入审计日志（FR-8.9 应用操作留痕）。
   *
   * 只有这里知道登录态：`lib/audit/appAudit.ts` 不能直接 import 本模块（本模块订阅了全部
   * store，store 又要用审计 → 直接 import 必成环），所以走一次性注入。
   * provider 每次调用都读实时 session，登录 / 登出后立刻反映，不需要再注册一次。
   */
  setAppAuditActorProvider(() => account.getSession()?.userId ?? APP_AUDIT_LOCAL_ACTOR);

  /*
   * 把「知识库检索」注入会话链路（FR-2.3 第四条 / FR-4.7）。
   *
   * 为什么必须在这里注入：只有本模块同时知道**云端地址**与**当前 token**；而
   * `lib/agent/agentKnowledgeTurn.ts` 被 `sessionsStore` 使用，反过来 import 本模块就会
   * 成环（本模块订阅了 sessionsStore）。与上面审计的注入是同一个手法。
   *
   * 三条口径：
   * 1. 每次调用读**实时** token —— 换号 / 重新登录后不需要再注册一次；
   * 2. 未登录直接回 401，而不是拿空 token 去请求（那会被云端当成匿名，回一个
   *    看起来像「库里没资料」的 401，排查时极易误判）；
   * 3. `kbIds` 为空**整个字段不下发**：空数组在云端是 422（不是「不限范围」），
   *    「绑定整个组织」必须表达成「不限定范围」。
   */
  setKnowledgeSearchProvider(async ({ orgId, kbIds, query, topK }) => {
    const token = account.getAccessToken();
    if (!token) {
      return { ok: false, status: 401, message: '未登录账户', unauthorized: true };
    }
    const gateway = createKbGateway({
      baseUrl: (opts.baseUrl ?? resolveSyncBaseUrl()).replace(/\/+$/, ''),
      token,
      /*
       * 检索发生在**轮次之间**，而 access token 30 分钟就过期：只带一份快照，过期后
       * 每一轮都会静默变成「本轮没资料」（引擎侧只看到一条 401）。所以这里给实时取票
       * + 换票，让检索链路自己自愈 —— `account.refresh()` 是单飞的，并发轮次不会
       * 把同一张 refresh 用两次。
       */
      getToken: () => account.getAccessToken(),
      refreshToken: () => account.refresh(),
      fetchImpl: opts.fetchImpl,
    });
    return gateway.search(orgId, {
      query,
      topK,
      ...(kbIds.length > 0 ? { kbIds } : {}),
    });
  });

  /*
   * 把「项目共享记忆」注入会话链路（FR-12.7 ③）。
   *
   * 与知识库同一个手法、同一套理由（只有本模块同时知道云端地址与实时 token；
   * 反向 import 会成环）。差别只有一条：共享记忆**每轮都可能被别人改过**，
   * 所以这里也不缓存 —— 每次调用都真的打一次 `GET /api/projects/{id}/memory`。
   *
   * 未登录回 401（而不是拿空 token 请求）：云端会把匿名请求判成 401，而那与
   * 「项目没写记忆」在界面上长得一样，排查时极易误判。
   */
  setProjectMemoryProvider(async ({ projectId }) => {
    const token = account.getAccessToken();
    if (!token) {
      return { ok: false, status: 401, message: '未登录账户', unauthorized: true };
    }
    const gateway = createProjectGateway({
      baseUrl: (opts.baseUrl ?? resolveSyncBaseUrl()).replace(/\/+$/, ''),
      token,
      // 实时取票 + 401 换票重放一次（access token 30 分钟过期，预取发生在轮次之间）
      getToken: () => account.getAccessToken(),
      refreshToken: () => account.refresh(),
      fetchImpl: opts.fetchImpl,
    });
    return gateway.getMemory(projectId);
  });

  return {
    account,
    client,
    registry,
    engine,
    async init(): Promise<void> {
      // `account.load()` 会 `emit()` → `onSession(session)`：冷启动已登录则自动 `start()`
      await account.load();
      if (account.isAuthenticated()) engine.start();
    },
    start: () => engine.start(),
    stop: () => {
      engine.stop();
      resetSyncStatus();
    },
    dispose(): void {
      // 释放时摘掉注入：否则用例之间会残留上一个 runtime 的账户，audit 记录串号
      setAppAuditActorProvider(null);
      // 知识库检索同理：留着 provider 会让下一个用例用上一个 runtime 的 token 去请求
      setKnowledgeSearchProvider(null);
      setProjectMemoryProvider(null);
      unsubAccount();
      for (const unsubscribe of unsubscribers) unsubscribe();
      engine.stop();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// 模块级单例：全应用共用一份 runtime（见文件头「单例访问器」的理由）
// ─────────────────────────────────────────────────────────────────────

let syncRuntimeSingleton: SyncRuntime | null = null;

/**
 * 单例可用性订阅：单例**出现 / 释放**时通知订阅者。
 *
 * 存在的理由不是「通用性」，而是一个具体的坏状态：`initSyncRuntime()` 是**异步**的
 * （App 启动块要等设备号与会话列表就位），而侧边栏底部这种常驻 UI 的**首次渲染**
 * 一定早于它。若只读一次 `getSyncRuntime()`，就不会再有第二次机会——冷启动时明明
 * 已登录的用户，会一直看到「登录」入口（设置弹窗里的账户分区因为晚挂载而侥幸没事，
 * 但只要有人在启动一秒内打开设置，同样会看到「未登录」）。
 *
 * 与 `useSyncStatus` 的订阅是两件事：那边订阅的是**同步状态**，这边订阅的是
 * 「runtime 到了没」。前者在 runtime 内部，后者只能在装配层广播。
 */
const runtimeListeners = new Set<() => void>();

function emitRuntimeChange(): void {
  for (const listener of Array.from(runtimeListeners)) listener();
}

/** 订阅单例的可用性变化；返回取消订阅函数。 */
export function subscribeSyncRuntime(cb: () => void): () => void {
  runtimeListeners.add(cb);
  return () => {
    runtimeListeners.delete(cb);
  };
}

/** 取当前单例；未初始化返回 `null`（UI 只读，不创建）。 */
export function getSyncRuntime(): SyncRuntime | null {
  return syncRuntimeSingleton;
}

/**
 * 初始化并返回单例 runtime（幂等）：重复调用返回同一份，**不再新建**。
 *
 * 会 `await runtime.init()`（载入账户；已登录则启动调度）。App 启动块调用一次即可，
 * 其余消费方（侧栏账户入口 / 设置页）一律用 `useSyncRuntime()` / `getSyncRuntime()`
 * 取用，避免各造一份。
 *
 * ⚠️ 广播发生在 `init()` **之后**：`init()` 里 `account.load()` 才把已登录状态读出来，
 * 早一步广播等于把「运行时有了但账户还没载入」暴露给订阅者。
 */
export async function initSyncRuntime(opts: SyncRuntimeOptions = {}): Promise<SyncRuntime> {
  if (syncRuntimeSingleton) return syncRuntimeSingleton;
  const runtime = createSyncRuntime(opts);
  syncRuntimeSingleton = runtime;
  await runtime.init();
  emitRuntimeChange();
  return runtime;
}

/** 释放并清空单例（App 卸载 / 用例隔离）：`dispose()` 后置空，可再次 `init`。 */
export function disposeSyncRuntime(): void {
  syncRuntimeSingleton?.dispose();
  syncRuntimeSingleton = null;
  emitRuntimeChange();
}
