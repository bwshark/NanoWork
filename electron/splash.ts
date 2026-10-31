/**
 * 启动屏窗口（冷启动门禁）。
 *
 * ## 它解决的问题
 *
 * 打包版冷启动时 `nanobot serve` 从 spawn 到 listen 实测约 9.4 秒，而主窗口是
 * **立刻显示**的：用户看到的是一个空列表、灰掉的模型下拉、`Failed to fetch` 的
 * 提示条。那不是"慢"，是"看起来坏了"。启动屏把这段等待变成**可解释的过程**：
 * 看见在做什么、做了多久、卡在哪一步。
 *
 * ## 三条不能让步的原则
 *
 * 1. **不把并行变成串行**。主窗口照样在启动屏后面创建、渲染、拉数据；引擎照样
 *    并行拉起。启动屏只是一个盖在上面的画布 —— 若为了它把启动流程改成串行，
 *    总耗时反而变长，那就是用体验换体验。
 * 2. **不伪造成度**。进度只来自真实阶段（见 `splashState.ts` 的权重说明）。
 * 3. **永不成为阻塞**。任何一条路都必须能走到"交接"：
 *    - 引擎起不来 → 切错误卡片，给「重试 / 先进入应用」，并**倒计时自动进入**；
 *    - 引擎超时 → 直接交接（剩下的交给应用内的引擎自检）；
 *    - 用户关掉启动屏（Alt+F4）→ 立即交接；
 *    - 渲染层没报到 → 硬超时交接。
 *    一句话：启动屏可以不好看，但不能让应用打不开。
 *
 * ## 为什么窗口参数写在这里而不是 `windowPreferences`
 *
 * 安全档位（sandbox / webSecurity / preload）仍然**只**从 `createWindowPreferences`
 * 取 —— 启动屏是 `splash` 角色，拿不到 `webSecurity:false`，也没有 node 集成。
 * 这里只写窗口外观（尺寸 / 无边框 / 不占任务栏），那些不属于安全档位。
 */

import { BrowserWindow, screen } from 'electron';
import { createWindowPreferences } from './windowPreferences';
import {
  buildView,
  classifyEngineFailure,
  createPhaseStatuses,
  type PhaseStatuses,
  type SplashFailure,
  type SplashPhaseId,
  type SplashPhaseStatus,
  type SplashTheme,
  type SplashView,
} from './splashState';

/** 启动屏尺寸（DIP）。够放 4 行阶段 + 进度条 + 两行提示，再大就是占地方。 */
export const SPLASH_SIZE = { width: 460, height: 360 } as const;

/**
 * 最短可见时长。
 *
 * 没有它会出现"闪一下就没"：引擎已经预热、窗口也秒开时，启动屏只活 80ms，
 * 视觉上就是应用启动时闪了个白块 —— 比不显示更糟。
 */
export const SPLASH_MIN_VISIBLE_MS = 600;

/**
 * 等引擎的硬上限。
 *
 * 30 秒不是拍脑袋：`serve` 正常 10 秒内就绪，卡到 30 秒基本可以判定为"不会好了"。
 * 到点不再问用户，直接交接 —— 让一个已经没救的等待继续占着屏幕，才是真正的不负责。
 */
export const SPLASH_ENGINE_TIMEOUT_MS = 30_000;

/**
 * 错误卡片上"自动进入应用"的倒计时。
 *
 * 8 秒的依据：足够读完两行字 + 决定要不要点重试，又不至于让人以为卡死。
 * 倒计时**必须有**：用户在这一步往往已经不耐烦，任何"必须点一下才能继续"的设计
 * 都会把一次可恢复的故障变成一个差评。
 */
export const SPLASH_ERROR_AUTO_ENTER_MS = 8_000;

/**
 * 等网关的上限。
 *
 * 网关这一步是**门禁**（见 `waitForBoot`）：它没有结论就不进第 4 行。但 IM 长连接牵扯
 * 的是外部服务，谁也不敢保证它一定在合理时间内回答，所以必须带一个上限 ——
 * 到点记成「跳过 · 后台继续连接」继续走，绝不让一个 IM 通道把整个应用挡在启动屏后面。
 *
 * 12 秒的取法：`startNanobotGateway` 内部对 health 端口的等待是 `LAUNCH_READY_TIMEOUT_MS`
 * 量级，正常路径几秒内就有结论；超过 12 秒基本可以判定"这次不会好了"。
 */
export const SPLASH_GATEWAY_TIMEOUT_MS = 12_000;

