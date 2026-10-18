/**
 * 自动更新控制器（B4-01，GitHub Releases）。
 *
 * **为什么把状态机抽出来**：`electron-updater` 的真实行为（签名校验、差分下载、
 * 安装器拉起）只能在真机验证；但「事件 → 界面状态」的映射是纯逻辑，而且错了
 * **不会报错**——最典型的是把 `error` 当成「已是最新」显示，用户看到一句
 * 「已是最新」却永远升不上去。这里用依赖注入把 updater 换成替身，逐条钉住。
 *
 * 三条产品约束：
 *
 * 1. **不偷偷下载**：`autoDownload = false`。发现新版本先让用户看见，再由用户点
 *    「下载」——几十 MB 的流量不该由一个后台检查替用户决定。
 * 2. **不假装「已是最新」**：只有 `update-not-available` 事件才产出 `up-to-date`。
 *    任何异常都是 `error`，并把原始报错带出去（未签名构建被系统拦截时，用户至少
 *    知道原因，而不是被一句「最新版」骗过去）。
 * 3. **下载完不等于装好**：`downloaded` 之后必须显式「重启并安装」；同时
 *    `autoInstallOnAppQuit = true` 保证用户直接退出时也不会白下一个包。
 */

// 状态契约与渲染层共用一份定义：主进程不能反过来定义、渲染层再抄一遍，
// 那会让「主进程推的 phase」与「UI 判断的 phase」在两处各自漂移。
import type { UpdateStatus } from '../src/types/update';
export type { UpdatePhase, UpdateStatus } from '../src/types/update';

/**
 * `electron-updater` 的最小面。抽出来是为了让单测能用替身，而不是为了兼容别的实现。
 */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  // 事件名与载荷由 `electron-updater` 定义（`update-available` 带 info、
  // `download-progress` 带 progress…），这里只要求「能挂监听」，不重复它的事件表。
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateControllerDeps {
  updater: UpdaterLike;
  /** `app.isPackaged`：开发态没有 `app-update.yml`，任何检查都会抛错。 */
  isPackaged: boolean;
  currentVersion: string;
  /** 状态变化推送（生产环境是 `webContents.send`）。 */
  emit: (status: UpdateStatus) => void;
}

export interface UpdateController {
  getStatus(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  /** @returns 是否真的发起了安装（只有已下载时才为 true）。 */
  install(): boolean;
}

function errorStatus(err: unknown, currentVersion: string, availableVersion?: string): UpdateStatus {
  return {
    phase: 'error',
    currentVersion,
    availableVersion,
    // 原始报错直接透出：签名失败 / 404 / 网络不可达的修法完全不同，改写只会丢信息。
    message: err instanceof Error ? err.message : String(err),
  };
}

function clampPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const { updater, isPackaged, currentVersion, emit } = deps;

  let status: UpdateStatus = isPackaged
    ? { phase: 'idle', currentVersion }
    : { phase: 'unsupported', currentVersion };

  const publish = (next: UpdateStatus): void => {
    status = next;
    emit(status);
  };

  // 这三条只设一次：控制器每个进程只创建一次。
  updater.autoDownload = false;
  // 已下载的包在退出时安装——否则用户点完「下载」直接关窗口，更新永远不生效。
  updater.autoInstallOnAppQuit = true;

  updater.on('checking-for-update', () => {
    publish({ phase: 'checking', currentVersion });
  });
  updater.on('update-available', (info: { version?: string }) => {
    publish({
      phase: 'available',
      currentVersion,
      availableVersion: info?.version,
    });
  });
  updater.on('update-not-available', () => {
    // **唯一**允许出现「已是最新」的分支。
    publish({ phase: 'up-to-date', currentVersion });
  });
  updater.on('download-progress', (progress: { percent?: number }) => {
    publish({
      phase: 'downloading',
      currentVersion,
      availableVersion: status.availableVersion,
      percent: clampPercent(progress?.percent),
    });
  });
  updater.on('update-downloaded', (info: { version?: string }) => {
    publish({
      phase: 'downloaded',
      currentVersion,
      availableVersion: info?.version ?? status.availableVersion,
      percent: 100,
    });
  });
  updater.on('error', (err: unknown) => {
    publish(errorStatus(err, currentVersion, status.availableVersion));
  });

  return {
    getStatus: () => status,

    async check() {
      if (!isPackaged) {
        // 开发态没有 `app-update.yml`：直接判「不支持」，不要让它抛出一个
        // 看起来像「更新失败」的错——那会让开发者以为发布流程坏了。
        publish({ phase: 'unsupported', currentVersion });
        return status;
      }
      publish({ phase: 'checking', currentVersion });
      try {
        await updater.checkForUpdates();
      } catch (err) {
        publish(errorStatus(err, currentVersion, status.availableVersion));
      }
      return status;
    },

    async download() {
      // 只有「已发现新版本」才允许下载：在 idle / checking 下点下载没有意义，
      // 而在 downloaded 下重复调用会白跑一遍。
      if (!isPackaged || status.phase !== 'available') return status;
      publish({
        phase: 'downloading',
        currentVersion,
        availableVersion: status.availableVersion,
        percent: 0,
      });
      try {
        await updater.downloadUpdate();
      } catch (err) {
        publish(errorStatus(err, currentVersion, status.availableVersion));
      }
      return status;
    },

    install() {
      // 没下载完就 `quitAndInstall` 等于把用户踢下线却什么都没装。
      if (status.phase !== 'downloaded') return false;
      updater.quitAndInstall(false, true);
      return true;
    },
  };
}
