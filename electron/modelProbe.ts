/**
 * 模型供应商连接探针（Electron 主进程）。
 *
 * ## 为什么需要它
 *
 * 「测试连接」是用户判断一个模型能不能用的**唯一**手段，而它的结论必须诚实：
 * 探针由主进程发起（渲染层 fetch 会被 CORS 挡掉，而「跨域失败」与「key 无效」
 * 在界面上长得一模一样，降级成"看起来连上了"只会把人引到错误的方向）。
 *
 * ## 两条纪律
 *
 * 1. **绝不抛异常**。任何失败都要变成 `{ ok: false, error }`，让界面能显示原因；
 *    抛出去只会变成一个未捕获拒绝（对齐 `electron/mcpProbe.ts`）。
 * 2. **不读磁盘、不碰 config.json**。凭据由调用方（`main.ts`）解析后传入，
 *    本模块因此不 import `electron`、可被单测覆盖。
 *
 * ## 凭据的三态（`keySource`）
 *
 * 表单里填的（`request`）→ config.json 里该供应商已配置的（`config`）→ 无（`null`）。
 * 第三态是必要的：本地部署与内网网关通常不校验凭据，**不能**硬塞一个空的
 * `Authorization: Bearer `——某些网关就是按这个判 401 的。
 *
 * `keySource` 会一路回传到界面上，用来解释两件用户最容易误判的事：
 * 「我明明没填 key，为什么连上了」（用的是引擎侧已配置的密钥）与
 * 「报 401 是谁的密钥被拒了」（按来源说清该改哪个框）。**密钥内容本身绝不回传。**
 */
import type { ModelProbeResult } from '../src/platform/types';

/** 探针默认超时：内网网关 10s 足够，再久用户只会怀疑界面卡死了 */
export const DEFAULT_MODEL_PROBE_TIMEOUT_MS = 10_000;

/** 凭据来源；`null` = 一个都没有，发的是裸请求 */
export type ProbeKeySource = 'request' | 'config' | null;

/**
 * 跨 realm 安全的 AbortError 判定——**只看 `name`，不看 `instanceof`**。
 *
 * `controller.abort()` / `AbortSignal.timeout()` 抛出的是 **DOMException**，它**不是**
 * `Error` 的实例；jsdom 与 Node 又各持一份 `Error`，`instanceof` 跨 realm 恒为 false。
 * 原写法 `err instanceof Error && err.name === 'AbortError'` 因此在**真实 Electron
 * 主进程里也永远为 false**——超时被误报成「连接失败」，用户据此去查网线/防火墙/端口，
 * 全在错误的方向上（本文件文首强调过 401 与「连不上」易混淆，这是同一类问题）。
 */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * 把一次失败的 HTTP 响应翻成给人看的文案。
 *
 * **401/403 必须单独措辞**：它证明「网络通的、上游答了话」，只是不认这次请求的凭据。
 * 原样抛 `HTTP 401 Unauthorized {"error":"Unauthorized"}` 会被读成「连不上」，
 * 于是用户去查网线、防火墙、端口——全都在错误的方向上。文案里同时保留上游原文
 * （截断），不然排查时又得回去手工 curl 一遍。
 */
export function describeProbeFailure(args: {
  status: number;
  statusText: string;
  /** 上游响应体（任意长度，这里负责截断） */
  body: string;
  keySource: ProbeKeySource;
}): string {
  const detail = args.body.trim().slice(0, 200);
  if (args.status === 401 || args.status === 403) {
    const advice =
      args.keySource === 'config'
        ? '引擎侧已配置的密钥被拒，请填写或更新「API Key」'
        : args.keySource === 'request'
          ? '这次请求带的密钥被拒，请检查「API Key」是否填对'
          : '该端点不接受匿名请求，请在「API Key」里填写有效密钥';
    return `已连到上游，但它拒绝了未授权请求（HTTP ${args.status}）：${advice}${
      detail ? ` · ${detail}` : ''
    }`;
  }
  return `HTTP ${args.status} ${args.statusText} ${detail}`.trim();
}

/**
 * 真实 `GET {apiBase}/models`。
 *
 * 只认 OpenAI 兼容的 `/models`：它是这类端点唯一稳定的"你是谁、你有哪些模型"
 * 端点，而 200 + 一份模型清单也顺手给界面提供了「模型名称」的候选。
 */
export async function probeModelEndpoint(args: {
  /** 已解析好的基地址（不含尾部斜杠与否都可） */
  apiBase: string;
  /** 已解析好的密钥；空串表示发裸请求 */
  apiKey: string;
  keySource: ProbeKeySource;
  timeoutMs?: number;
}): Promise<ModelProbeResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const url = `${args.apiBase.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (args.apiKey) headers.Authorization = `Bearer ${args.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    args.timeoutMs ?? DEFAULT_MODEL_PROBE_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const text = await res.text();
    const latencyMs = elapsed();
    if (!res.ok) {
      return {
        ok: false,
        keySource: args.keySource,
        error: describeProbeFailure({
          status: res.status,
          statusText: res.statusText,
          body: text,
          keySource: args.keySource,
        }),
        latencyMs,
      };
    }
    // 上游可能返回非 JSON（登录页、反代错误页）：那不是"连上了"，如实报错
    let parsed: { data?: { id?: unknown }[] };
    try {
      parsed = JSON.parse(text) as { data?: { id?: unknown }[] };
    } catch {
      return {
        ok: false,
        keySource: args.keySource,
        error: `上游返回的不是 OpenAI 兼容的模型清单（前 120 字）：${text.trim().slice(0, 120)}`,
        latencyMs,
      };
    }
    const models = Array.isArray(parsed.data)
      ? parsed.data
          .map((item) => (typeof item?.id === 'string' ? item.id : ''))
          .filter(Boolean)
          .sort()
          .slice(0, 200)
      : [];
    return { ok: true, models, latencyMs, keySource: args.keySource };
  } catch (err) {
    const aborted = isAbortError(err);
    const ms = args.timeoutMs ?? DEFAULT_MODEL_PROBE_TIMEOUT_MS;
    return {
      ok: false,
      keySource: args.keySource,
      error: aborted
        ? // 与渲染层的超时提示同口径（默认 10s）；短于 1s 的探针（测试用）按毫秒报
          `连接超时（${ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`}）`
        : `连接失败：${err instanceof Error ? err.message : String(err)}`,
      latencyMs: elapsed(),
    };
  } finally {
    clearTimeout(timer);
  }
}
