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
 * 3. **单例访问器**（`getSyncRuntime` / `initSyncRuntime` / `disposeSyncRuntime`）：
 *    runtime 订阅了 8 个 store 且持有定时器，必须**全应用一个**——否则登录页、徽章、
 *    设置页各造一个，就会有 N 份订阅与 N 条 30s 定时同步同时在跑。
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
import { useSessionsStore } from '@/stores/sessionsStore';
import { SyncClient } from './SyncClient';
import { SyncEngine, createMemoryCursorStore } from './SyncEngine';
import { createSessionEventStreamAdapter } from './eventStream';
import { createFileAssetsAdapter } from './fileAssets';
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

/** 取当前单例；未初始化返回 `null`（UI 只读，不创建）。 */
export function getSyncRuntime(): SyncRuntime | null {
  return syncRuntimeSingleton;
}

/**
 * 初始化并返回单例 runtime（幂等）：重复调用返回同一份，**不再新建**。
 *
 * 会 `await runtime.init()`（载入账户；已登录则启动调度）。App 启动块调用一次即可，
 * 其余消费方（徽章 / 设置页）一律用 `getSyncRuntime()` 取用，避免各造一份。
 */
export async function initSyncRuntime(opts: SyncRuntimeOptions = {}): Promise<SyncRuntime> {
  if (syncRuntimeSingleton) return syncRuntimeSingleton;
  const runtime = createSyncRuntime(opts);
  syncRuntimeSingleton = runtime;
  await runtime.init();
  return runtime;
}

/** 释放并清空单例（App 卸载 / 用例隔离）：`dispose()` 后置空，可再次 `init`。 */
export function disposeSyncRuntime(): void {
  syncRuntimeSingleton?.dispose();
  syncRuntimeSingleton = null;
}