/**
 * 四步全绿后的停留时长。
 *
 * 没有它会出现一种很具体的挫败感：交接与销毁是同一个 tick，用户只看到三个勾，
 * 第四个勾永远没机会被看见 —— 他没法确认"载入工作台"这一步到底成没成。
 */
export const SPLASH_COMPLETE_HOLD_MS = 350;

/** 引擎侧只有三种结论：起来了 / 没起来 / 这一步不需要（未安装） */
export type BootEngineOutcome = 'ok' | 'failed' | 'skipped';

/** 交接原因，用于日志与剖析（哪一种出口走得多，决定下一步该优化哪里） */
export type BootHandoffReason = 'ready' | 'degraded' | 'timeout' | 'disabled';

export interface WaitForBootInput {
  /** serve 的启动结果。**不等 gateway**：IM 长连接不该拦住首屏。 */
  engine: Promise<BootEngineOutcome>;
  /** 主窗口渲染层报到（`app:renderer-ready`） */
  rendererReady: Promise<void>;
  /**
   * gateway 的结果。
   *
   * **参与门禁**：没有结论就不进第 4 行（「载入工作台」），因为"网关还没起来就已经
   * 显示工作台已载入"是顺序上的谎话。上限见 `SPLASH_GATEWAY_TIMEOUT_MS`：
   * 到点仍无结论则记成「跳过 · 后台继续连接」继续走，不让 IM 通道挡住整个应用。
   */
  gateway?: Promise<boolean>;
  /** 用户在错误卡片上点「重试」时调用；返回新的引擎结果 */
  retryEngine?: () => Promise<BootEngineOutcome>;
  /**
   * 失败时取一句原始报错（由 main 提供）。
   *
   * 用"回调"而不是"参数"，是为了绕开一个必然踩到的时序问题：引擎的结果先于
   * 错误卡片产生，而报错细节是在 main 里那个 `.then` 里才知道的。传值要么拿不到、
   * 要么依赖 `Promise.then` 的注册顺序（后者是隐式契约，改一行就悄悄失效）。
   */
  describeEngineFailure?: () => string;
}

