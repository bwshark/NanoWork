/**
 * 单实例锁（FR-13.1）。
 *
 * **为什么必须做**：双开时第二实例不会失败退出，而是走 `main.ts` 的「复用端口」分支——
 * 于是两个窗口共用一个引擎。更糟的是**第二实例退出时会 taskkill 掉它以为是自己拉起的
 * 进程**，第一个实例瞬间失连。这是真实的连接/数据损坏路径，不是体验问题。
 *
 * **为什么抽成模块**：锁语义本身只有四行，但它是「抢锁失败就必须什么都不做」的
 * 安全关键分支——写在 `main.ts` 顶层就永远测不到（要起真 Electron 才能验证）。
 * 这里把依赖收缩成「按事件命名」的最小面，用替身就能完整验证两条路径。
 *
 * ⚠️ 为什么不直接收 `Electron.App`：`app.on` 是一大把重载，把一个重载集合赋给单一
 * 签名时 TS 只拿第一个重载来比，必然不兼容，只能靠 `as never` 硬转。所以这里按
 * **用到的那个事件**命名（`onSecondInstance`），适配的 5 行写在 `main.ts`。
 */

/** 单实例所需的最小宿主面（只取用到的三个能力，便于替身注入） */
export interface SingleInstanceHost {
  requestSingleInstanceLock(): boolean;
  /** 第二个实例被启动时触发（`app.on('second-instance', …)`） */
  onSecondInstance(listener: (argv: readonly string[], workingDirectory: string) => void): unknown;
  /** 立即退出（不跑 before-quit / will-quit）——第二个实例什么都还没建，正该如此 */
  exit(code?: number): void;
}

export interface AcquireSingleInstanceResult {
  /** 是否拿到锁。false = 本进程是第二个实例，调用方应立刻停止一切后续动作 */
  isPrimary: boolean;
}

/**
 * 申请单实例锁。
 *
 * 抢锁失败时**立即 `exit(0)`**：此刻尚未建窗、未拉引擎，直接退出的代价为零；
 * 若放它继续走到 `app.whenReady()`，那条路上会 `createWindow()` + `startNanobot()`，
 * 与主实例抢同一个端口。
 *
 * @param host `app` 的适配面（见模块注释为何不直接传 `app`）
 * @param onSecondInstance 主实例收到「第二个实例被启动」时的回调。
 *
 * ⚠️ **回调必须收下 argv**（B4-02）：深链是「第二个实例带着一条 URL 启动」的
 * 典型场景——`nanowork://open-session?id=…` 就在 `argv` 里。把参数吞掉，用户
 * 双击链接时应用只会被唤起，却不会打开目标会话，且没有任何报错。
 */
export function acquireSingleInstance(
  host: SingleInstanceHost,
  onSecondInstance: (
    argv: readonly string[],
    workingDirectory: string,
  ) => void,
): AcquireSingleInstanceResult {
  const isPrimary = host.requestSingleInstanceLock();

  // 第二个实例：**不注册** second-instance 监听。它马上就要退出，注册了也没有
  // 接收方；留着一个永不触发的监听只会让人误以为这里做了什么事。
  if (!isPrimary) {
    host.exit(0);
    return { isPrimary: false };
  }

  host.onSecondInstance((argv, workingDirectory) => onSecondInstance(argv, workingDirectory));
  return { isPrimary: true };
}
