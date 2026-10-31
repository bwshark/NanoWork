/**
 * 内置模型目录的云端客户端（**纯函数**：baseUrl / token / fetch 全部注入）。
 *
 * 与 `lib/kb/kbClient.ts` 同款三条约定，理由也相同：
 * 1. 不读全局状态 —— 用例直接传桩，不需要 mock 整个同步运行时；
 * 2. 不抛异常 —— 云端是可选能力（未登录 / 断网时应用要照常可用）；
 * 3. 401 换票后**重放一次**。access token 只有 30 分钟寿命，把票拷进配置快照
 *    等于写死「半小时后必然 401」；而「刷新后仍 401」不是票过期，是凭据整体失效，
 *    继续重试只会把无效凭据反复打上去。
 */

import { parseBuiltinModels, type BuiltinModel } from './builtinModels';

export interface BuiltinModelsClientConfig {
  /** 云端根地址（`resolveSyncBaseUrl()` 的产物），尾部斜杠会被去掉 */
  baseUrl: string;
  /** 当前 access token 的静态快照；`null` = 未登录。有 `getToken` 时以它为准 */
  token: string | null;
  /** 实时取票（配置对象是挂载时建一次，票却会轮换） */
  getToken?: () => string | null;
  /** 401 时换票；实现方**必须自己单飞**（服务端是轮换 + 重用检测） */
  refreshToken?: () => Promise<boolean>;
  /** 注入 fetch（用例用桩；运行时不传即全局 fetch） */
  fetchImpl?: typeof fetch;
}

export type BuiltinModelsResult =
  | { ok: true; models: BuiltinModel[] }
  | { ok: false; status: number; message: string; unauthorized: boolean };

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function currentToken(config: BuiltinModelsClientConfig): string | null {
  // `getToken` 优先：它每次返回**此刻**有效的票，而 `token` 只是建配置时的快照
  return config.getToken ? config.getToken() : config.token;
}

/** 拉取内置模型目录。 */
export async function fetchBuiltinModels(
  config: BuiltinModelsClientConfig,
): Promise<BuiltinModelsResult> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${normalizeBaseUrl(config.baseUrl)}/api/models/builtin`;

  const send = (token: string | null): Promise<Response> =>
    fetchImpl(url, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  const token = currentToken(config);
  if (!token) {
    // 未登录**不发请求**：带上空 token 只会得到 401，而 401 会被上层翻译成
    // 「登录已过期」，与「本来就没登录」是两句话。
    return { ok: false, status: 401, message: '未登录账户', unauthorized: true };
  }

  let response: Response;
  try {
    response = await send(token);
    if (response.status === 401 && config.refreshToken) {
      // 刷新抛错与返回 false 等价（都是「拿不到新票」），不能让它落进下面的 catch
      const refreshed = await config.refreshToken().catch(() => false);
      if (refreshed) response = await send(currentToken(config));
    }
  } catch {
    return {
      ok: false,
      status: 0,
      message: `无法连接云端服务（${normalizeBaseUrl(config.baseUrl)}）`,
      unauthorized: false,
    };
  }

  if (response.status === 401) {
    return { ok: false, status: 401, message: '登录已过期，请重新登录', unauthorized: true };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: `云端返回 ${response.status}`,
      unauthorized: false,
    };
  }

  try {
    const body: unknown = await response.json();
    return { ok: true, models: parseBuiltinModels(body) };
  } catch {
    // 解析失败不要当成「没有内置模型」：那会让上层以为云端确实没配，
    // 于是把本机已有的条目从「内置」组里摘掉（选择器里它们会突然变成自定义）。
    return { ok: false, status: response.status, message: '云端响应格式非法', unauthorized: false };
  }
}
