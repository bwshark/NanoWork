/**
 * 启动性能剖析器（FR-11.6）。
 *
 * **要解决什么**：`main.ts` 里那句注释写着「实测 `nanobot serve` 从 spawn 到 listen
 * 约 9.4 秒」，但**从不落任何日志** —— 于是「这 9.4 秒花在哪」只能靠猜，而
 * FR-13.5（首屏治理）与预热池都必须基于分段数据才能判断收益来自哪一处。
 *
 * ## 两个原则（照 WorkBuddy `startup-profile.cjs` 的设计，但它只给了原则）
 *
 * 1. **默认零 I/O**：只有显式开关（`NANOWORK_STARTUP_PROFILE=1`）才产出数据。
 *    采集器本身在关闭态是**纯空转**：不建定时器、不开文件、不触碰磁盘。
 * 2. **独立于业务模块图**：本模块**不 import 任何东西** —— 不引 store / config /
 *    logger / electron。理由不是洁癖：剖析器若依赖 `logStore`，那它测出来的
 *    「启动耗时」里就包含了它自己引入的模块加载成本，且一旦 logger 初始化失败，
 *    剖析器会跟着崩 —— 观测手段把被观测对象搞坏是最坏的耦合。
 *
 * ## 为什么落点是「区间并集」而不是「各段相加」
 *
 * serve 与 gateway 是 `Promise.all` **并行**拉起的，窗口创建也与之重叠。
 * 各段相加会得到「总耗时 15 秒」这种不存在的数字（真实墙钟只有 9.4 秒），
 * 而人看到 15 秒会去优化一个不存在的瓶颈。故 `unionMs` 按**区间并集**算。
 *
 * ## 边界（如实说明）
 *
 * 本模块只负责「记录 + 归并 + 交给 sink」，**不负责落盘**：写哪个文件由
 * `main.ts` 注入（那里才知道 userData 在哪，且必须等 `whenReady` 之后）。
 * 这样模块本身可被 jsdom 单测直接跑，不必启 Electron。
 */

/** 打开剖析器的环境变量。值为 `1` / `true` 才算开 —— 其余（含 `0` / 空串）一律关。 */
export const STARTUP_PROFILE_ENV = 'NANOWORK_STARTUP_PROFILE';

/** 一段已闭合的时间区间。 */
export interface StartupSpan {
  name: string;
  startedAtMs: number;
  endedAtMs: number;
}

/** 一次采样的完整结果。 */
export interface StartupReport {
  pid: number;
  /** 采集器创建时刻（≈ 进程加载本模块的时刻），是所有区间的公共原点 */
  startedAtMs: number;
  endedAtMs: number;
  /** 墙钟：`endedAtMs - startedAtMs` */
  durationMs: number;
  /** 区间并集：并行阶段只算一次（见模块 docstring） */
  unionMs: number;
  spans: StartupSpan[];
  /** 调用方补充的上下文（版本号等）。采集器自己不去问 `app`，否则又要依赖 electron */
  extras: Record<string, unknown>;
}

export interface StartupProfilerOptions {
  enabled: boolean;
  /** 仅在 `flush()` 且 `enabled` 为真时被调用 */
  sink?: (report: StartupReport) => void;
  /** 注入时钟（测试用） */
  now?: () => number;
  pid?: number;
  /** 报告时刻才求值 —— 可安全地读 `app.getVersion()` 这类「须等 ready」的值 */
  extras?: () => Record<string, unknown>;
  startedAtMs?: number;
}

export interface StartupProfiler {
  readonly enabled: boolean;
  /** 开一段。同名重复 begin 以**最后一次**为准（重入不叠加） */
  begin(name: string): void;
  /** 闭一段。未 begin 过的名字**静默忽略** —— 剖析器不该因为埋点写错而出错 */
  end(name: string): void;
  /** 直接记一段已知区间（如「引擎日志里读到的首 token」这种外部来源） */
  span(name: string, startedAtMs: number, endedAtMs: number): void;
  report(): StartupReport;
  /** 关闭态是 no-op；开启态把报告交给 sink。**只在启动链路走完后调一次** */
  flush(): void;
}

