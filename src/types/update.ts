/**
 * 自动更新的状态契约（B4-01）。
 *
 * 主进程（`electron/updater.ts`）与渲染层（`UpdaterCard`）共用这一份定义：
 * 渲染层不能 import `electron/**`，主进程反向依赖 `src/types/*` 是本仓既有做法。
 */
export type UpdatePhase =
  /** 未打包 / Web 端 / 平台不支持：没有自动更新这回事。 */
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  /** 当前版本（`app.getVersion()`）。 */
  currentVersion: string;
  /** 新版本号（`update-available` / `update-downloaded` 事件携带）。 */
  availableVersion?: string;
  /** 下载进度 0–100。 */
  percent?: number;
  /**
   * `phase === 'error'` 时的**原始**报错。
   *
   * 不做「友好化」改写：签名失败 / 404 / 网络不可达的修法完全不同，改写只会丢信息。
   */
  message?: string;
}
