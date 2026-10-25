/**
 * 设备标识：`SyncMeta.updatedBy` 的唯一来源，也是「这条改动是哪台机器做的」的判据。
 *
 * ## 两侧取值方式不同，但必须是**同一个语义**
 *
 * - **Electron**：主进程在首次启动时生成 uuid 并落 ② `<userData>/device-id.txt`
 *   （`electron/storageRoutes.ts` 的 `DEVICE_ID_STORAGE_KEY`），经
 *   `platform.appInfo().deviceId` 暴露。本模块**不自己生成**——两处各自生成会得到
 *   两个 id，界面上「设备 ID」与同步元数据里的 `updatedBy` 就对不上，而这种不一致
 *   只会在跨端排查冲突时才被发现。
 * - **Web**：没有主进程，用同一个 key 在 localStorage 里生成并持久化一次。
 *   存储介质不同（② 文件 vs 浏览器 localStorage），所以同名不冲突。
 *
 * ⚠️ **不能填常量**（`'web'` / `'unknown'`）：多台浏览器会共用一个 `updatedBy`，
 * LWW 里「谁改的」就失去意义。
 *
 * ## 为什么除了异步入口还要一个同步读数
 *
 * store 的写动作（`updateAgent` / `setSettings` …）是**同步**的，标记 `markDirty` 时
 * 拿不到 Promise。所以这里是「启动预热一次 + 运行时同步读快照」，与
 * `PromptLibrary` / `IdentityService` 同构（见 skill §7.6 不变量 2：注入点不能 await）。
 */

import { platform } from '@/platform';
import { genId } from '@/lib/core/id';

/**
 * 设备标识的存储 key（Web 端落 localStorage）。
 *
 * 与 `electron/storageRoutes.ts` 的 `DEVICE_ID_STORAGE_KEY` **逐字相同**；这里刻意
 * 重新写字面量而不 import 它——那个模块 import 了 `node:path`，渲染层引它会把 node
 * 内置模块拖进浏览器包。
 */
export const DEVICE_ID_STORAGE_KEY = 'nanowork.deviceId';

/** 已解析出的设备标识；未预热时为 null */
let cached: string | null = null;

/** 在途的解析（并发去重：多个调用方不该各生成一个 uuid，那会得到两个设备身份） */
let inflight: Promise<string> | null = null;

async function loadDeviceId(): Promise<string> {
  // Electron：主进程已经生成并落盘，直接取。
  // appInfo 在 Web 端恒为 null（platform 层刻意如此，见 platform/index.ts 的注释）。
  const info = await platform.appInfo().catch(() => null);
  const fromApp = info?.deviceId?.trim();
  if (fromApp) return fromApp;

  // Web（或主进程没答）：本地生成一次并持久化，此后恒为同一个值
  const persisted = await platform.storage.get<string>(DEVICE_ID_STORAGE_KEY).catch(() => null);
  const existing = typeof persisted === 'string' ? persisted.trim() : '';
  if (existing !== '') return existing;

  const created = genId();
  // 写失败不阻断：本进程内仍返回同一个值（持久化只影响「重启后是否还是它」）
  await platform.storage.set(DEVICE_ID_STORAGE_KEY, created).catch(() => undefined);
  return created;
}

/**
 * 取设备标识（应用启动时调用一次即可）。重复调用不重复读盘、不重复生成。
 */
export function getDeviceId(): Promise<string> {
  if (cached !== null) return Promise.resolve(cached);
  if (inflight === null) {
    inflight = loadDeviceId()
      .then((id) => {
        cached = id;
        return id;
      })
      .finally(() => {
        // 无论成败都清掉在途标记：失败后下一次调用仍可重试，
        // 而不是把一个 rejected promise 永久发给所有调用方。
        inflight = null;
      });
  }
  return inflight;
}

/**
 * 同步读已预热的设备标识；未就绪返回 `null`。
 *
 * 调用方据此决定「现在写还是延后写」——**别用 `?? ''` 兜底**：空串会让同步层
 * 把这条改动判成「来源不明」，且写进磁盘后无法与真实值区分。
 */
export function currentDeviceId(): string | null {
  return cached;
}

/**
 * 用例专用：清空模块级缓存。
 *
 * 与 `hydratedSessions` / `sedimentedSessions` 同类（模块作用域状态，不随
 * `setState` 归零），跨用例复用会静默命中上一用例的缓存。新增此类状态时照此导出。
 */
export function __resetDeviceIdForTest(): void {
  cached = null;
  inflight = null;
}
