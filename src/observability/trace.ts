/**
 * 全链路 trace（FR-11.2）——**纯逻辑**：把「一个回合的事件」折成一份可落盘的
 * trace 文件。落点在 `<userData>/traces/<pid>/<traceId>.json`，**形状对齐
 * WorkBuddy**（同一台机器上有实物可比，见下）。
 *
 * ## 为什么由事件流派生，而不是另起一套埋点
 *
 * WorkBuddy 的 `function_call` 事件里带 `traceId` / `requestModelId` / `agent`
 * ——可观测性不需要额外埋点，因为 **trace 信息本来就随事件走**。本项目的事件流
 * （`@/types/event`）同样带 `provider` 与逐事件的 `timestamp`，所以一份 trace
 * 只是「把已经落盘的事实换个形状再写一遍」，不需要在业务代码里撒埋点。
 * 这条是本模块存在的全部理由：**零侵入**。
 *
 * ## 与 WorkBuddy 的对照（实测其 `~/.workbuddy/traces/<pid>/<traceId>.json`）
 *
 * 外层 `{ trace, spans }`，`trace` 的键是
 * `traceId / name / workerPid / workerHostname / startedAt / endedAt / duration /
 *  status / spanCount / totalTokens / metadata`（另有可选的 `sessionId` /
 * `agentName` / `modelInfo`）；每个 span 的键是
 * `traceId / spanId / parentId / name / type / startedAt / endedAt / duration /
 *  status / error`，外加可选的 `toolName / toolInput / toolOutput / agentName`。
 * 其 span `type` 取 `agent`（工作流）/ `generation`（模型调用）/ `function`
 * （工具调用）/ `custom`（其余）。本模块逐字沿用这套键名与取值域——读得懂
 * WorkBuddy trace 的工具应当也读得懂我们的。
 *
 * ## 两处**刻意**的差异（不是没对齐，是想清楚了不对齐）
 *
 * 1. **`workerPid` / `workerHostname` 不在渲染层填**。渲染层不知道自己的 pid
 *    （Electron 里它是渲染进程的，不是写文件那个进程的），硬填一个近似值等于
 *    在诊断数据里写假话。故这两个字段在**写盘时**由主进程用 `stampTraceOrigin`
 *    补上——文件里永远是「真正写它的那个进程」。
 * 2. **不落用户提问正文**。WorkBuddy 的 trace 里有 `prompt`，但诊断包是会被
 *    用户发出去的，提问正文隐私权重高、排障价值低；工具参数与结果相反（「哪一步
 *    失败、参数是什么」是排障的全部），保留并**截断**。只记 `metadata.promptChars`。
 */

import type { SessionEvent } from '@/types/event';

/** span 类型（取值域对齐 WorkBuddy） */
export type TraceSpanType = 'agent' | 'generation' | 'function' | 'custom';

export type TraceStatus = 'ok' | 'error';

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  type: TraceSpanType;
  startedAt: string;
  endedAt: string;
  duration: number;
  status: TraceStatus;
  error: string | null;
  /** 工具名（`function` / `custom` 类 span 才有） */
  toolName?: string;
  /** 工具入参（JSON 字符串，已截断） */
  toolInput?: string;
  /** 工具结果（已截断） */
  toolOutput?: string;
  agentName?: string;
}

export interface TraceEnvelope {
  traceId: string;
  name: string;
  /** 写盘进程的 pid；渲染层填 0，由主进程在落盘时补齐 */
  workerPid: number;
  /** 写盘机器的主机名；同上 */
  workerHostname: string;
  startedAt: string;
  endedAt: string;
  duration: number;
  status: TraceStatus;
  spanCount: number;
  /** 本回合累计 token；引擎未上报 usage 事件时为 0（不编数字） */
  totalTokens: number;
  metadata: Record<string, unknown>;
  sessionId: string;
  agentName?: string;
  modelInfo?: { models: string[] };
}

export interface TraceFile {
  trace: TraceEnvelope;
  spans: TraceSpan[];
}

/** trace 目录名（`<userData>/traces`） */
export const TRACE_DIR_NAME = 'traces';

/** 默认保留天数（trace 比日志大得多，留得短） */
export const DEFAULT_TRACE_KEEP_DAYS = 7;

/** 单个工具入参 / 结果的截断长度——trace 是「够用就停」的诊断件，不是全文备份 */
export const TRACE_FIELD_MAX_CHARS = 4000;

