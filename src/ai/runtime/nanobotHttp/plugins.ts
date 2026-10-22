/**
 * nanobot **插件域**：`/v1/plugins` 的读与启停。
 *
 * ## 为什么是 HTTP 而不是 IPC
 *
 * 「装了什么包」是文件系统事实（主进程扫 `~/.nanowork/plugins`），
 * 但「**激活没有**」是引擎事实：激活标记与包内容**指纹绑定**，换了包内容
 * 标记就失效。客户端既不复刻那套哈希、也不存自己的副本——只在这里问一次。
 * 两份真相不一致时无法裁决谁对，只会变成「界面说启用了、模型不认」。
 *
 * ## 与 platform 层的分工
 *
 * 文件系统那半（扫 / 装 / 卸）走 `platform.*`，本模块只管引擎侧。
 * 因此本文件**不 import platform**：它只需要 endpoint 与鉴权头，
 * 由 transport 层（`NanobotClient`）注入——沿用 `chat.ts` 已有的
 * endpoint 解析（含开发态代理改写），不在这里再实现一遍。
 *
 * ## 绝不抛异常（读侧）
 *
 * 「问不到引擎」是**常态**：用户可能根本没开网关。所以 `readPluginIndex`
 * 把任何失败收敛成 `{ available: false, error }`；抛出去只会让插件页
 * 整体崩掉，而用户其实只是想看一眼装了什么。
 */

import type { PluginEngineEntry, PluginEngineIndex, PluginHookStats } from '@/types/plugin';
import { isAbortError } from './httpError';

/** 单次插件请求的连接参数（由 transport 层解析后传入） */
export interface PluginRequestContext {
  /** 已归一化的 `/v1` 前缀地址 */
  endpoint: string;
  /** 鉴权头（`Authorization: Bearer ...`，token 为空时为空对象） */
  headers: Record<string, string>;
  /** 超时（毫秒）；缺省 6000——这是本地网关，慢到这个量级基本就是没起 */
  timeoutMs?: number;
}

const DEFAULT_PLUGIN_TIMEOUT_MS = 6000;

/** 把未知值收敛成字符串字段（引擎漏字段时不至于渲染出 `undefined`） */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 非负整数；`NaN` / 负数 / 小数 / 字符串一律归 0（计数类字段不接受猜测） */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * 解析引擎报的生命周期钩子生效情况（FR-3.6）。
 *
 * 缺字段一律归 0，**不从「磁盘上有 hooks 文件」推断**：引擎说不上来时，
 * 界面就该显示「未生效」，而不是替它猜一个「已生效」。
 */
function hookStats(value: unknown): PluginHookStats {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const events: Record<string, number> = {};
  const rawEvents =
    raw.events && typeof raw.events === 'object' && !Array.isArray(raw.events)
      ? (raw.events as Record<string, unknown>)
      : {};
  for (const [event, n] of Object.entries(rawEvents)) {
    const parsed = count(n);
    if (parsed > 0) events[event] = parsed;
  }
  return { active: count(raw.active), events, dropped: count(raw.dropped) };
}

/**
 * 解析 `GET /v1/plugins` 的响应体。
 *
 * 只认 `data: [...]` 形态（OpenAI 风格的 list 包装，与路由实现一致）。
 * 每条的字段缺失一律降级成空串 / false，**不猜测**——猜测会把
 * 「引擎没给」变成「引擎给了个错的」。
 */
export function parsePluginIndex(payload: unknown): PluginEngineEntry[] {
  const data =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(data)) return [];

  return data
    .filter((item): item is Record<string, unknown> => {
      return Boolean(item) && typeof item === 'object' && !Array.isArray(item);
    })
    .map((item) => ({
      name: text(item.name),
      displayName: text(item.displayName) || text(item.name),
      description: text(item.description),
      category: text(item.category),
      enabled: item.enabled === true,
      mcpServers: Array.isArray(item.mcpServers)
        ? item.mcpServers.filter((s): s is string => typeof s === 'string')
        : [],
      // 空串 = 引擎说不上来 → 归一成 null，界面据此走「本地安装」的文案，
      // 而不是渲染一个空 market 后缀
      market: text(item.market) || null,
      version: text(item.version) || null,
      hooks: hookStats(item.hooks),
    }))
    .filter((entry) => entry.name !== '');
}

/**
 * 读引擎侧插件索引。**不抛异常**：失败 → `available: false` + 原因。
 *
 * 超时用 `AbortController`：网关没起时 fetch 会一直挂着，
 * 插件页就会卡在「加载中」而不是给出结论。
 */
export async function readPluginIndex(
  ctx: PluginRequestContext,
): Promise<PluginEngineIndex> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    ctx.timeoutMs ?? DEFAULT_PLUGIN_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${ctx.endpoint}/plugins`, {
      headers: ctx.headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { available: false, entries: [], error: `读取插件清单失败：HTTP ${res.status}` };
    }
    return { available: true, entries: parsePluginIndex(await res.json()) };
  } catch (err) {
    return {
      available: false,
      entries: [],
      error: isAbortError(err)
        ? '读取插件清单超时（网关未启动？）'
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 启停结果：与 platform 的 `PluginActionResult` 同形，避免在契约层再引一层依赖 */
export interface PluginToggleOutcome {
  ok: boolean;
  error?: string;
}

/**
 * 切插件启停。**同样不抛异常**（与读侧一致）：调用方拿到 `ok=false`
 * 后既要把 UI 回滚，也要在页面上显示原因——静默失败会让用户以为已经生效。
 *
 * 409 单独解释：引擎拒绝签发激活标记（包在启用过程中被改动过），
 * 这不是「服务端故障」，而是「你手上的包和刚才那份不是同一份」，用户可自解。
 */
export async function setPluginEnabledInEngine(
  ctx: PluginRequestContext,
  name: string,
  enabled: boolean,
): Promise<PluginToggleOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    ctx.timeoutMs ?? DEFAULT_PLUGIN_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${ctx.endpoint}/plugins/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ctx.headers },
      body: JSON.stringify({ action: enabled ? 'enable' : 'disable' }),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 409) {
      return { ok: false, error: '插件包内容已变更，请重新扫描后再启用' };
    }
    if (res.status === 404) {
      return { ok: false, error: `引擎未找到插件「${name}」` };
    }
    return { ok: false, error: `切换插件状态失败：HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      error:
        isAbortError(err)
          ? '切换插件状态超时（网关未启动？）'
          : err instanceof Error
            ? err.message
            : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