export interface BootScreenOptions {
  /** false = 完全跳过（环境变量开关 / 单测） */
  enabled: boolean;
  htmlPath: string;
  preloadPath: string;
  iconPath?: string;
  theme: SplashTheme;
  version: string;
  minVisibleMs?: number;
  engineTimeoutMs?: number;
  autoEnterAfterErrorMs?: number;
  /** 注入时钟（测试用） */
  now?: () => number;
  onOpenLogs?: () => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface BootScreen {
  /** 是否真的有一块启动屏（关闭态下所有方法都是 no-op） */
  readonly active: boolean;
  mark(id: SplashPhaseId, status: SplashPhaseStatus, detail?: string): void;
  waitForBoot(input: WaitForBootInput): Promise<BootHandoffReason>;
  /**
   * 最后一步：把「载入工作台」打勾并停留一瞬，让四个勾同框可见。
   *
   * 必须在**交接之前**调用（那时主窗口还没露面，启动屏还在最上层），
   * 否则这一刻会被主窗口盖住，等于没做。
   */
  complete(celebrate: boolean): Promise<void>;
  /** 主窗口已显示 → 收掉启动屏（内部会补足最短可见时长） */
  finish(): Promise<void>;
  focus(): void;
  isShowing(): boolean;
  /** IPC 来源校验：只接受启动屏自己那个 webContents 发来的指令 */
  owns(sender: unknown): boolean;
  /** 错误卡片上的按钮（由 main 的 IPC 转进来） */
  requestRetry(): void;
  requestContinue(): void;
  destroy(): void;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/** 关闭态：连数组都不分配，`main` 里不必到处写 `if (bootScreen?.active)` */
function createDisabledBootScreen(): BootScreen {
  return {
    active: false,
    mark: () => {},
    waitForBoot: async () => 'disabled',
    complete: async () => {},
    finish: async () => {},
    focus: () => {},
    isShowing: () => false,
    owns: () => false,
    requestRetry: () => {},
    requestContinue: () => {},
    destroy: () => {},
  };
}

export function createBootScreen(options: BootScreenOptions): BootScreen {
  if (!options.enabled) return createDisabledBootScreen();
  return new SplashWindow(options);
}

/** 填了默认值的选项表（三个时长在这里从可选变必填，省掉调用处的 `?? 0`） */
type ResolvedOptions = BootScreenOptions &
  Required<Pick<BootScreenOptions, 'minVisibleMs' | 'engineTimeoutMs' | 'autoEnterAfterErrorMs'>>;

class SplashWindow implements BootScreen {
  readonly active = true;

  private readonly options: ResolvedOptions;

  private win: BrowserWindow | null = null;
  private statuses: PhaseStatuses = createPhaseStatuses();
  private detail = '';
  private error: SplashFailure | null = null;
  private autoEnterInSec: number | null = null;
  private disposed = false;

  private readonly startedAt: number;
  /** 真正可见的时刻：最短时长的计时起点必须是"看见"，不是"创建" */
  private shownAt: number | null = null;

  private tickTimer: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private errorTimer: NodeJS.Timeout | null = null;

  /** 错误卡片上的一次决策（点按钮或倒计时），由 IPC / 定时器 settle */
  private decide: ((choice: 'retry' | 'continue') => void) | null = null;

  /** 引擎行是否已有结论（网关行要等它，见 `trackGateway`） */
  private engineSettled = false;
  /** 网关的真实结论：`pending` 表示还没动静 */
  private gatewayOutcome: 'pending' | 'ok' | 'failed' | 'skipped' = 'pending';
  /** 网关那一行是否已经画出去（防止超时落成 `skipped` 之后又被迟到的结果改回 `done`） */
  private gatewayMarked = false;

  /** 用户用 Alt+F4 关掉启动屏 = "别挡着我，直接进" */
  private readonly closedSignal: Promise<void>;
  private onClosed: (() => void) | null = null;

  constructor(options: BootScreenOptions) {
    this.options = {
      minVisibleMs: SPLASH_MIN_VISIBLE_MS,
      engineTimeoutMs: SPLASH_ENGINE_TIMEOUT_MS,
      autoEnterAfterErrorMs: SPLASH_ERROR_AUTO_ENTER_MS,
      ...options,
    };
    this.closedSignal = new Promise<void>((resolve) => {
      this.onClosed = resolve;
    });
    this.startedAt = this.now();
    this.createWindow();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.options.log?.(level, message);
  }

  private createWindow(): void {
    const { width, height } = SPLASH_SIZE;
    const { webPreferences } = createWindowPreferences({
      kind: 'splash',
      preload: this.options.preloadPath,
    });

    const win = new BrowserWindow({
      width,
      height,
      useContentSize: true,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      // 不占任务栏：启动屏不是"一个窗口"，用户不该在这里看到两个图标
      skipTaskbar: true,
      backgroundColor: this.options.theme === 'dark' ? '#0b1120' : '#f5f7fa',
      ...(this.options.iconPath ? { icon: this.options.iconPath } : {}),
      title: 'NanoWork',
      webPreferences,
    });
    this.win = win;

    // 居中在**主屏**上：启动屏出现在副屏而主窗口出现在主屏，是最典型的"感觉卡了"
    const { workArea } = screen.getPrimaryDisplay();
    win.setPosition(
      Math.round(workArea.x + (workArea.width - width) / 2),
      Math.round(workArea.y + (workArea.height - height) / 2),
    );

    win.once('ready-to-show', () => {
      if (this.disposed) return;
      this.shownAt = this.now();
      win.show();
      this.render();
    });

    win.webContents.on('did-finish-load', () => this.render());

    win.on('closed', () => {
      this.disposed = true;
      this.win = null;
      this.stopTimers();
      // 用户主动关掉启动屏 → 让 `waitForBoot` 立刻走交接，而不是继续等一个看不见的界面
      this.onClosed?.();
      this.onClosed = null;
    });

    // 单句慢启动提示需要 1 秒的粒度；这个定时器生命期只到交接为止
    this.tickTimer = setInterval(() => {
      if (!this.error) this.render();
    }, 1000);
    this.tickTimer.unref?.();

    const query: Record<string, string> = { theme: this.options.theme, version: this.options.version };
    void win.loadFile(this.options.htmlPath, { query }).catch((error: unknown) => {
      // 启动屏自己加载失败：绝不能因此把应用卡住，直接交接
      this.log('error', `启动屏页面加载失败：${String(error)}`);
      this.onClosed?.();
      this.onClosed = null;
    });
  }

  mark(id: SplashPhaseId, status: SplashPhaseStatus, detail?: string): void {
    if (this.disposed) return;
    this.statuses = { ...this.statuses, [id]: status };
    if (detail !== undefined) this.detail = detail;
    else if (status === 'active') this.detail = '';
    this.render();
  }

  private view(): SplashView {
    return buildView({
      theme: this.options.theme,
      version: this.options.version,
      statuses: this.statuses,
      detail: this.detail,
      elapsedMs: this.now() - (this.shownAt ?? this.startedAt),
      error: this.error,
      autoEnterInSec: this.autoEnterInSec,
    });
  }

  private render(): void {
    const wc = this.win?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send('splash:state', this.view());
  }

  async waitForBoot(input: WaitForBootInput): Promise<BootHandoffReason> {
    let engine = this.trackEngine(input.engine);
    if (input.gateway) this.trackGateway(input.gateway);

    for (;;) {
      const outcome = await this.raceOutcome(engine, input.rendererReady);
      if (outcome === 'ready') {
        // 引擎与界面都就绪了，但第 3 步（网关）还没结论：这一步是门禁，等它。
        const gateway = await this.awaitGateway(input.gateway);
        if (gateway === 'closed') return 'degraded';
        if (gateway === 'timeout') {
          this.log('warn', `网关 ${SPLASH_GATEWAY_TIMEOUT_MS / 1000} 秒内没有结论，按「跳过」继续`);
        }
        return 'ready';
      }
      if (outcome === 'closed') return 'degraded';
      if (outcome === 'timeout') {
        // 到点不再征询意见：已经等了 30 秒的人只想进去
        this.mark('engine', 'failed', '启动超时');
        this.log('warn', '启动屏等待引擎超过上限，直接交接');
        return 'timeout';
      }

      // 引擎明确失败 → 把"发生了什么 + 该怎么办"摆出来，让用户决定
      const failure = classifyEngineFailure(
        input.describeEngineFailure?.() || '引擎进程未在超时前进入监听',
      );
      this.log('warn', `引擎启动失败：${failure.kind}（${failure.detail}）`);
      const choice = await this.ask(failure);
      if (choice === 'retry' && input.retryEngine) {
        this.error = null;
        this.engineSettled = false;
        this.gatewayMarked = false;
        this.mark('engine', 'active');
        engine = this.trackEngine(input.retryEngine());
        continue;
      }
      return 'degraded';
    }
  }

  /**
   * 把引擎结果同步到阶段状态：main 只负责拉起，状态只在这里改，避免两处打架
   */
  private trackEngine(engine: Promise<BootEngineOutcome>): Promise<BootEngineOutcome> {
    return engine
      .catch((): BootEngineOutcome => 'failed')
      .then((outcome) => {
        // 失败时不写 detail：那句话来自 main 的 `describeEngineFailure`，
        // 让上一阶段残留的文案（如端口号）留在错误卡片上会把人带偏
        this.mark('engine', outcome === 'ok' ? 'done' : outcome === 'skipped' ? 'skipped' : 'failed');
        this.engineSettled = true;
        this.flushGatewayMark();
        return outcome;
      });
  }

  /**
   * 网关的结果**不即时上屏**：要等引擎这一步先落地（见 `flushGatewayMark`）。
   *
   * 两个进程是并行拉起的，网关经常先于 serve 就绪（它只是连自己的端口）。
   * 如果它先打勾，用户看到的就是「引擎还在转、网关已经绿」——顺序感的破坏
   * 比慢一点更让人怀疑"是不是乱了"。这里只推迟**显示**，不改判定。
   */
  private trackGateway(gateway: Promise<boolean>): void {
    void gateway
      .catch(() => false)
      .then((ok) => {
        this.gatewayOutcome = ok ? 'ok' : 'failed';
        this.flushGatewayMark();
      });
  }

  private flushGatewayMark(): void {
    if (this.gatewayMarked) return;
    // 顺序保证：引擎没有结论之前，网关行不单独变绿
    if (!this.engineSettled) return;
    if (this.gatewayOutcome === 'pending') return;
    this.gatewayMarked = true;
    this.mark('gateway', this.gatewayOutcome === 'ok' ? 'done' : 'skipped');
  }

  /**
   * 第 3 步的门禁：等网关有结论，上限 `SPLASH_GATEWAY_TIMEOUT_MS`。
   *
   * 只在引擎与界面都就绪之后调用 —— 顺序不能反，否则又回到"引擎还在转、下面先绿"。
   * 到点仍无结论就落成「跳过 · 后台继续连接」：语义上诚实（它确实还在连），
   * 也保证四步不会在交接时留下一个空心圈。
   */
  private async awaitGateway(
    gateway?: Promise<boolean>,
  ): Promise<'ok' | 'timeout' | 'closed'> {
    if (!gateway) return 'ok';
    // 已有结论（`trackGateway` 已经把它画上去了），不必再等
    if (this.gatewayOutcome !== 'pending') return 'ok';

    const settled = await Promise.race([
      gateway.then(
        () => 'ok' as const,
        () => 'ok' as const,
      ),
      delay(SPLASH_GATEWAY_TIMEOUT_MS).then(() => 'timeout' as const),
      this.closedSignal.then(() => 'closed' as const),
    ]);

    if (settled === 'timeout') {
      this.gatewayOutcome = 'skipped';
      this.gatewayMarked = true;
      this.mark('gateway', 'skipped', '后台继续连接');
    }
    return settled;
  }

  private raceOutcome(
    engine: Promise<BootEngineOutcome>,
    rendererReady: Promise<void>,
  ): Promise<'ready' | 'engine-failed' | 'timeout' | 'closed'> {
    const renderer = rendererReady.catch(() => undefined);

    const ready = Promise.all([engine, renderer]).then(([outcome]) =>
      outcome === 'failed' ? ('engine-failed' as const) : ('ready' as const),
    );

    // 引擎失败不必等渲染层：多等的那几秒，用户看到的只是一个不动的进度条
    const failedEarly = engine.then((outcome) =>
      outcome === 'failed'
        ? ('engine-failed' as const)
        : new Promise<never>(() => {
            /* 只有失败才提前唤醒，成功仍等 `ready` */
          }),
    );

    const deadline = new Promise<'timeout'>((resolve) => {
      this.deadlineTimer = setTimeout(() => resolve('timeout'), this.options.engineTimeoutMs);
      this.deadlineTimer.unref?.();
    });

    const closed = this.closedSignal.then(() => 'closed' as const);

    return Promise.race([ready, failedEarly, deadline, closed]).finally(() => {
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    });
  }

  /** 显示错误卡片并等一个决定（点按钮，或倒计时走完自动进入） */
  private ask(failure: SplashFailure): Promise<'retry' | 'continue'> {
    this.error = failure;
    this.autoEnterInSec = Math.max(1, Math.ceil(this.options.autoEnterAfterErrorMs / 1000));
    this.render();

    return new Promise<'retry' | 'continue'>((resolve) => {
      this.decide = (choice) => {
        this.decide = null;
        this.error = null;
        this.autoEnterInSec = null;
        this.stopErrorTimer();
        resolve(choice);
        this.render();
      };
      this.errorTimer = setInterval(() => {
        const left = (this.autoEnterInSec ?? 1) - 1;
        this.autoEnterInSec = Math.max(0, left);
        this.render();
        if (left <= 0) this.decide?.('continue');
      }, 1000);
      this.errorTimer.unref?.();
    });
  }

  requestRetry(): void {
    this.decide?.('retry');
  }

  requestContinue(): void {
    this.decide?.('continue');
  }

  owns(sender: unknown): boolean {
    return Boolean(this.win && sender === this.win.webContents);
  }

  isShowing(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  focus(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  async finish(): Promise<void> {
    if (this.disposed) return;
    const visibleFor = this.now() - (this.shownAt ?? this.startedAt);
    const wait = this.options.minVisibleMs - visibleFor;
    if (wait > 0) await delay(wait);
    this.destroy();
  }

  async complete(celebrate: boolean): Promise<void> {
    if (this.disposed) return;
    if (!celebrate) return;
    // 「载入工作台」的勾落在这里，而不是渲染层报到的那一刻：
    // 主窗口是并行加载的，渲染层早在引擎还没起来时就已经挂载完了 ——
    // 那时打勾就会出现"第 4 步绿了、第 2 步还在转"的乱序（真机已复现）。
    this.mark('ui', 'done');
    // 停留一瞬：交接和销毁在同一个 tick 的话，用户永远看不到第 4 个勾
    await delay(SPLASH_COMPLETE_HOLD_MS);
  }

  destroy(): void {
    // 决策挂起时先 settle：否则 `waitForBoot` 会永远停在那次 await 上，交接永不发生
    this.decide?.('continue');
    this.decide = null;
    this.stopTimers();
    const win = this.win;
    this.win = null;
    this.disposed = true;
    if (win && !win.isDestroyed()) win.destroy();
  }

  private stopErrorTimer(): void {
    if (this.errorTimer) clearInterval(this.errorTimer);
    this.errorTimer = null;
  }

  private stopTimers(): void {
    this.stopErrorTimer();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}
