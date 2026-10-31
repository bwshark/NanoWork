/**
 * 启动屏的**纯状态机**（不 import electron，可在 node 下直接单测）。
 *
 * ## 为什么单独一层
 *
 * 启动屏最容易写坏的两处都不是"窗口怎么建"，而是**进度怎么算**与**失败怎么说话**：
 *
 * - 进度条若按时间自动跑（`setInterval` 每秒 +3%），它会在引擎还没起来时就到 100%，
 *   然后在 100% 上再停 6 秒 —— 那正是"假进度"最伤人的形态：用户以为卡死了。
 *   这里只按**真实阶段完成度**加权，且全阶段落地前封顶 99%。
 * - 失败若只把原始报错贴到屏幕上（`spawn ENOENT`），用户看不懂也不知道该做什么。
 *   这里把常见成因翻译成「发生了什么 + 该怎么办」，原始文本仍保留在 `detail`。
 *
 * 窗口生命周期那一半在 `splash.ts`，它 import electron，因此不可单测。
 */

/** 启动阶段。顺序即展示顺序。 */
export type SplashPhaseId = 'env' | 'engine' | 'gateway' | 'ui';

/** 单个阶段的状态。`skipped` 与 `done` 都算"已落地"，但文案不同。 */
export type SplashPhaseStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface SplashPhaseDef {
  id: SplashPhaseId;
  label: string;
  /**
   * 进度权重。**按用户实际等待的时长分配，不按阶段数量平均分**：
   * `nanobot serve` 从 spawn 到 listen 实测约 9.4 秒，占了冷启动的绝大部分，
   * 所以给它 0.6；网关是并行的 IM 长连接、不拦首屏，只给 0.1。
   */
  weight: number;
}

export const SPLASH_PHASES: readonly SplashPhaseDef[] = [
  { id: 'env', label: '准备运行环境', weight: 0.1 },
  { id: 'engine', label: '启动智能体引擎', weight: 0.6 },
  { id: 'gateway', label: '连接消息网关', weight: 0.1 },
  { id: 'ui', label: '载入工作台', weight: 0.2 },
];

export type SplashTheme = 'light' | 'dark';

export type PhaseStatuses = Record<SplashPhaseId, SplashPhaseStatus>;

/** 失败成因分类：只用于挑文案，不参与任何控制流 */
export type SplashFailureKind =
  | 'port-conflict'
  | 'engine-missing'
  | 'engine-timeout'
  | 'renderer-load'
  | 'unknown';

export interface SplashFailure {
  kind: SplashFailureKind;
  /** 一句话说清发生了什么 */
  title: string;
  /** 用户现在能做什么（这是错误页真正的价值，比 title 更重要） */
  advice: string;
  /** 原始报错，折叠展示 / 进日志 */
  detail: string;
}

export interface SplashView {
  theme: SplashTheme;
  version: string;
  title: string;
  /** 主进度文案（当前正在做的事 / 错误标题） */
  message: string;
  /** 次级说明（慢启动提示 / 错误建议）。空串表示不显示。 */
  hint: string;
  /** 0..1；全阶段落地前封顶 0.99 */
  progress: number;
  phases: SplashPhaseRow[];
  error: SplashFailure | null;
  /** 错误态下"自动进入应用"的倒计时秒数；null = 不自动进入 */
  autoEnterInSec: number | null;
}

export interface SplashPhaseRow {
  id: SplashPhaseId;
  label: string;
  status: SplashPhaseStatus;
}

export interface BuildViewInput {
  theme: SplashTheme;
  version: string;
  statuses: PhaseStatuses;
  /** 当前阶段的补充说明（如"端口 18900"），可空 */
  detail?: string;
  /** 启动屏已显示多久（毫秒），用于慢启动提示 */
  elapsedMs: number;
  error?: SplashFailure | null;
  autoEnterInSec?: number | null;
}

/** 慢启动的两道坎：超过它就换一句更诚实的话，而不是让界面静默停住 */
export const SLOW_HINT_MS = 6_000;
export const VERY_SLOW_HINT_MS = 15_000;

export function createPhaseStatuses(): PhaseStatuses {
  return { env: 'pending', engine: 'pending', gateway: 'pending', ui: 'pending' };
}

function isSettled(status: SplashPhaseStatus): boolean {
  return status === 'done' || status === 'skipped' || status === 'failed';
}

/**
 * 已完成度（0..1）。
 *
 * - 进行中的阶段只记 **45%** 权重：既让进度条动起来（不至于冷场），
 *   又不会在真的完成前骗到 100%；
 * - **全部阶段落地前封顶 0.99**：`100%` 与"窗口还没出来"同屏是最刺眼的一对。
 */
export function progressOf(statuses: PhaseStatuses): number {
  let acc = 0;
  for (const phase of SPLASH_PHASES) {
    const status = statuses[phase.id];
    if (isSettled(status)) acc += phase.weight;
    else if (status === 'active') acc += phase.weight * 0.45;
  }
  if (!SPLASH_PHASES.every((phase) => isSettled(statuses[phase.id]))) {
    return Math.min(0.99, Math.round(acc * 100) / 100);
  }
  return 1;
}