/**
 * 抽 `len` 位小写十六进制（traceId 32 位、spanId 24 位，对齐 WorkBuddy 观感）。
 *
 * ⚠️ 这里**刻意不 import `@/lib/id`**：本模块要能被主进程（esbuild `--format=cjs`、
 * 无 `@` 别名）以**值**的形式引入。esbuild 只擦得掉 `import type`，值引入会让
 * `main.cjs` 直接构建不出来（同 `src/sync/baseUrl.ts` 的注释所述）。
 */
function randomHex(len: number): string {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') {
      // uuid 剥掉连字符正好 32 位，够 traceId 用
      const raw = c.randomUUID().replace(/-/g, '');
      return raw.slice(0, len);
    }
  } catch {
    /* 落到下面的兜底 */
  }
  let out = '';
  while (out.length < len) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, len);
}

/** `trace_<32hex>` */
export function newTraceId(): string {
  return `trace_${randomHex(32)}`;
}

/** `span_<24hex>` */
export function newSpanId(): string {
  return `span_${randomHex(24)}`;
}

/**
 * 合法 traceId。
 *
 * 它是**文件名**的一部分（`<traceId>.json`），所以校验必须在这里收口：主进程
 * 落盘前拿它挡一次，渲染层也就没有「编一个能写出目录外的名字」的机会。
 */
export function isValidTraceId(value: unknown): boolean {
  return typeof value === 'string' && /^trace_[0-9a-z]{8,64}$/.test(value);
}

function truncate(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= TRACE_FIELD_MAX_CHARS) return text;
  return `${text.slice(0, TRACE_FIELD_MAX_CHARS)}…（已截断，共 ${text.length} 字符）`;
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return truncate(String(value));
  }
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

export interface BuildTraceOptions {
  sessionId: string;
  /** 会话绑定的 Agent id；事件里有 `provider.agent` 时优先用后者 */
  agentId?: string;
  /** 预分配的 traceId（测试用；缺省现生成） */
  traceId?: string;
  /** span id 工厂（测试用） */
  spanIdFactory?: () => string;
}

/**
 * 把一个回合的事件折成 trace。
 *
 * @param events 该回合**全部**事件（含收尾的 `session-end`），顺序不限——内部按
 *   `seq` 排序。空数组会产出一份「零跨度」的 trace 而不是抛错：调用方（回合收尾
 *   路径）不该因为可观测性失败而中断。
 */