/**
 * 区间并集（毫秒）。
 *
 * 负区间（`end < start`，时钟回拨或埋点写反）按 0 长度计，**不参与并集** ——
 * 让它参与会得到一个比墙钟还大的数字，反而掩盖真实问题。
 */
export function unionDurationMs(spans: readonly StartupSpan[]): number {
  // ⚠️ 顺序要紧：**先按原始值过滤，再归一化**。写成「先 min/max 再过滤」会让
  // 断言恒真（归一化后必然 `end > start`），于是反向区间被悄悄收进并集 ——
  // 那正是这条过滤要拦的东西。
  const ranges = spans
    .filter((s) => s.endedAtMs > s.startedAtMs)
    .map((s) => [s.startedAtMs, s.endedAtMs] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor: number | null = null;
  let cursorEnd = 0;
  for (const [start, end] of ranges) {
    if (cursor === null) {
      cursor = start;
      cursorEnd = end;
      continue;
    }
    if (start <= cursorEnd) {
      // 与当前段重叠（或首尾相接）：合并，取更远的右端
      cursorEnd = Math.max(cursorEnd, end);
      continue;
    }
    total += cursorEnd - cursor;
    cursor = start;
    cursorEnd = end;
  }
  if (cursor !== null) total += cursorEnd - cursor;
  return total;
}

/** 环境变量判定。刻意只认 `1` / `true`：写错的取值应当表现为「没开」，而不是「莫名开了」。 */
export function isStartupProfileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[STARTUP_PROFILE_ENV];
  return value === '1' || value === 'true';
}

/** 关闭态用的实现：全 no-op，连数组都不分配。 */
export function createNoopProfiler(): StartupProfiler {
  const empty: StartupReport = {
    pid: 0,
    startedAtMs: 0,
    endedAtMs: 0,
    durationMs: 0,
    unionMs: 0,
    spans: [],
    extras: {},
  };
  return {
    enabled: false,
    begin: () => {},
    end: () => {},
    span: () => {},
    report: () => empty,
    flush: () => {},
  };
}

export function createStartupProfiler(options: StartupProfilerOptions): StartupProfiler {
  const { enabled, sink } = options;
  // 关闭态直接退化：调用点不必到处写 `if (profiler.enabled)`，埋点代码保持单行。
  if (!enabled) return createNoopProfiler();

  const now = options.now ?? (() => Date.now());
  const pid = options.pid ?? 0;
  const extras = options.extras ?? (() => ({}));
  const startedAtMs = options.startedAtMs ?? now();
  const open = new Map<string, number>();
  const closed: StartupSpan[] = [];

  const report = (): StartupReport => {
    const endedAtMs = now();
    const spans = closed.slice();
    // 还没 end 的区间按「记到此刻」收口：进程被杀时 flush 不会被执行，
    // 但真机重跑往往能看到这一类半截区间，比直接丢掉有信息量。
    for (const [name, start] of open) {
      spans.push({ name, startedAtMs: start, endedAtMs });
    }
    return {
      pid,
      startedAtMs,
      endedAtMs,
      durationMs: endedAtMs - startedAtMs,
      unionMs: unionDurationMs(spans),
      spans,
      extras: extras(),
    };
  };

  return {
    enabled: true,
    begin: (name) => {
      open.set(name, now());
    },
    end: (name) => {
      const start = open.get(name);
      if (start === undefined) return; // 未 begin：静默（埋点写错不该让主进程报错）
      open.delete(name);
      const end = now();
      closed.push({ name, startedAtMs: start, endedAtMs: end });
    },
    span: (name, start, end) => {
      closed.push({ name, startedAtMs: start, endedAtMs: end });
    },
    report,
    flush: () => {
      if (sink) sink(report());
    },
  };
}