/** 当前正在做的事：第一个 `active` 阶段；没有就取第一个 `pending`。 */
export function currentPhase(statuses: PhaseStatuses): SplashPhaseDef | null {
  for (const phase of SPLASH_PHASES) {
    if (statuses[phase.id] === 'active') return phase;
  }
  for (const phase of SPLASH_PHASES) {
    if (statuses[phase.id] === 'pending') return phase;
  }
  return null;
}

/** 慢启动提示。三档就够：正常 / 偏慢 / 很慢。 */
export function slowHint(elapsedMs: number): string {
  if (elapsedMs >= VERY_SLOW_HINT_MS) {
    return '启动时间超出预期。可以继续等待，也可以先进入应用（引擎稍后能在设置里重启）。';
  }
  if (elapsedMs >= SLOW_HINT_MS) {
    return '首次启动需要初始化引擎，通常 10 秒内完成。';
  }
  return '';
}

/**
 * 把引擎侧的原始报错翻译成「用户能读懂 + 能行动」的两句话。
 *
 * ⚠️ 判据用**小写子串**而不是错误码枚举：这条链路上的报错来自三层
 * （Electron spawn / Windows 套接字 / Python 引擎日志），没有统一的错误类型；
 * 硬做结构化只会在真正的失败场景里漏判，然后退化成"未知错误"。
 */
export function classifyEngineFailure(detail: string): SplashFailure {
  const text = detail.toLowerCase();
  if (text.includes('10048') || text.includes('eaddrinuse') || text.includes('address already in use')) {
    return {
      kind: 'port-conflict',
      title: '网关端口被占用',
      advice: '可能有另一个 NanoWork 或残留的引擎进程。点「重试」会自动换一个可用端口。',
      detail,
    };
  }
  if (
    text.includes('enoent') ||
    text.includes('未安装') ||
    text.includes('not found') ||
    text.includes('cannot find')
  ) {
    return {
      kind: 'engine-missing',
      title: '没有找到引擎程序',
      advice: '引擎可能还没安装或安装不完整。先进入应用，在「设置 → 引擎」里一键安装/修复。',
      detail,
    };
  }
  if (text.includes('timeout') || text.includes('超时') || text.includes('未进入监听')) {
    return {
      kind: 'engine-timeout',
      title: '引擎启动超时',
      advice: '首次启动或引擎自检较慢时会出现。可以重试一次，或先进入应用稍后再重启引擎。',
      detail,
    };
  }
  return {
    kind: 'unknown',
    title: '引擎启动失败',
    advice: '可以重试一次；若反复失败，先进入应用并在「设置 → 诊断」里查看引擎日志。',
    detail,
  };
}

/** 渲染层（界面）加载失败：与引擎无关，是产物/加载路径的问题 */
export function classifyRendererFailure(detail: string): SplashFailure {
  return {
    kind: 'renderer-load',
    title: '界面加载失败',
    advice: '应用文件可能不完整。先进入应用试试刷新，仍失败请重新安装。',
    detail,
  };
}

/** 组装一份可直接 `send` 给渲染进程的视图（必须保持纯数据，不能带函数） */export function buildView(input: BuildViewInput): SplashView {
  const { theme, version, statuses, elapsedMs, detail } = input;
  const error = input.error ?? null;
  const phases: SplashPhaseRow[] = SPLASH_PHASES.map((phase) => ({
    id: phase.id,
    label: phase.label,
    status: statuses[phase.id],
  }));

  if (error) {
    return {
      theme,
      version,
      title: '启动未完成',
      message: error.title,
      hint: error.advice,
      progress: progressOf(statuses),
      phases,
      error,
      autoEnterInSec: input.autoEnterInSec ?? null,
    };
  }

  const phase = currentPhase(statuses);
  const suffix = detail ? ` · ${detail}` : '';
  const message = phase ? `${phase.label}…${suffix}` : '即将就绪';
  // 四步全绿之后不该再解释"为什么慢" —— 一句"首次启动需要初始化引擎"停在四个勾下面
  // 是自相矛盾的（用户已经进来了，还在被解释等待）
  const allSettled = SPLASH_PHASES.every((item) => isSettled(statuses[item.id]));

  return {
    theme,
    version,
    title: '正在启动',
    message,
    hint: allSettled ? '' : slowHint(elapsedMs),
    progress: progressOf(statuses),
    phases,
    error: null,
    autoEnterInSec: null,
  };
}

/**
 * 是否启用启动屏。
 *
 * 放一个开关是**排障刚需**：无边框窗口在少数远程桌面 / 虚拟显卡环境下会画不出来
 * （表现为"启动后什么都没有"），而那时用户连设置页都进不去。设 `NANOWORK_SKIP_SPLASH=1`
 * 即可回到"窗口直接显示"的旧行为 —— 只补一句：关掉它等于关掉门禁，窗口立刻显示。
 */
export function isSplashEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NANOWORK_SKIP_SPLASH !== '1' && env.NANOWORK_SKIP_SPLASH !== 'true';
}