export function buildTurnTrace(
  events: readonly SessionEvent[],
  opts: BuildTraceOptions,
): TraceFile {
  const traceId = opts.traceId ?? newTraceId();
  const nextSpanId = opts.spanIdFactory ?? newSpanId;

  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const startedMs = first?.timestamp ?? Date.now();
  const endedMs = last?.timestamp ?? startedMs;

  /** 回合结果：`session-end` 是唯一权威（错误 / 中断走它，见 sessionsStore 收尾） */
  const sessionEnd = [...ordered].reverse().find((e) => e.type === 'session-end');
  const reason = sessionEnd?.type === 'session-end' ? sessionEnd.reason : undefined;
  const hasErrorEvent = ordered.some((e) => e.type === 'error');
  /**
   * `aborted` 判 **ok**：那是用户主动停的，不是一个「坏掉的请求」。把它记成
   * error 会让 trace 的失败率被用户的正常操作污染，之后没法拿它做告警基线
   * ——原因仍记在 `metadata.reason` 里，没有丢失。
   */
  const status: TraceStatus =
    reason === 'error' || reason === 'interrupted' || hasErrorEvent ? 'error' : 'ok';

  const rootSpanId = nextSpanId();

  const agentName =
    ordered.find((e) => e.provider?.agent)?.provider?.agent || opts.agentId || undefined;

  const models = [
    ...new Set(
      ordered
        .map((e) => e.provider?.model)
        .filter((m): m is string => typeof m === 'string' && m.length > 0),
    ),
  ];

  const assistant = ordered.find((e) => e.type === 'message' && e.role === 'assistant');
  const prompt = ordered.find((e) => e.type === 'message' && e.role === 'user');

  const spans: TraceSpan[] = [];

  // —— 根 span：整个回合 ——
  const rootSpan: TraceSpan = {
    traceId,
    spanId: rootSpanId,
    parentId: null,
    name: agentName ?? 'Agent workflow',
    type: 'agent',
    startedAt: iso(startedMs),
    endedAt: iso(endedMs),
    duration: Math.max(0, endedMs - startedMs),
    status,
    error: status === 'error' ? describeReason(reason, hasErrorEvent) : null,
    ...(agentName ? { agentName } : {}),
  };
  spans.push(rootSpan);

  /**
   * 生成窗口。
   *
   * 引擎一次回合可能对模型发起**多次**调用（工具执行后再问一轮），但事件流里
   * 没有「第 N 次调用」的边界——只有 `reasoning` 与 `function-call` 的交替。
   * 与其按启发式切出若干个可能切错的 generation 段，不如如实记成**一个**生成
   * 窗口：`[助手消息占位时刻, 助手消息落盘时刻]`。助手消息事件在回合结束时才写
   * （正文是流式累积的），`createdAt` 就是它的占位时刻。
   */
  if (assistant && assistant.type === 'message') {
    const genStart = assistant.createdAt ? Date.parse(assistant.createdAt) : startedMs;
    const genEnd = assistant.timestamp;
    spans.push({
      traceId,
      spanId: nextSpanId(),
      parentId: rootSpanId,
      name: 'generation',
      type: 'generation',
      startedAt: iso(Number.isNaN(genStart) ? startedMs : genStart),
      endedAt: iso(genEnd),
      duration: Math.max(0, genEnd - (Number.isNaN(genStart) ? startedMs : genStart)),
      status: assistant.interrupted ? 'error' : 'ok',
      error: assistant.interrupted ? '回合未正常收尾（断流 / 超时 / 迭代上限）' : null,
    });
  }

  // —— 工具调用：`function-call` 与 `function-call-result` 按 callId 配对 ——
  const results = new Map<string, { timestamp: number; status: string; result?: string; error?: string }>();
  for (const ev of ordered) {
    if (ev.type === 'function-call-result') {
      results.set(ev.callId, {
        timestamp: ev.timestamp,
        status: ev.status,
        result: ev.result,
        error: ev.error,
      });
    }
  }
  for (const ev of ordered) {
    if (ev.type !== 'function-call') continue;
    const res = results.get(ev.callId);
    const endMs = res?.timestamp ?? ev.timestamp;
    // 没有配对结果 = 这一步的结果根本没回来。它与「执行失败」是两件事，
    // 但在 trace 这个只认 ok/error 的形态里只能归到 error，靠 error 文案区分。
    const failed = !res || res.status !== 'ok';
    spans.push({
      traceId,
      spanId: nextSpanId(),
      parentId: rootSpanId,
      name: ev.name,
      type: 'function',
      startedAt: iso(ev.timestamp),
      endedAt: iso(endMs),
      duration: Math.max(0, endMs - ev.timestamp),
      status: failed ? 'error' : 'ok',
      error: failed ? (res?.error ?? '结果未返回（回合被中断或超时）') : null,
      toolName: ev.name,
      toolInput: safeJson(ev.args),
      ...(res?.result !== undefined ? { toolOutput: truncate(res.result) } : {}),
    });
  }

  // —— 审批裁决：排障时「为什么这一步被拒」是高频问题，单独一类 ——
  for (const ev of ordered) {
    if (ev.type !== 'permission-decision') continue;
    spans.push({
      traceId,
      spanId: nextSpanId(),
      parentId: rootSpanId,
      name: 'permission',
      type: 'custom',
      startedAt: iso(ev.timestamp),
      endedAt: iso(ev.timestamp),
      duration: 0,
      status: ev.decision === 'approved' ? 'ok' : 'error',
      error: ev.decision === 'approved' ? null : (ev.reason ?? '被拒绝'),
      toolName: ev.tool,
      toolInput: safeJson(ev.args),
      toolOutput: ev.decision,
    });
  }

  const trace: TraceEnvelope = {
    traceId,
    name: 'Agent workflow',
    // 由主进程在落盘时补（见文件头「刻意差异 1」）
    workerPid: 0,
    workerHostname: '',
    startedAt: iso(startedMs),
    endedAt: iso(endedMs),
    duration: Math.max(0, endedMs - startedMs),
    status,
    spanCount: spans.length,
    totalTokens: 0,
    metadata: {
      ...(reason ? { reason } : {}),
      // 正文不入 trace（见文件头「刻意差异 2」），但长度留着——它解释「为什么这一轮慢」
      ...(prompt && prompt.type === 'message' ? { promptChars: prompt.content.length } : {}),
    },
    sessionId: opts.sessionId,
    ...(agentName ? { agentName } : {}),
    ...(models.length > 0 ? { modelInfo: { models } } : {}),
  };

  return { trace, spans };
}

function describeReason(reason: string | undefined, hasErrorEvent: boolean): string {
  if (reason === 'interrupted') return '回合被中断（断流 / 超时）';
  if (reason === 'error') return '回合报错';
  if (hasErrorEvent) return '回合内出现错误事件';
  return '未知错误';
}
