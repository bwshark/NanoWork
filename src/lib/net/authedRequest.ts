/**
 * 带票请求的唯一实现（知识库 / 项目空间 / 以后的组织级资源共用）。
 *
 * ## 为什么必须共用，而不是各自复制
 *
 * 这一段代码里有三条**只有一处能对**的约定：
 *
 * 1. **票要实时取**（`getToken` 优先于 `token` 快照）。access token 30 分钟就过期，
 *    把票拷进配置对象等于把「半小时后必然 401」写进页面。
 * 2. **401 只换票重放一次**。重放前必须重新取票（刷新后新票在 account 里，配置上的
 *    快照还是旧的）；刷新后仍 401 说明是「凭据整体失效」，再试只会把无效凭据反复打上去。
 * 3. **网络层失败不给 status**（返回 `status: 0`），否则界面会把「连不上」说成「500」。
 *
 * 复制一份到第二个客户端，就会有两份 401 行为：token 轮换出问题时典型症状是
 * 「知识库页正常、项目页停在未登录」，而两边日志都干净 —— 这类问题几乎无法现场排查。
 *
 * ## 刷新必须单飞，责任在调用方
 *
 * 服务端的 `/api/auth/refresh` 是**轮换 + 重用检测**制：旧 refresh 换掉后同一张再用
 * 第二次会被判重放、整链吊销。本层的并发请求会同时收到 401，所以 `refreshToken`
 * 的实现**必须自带在途合并**（生产传 `syncAccount.refresh()`）。
 */

export interface AuthedRequestConfig {
  /** 云端根地址（`resolveSyncBaseUrl()` 的产物），尾部斜杠会被去掉 */
  baseUrl: string;
  /** 当前 access token 的**静态快照**；`null` 表示未登录。有 `getToken` 时以它为准 */
  token: string | null;
  /** 实时取 token（优先于 `token`）。见文件头第 1 条 */
  getToken?: () => string | null;
  /** 收到 401 时换票；`true` = 可以重放一次。实现方必须单飞。 */
  refreshToken?: () => Promise<boolean>;
  /** 注入 fetch（用例用桩；运行时不传即全局 fetch） */
  fetchImpl?: typeof fetch;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; unauthorized: boolean };

export interface AuthedRequestInit {
  method?: string;
  body?: unknown;
  /** `blob` 用于图片 / PDF 这类二进制（`<img src>` 带不上 Authorization 头） */
  parse?: 'json' | 'blob';
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * 取这次请求该用的票。
 *
 * `getToken` 存在时**只信它**（哪怕它回 `null`）：`token` 是快照，快照过期后继续拿它
 * 去请求，就会得到一串「明知道会 401 的请求」。
 */
export function currentToken(config: AuthedRequestConfig): string | null {
  if (config.getToken) return config.getToken();
  return config.token;
}

async function readDetail(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;
  } catch {
    // 非 JSON 错误体（网关 502 页面等）：交给调用方显示状态码
  }
  return null;
}

export async function authedRequest<T>(
  config: AuthedRequestConfig,
  path: string,
  init: AuthedRequestInit = {},
): Promise<ApiResult<T>> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseHeaders: Record<string, string> = {};
  if (init.body !== undefined) baseHeaders['Content-Type'] = 'application/json';
  const url = `${normalizeBaseUrl(config.baseUrl)}${path}`;

  const send = (token: string | null): Promise<Response> =>
    fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: token ? { ...baseHeaders, Authorization: `Bearer ${token}` } : baseHeaders,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  let response: Response;
  try {
    response = await send(currentToken(config));
    if (response.status === 401 && config.refreshToken) {
      // 刷新抛错与返回 false 等价（都是「拿不到新票」）：不能落进下面的 catch，
      // 否则会把「票过期」误报成「无法连接云端服务」
      const refreshed = await config.refreshToken().catch(() => false);
      if (refreshed) response = await send(currentToken(config));
    }
  } catch {
    // 文案带上**实际请求的地址**：同一个界面可能连本机 / 联调 / 正式三台，
    // 不写地址时「连不上」只能靠猜是哪一台没起。
    return {
      ok: false,
      status: 0,
      message: `无法连接云端服务（${normalizeBaseUrl(config.baseUrl)}）`,
      unauthorized: false,
    };
  }

  if (!response.ok) {
    const detail = await readDetail(response);
    return {
      ok: false,
      status: response.status,
      message: detail ?? `请求失败（${response.status}）`,
      unauthorized: response.status === 401,
    };
  }
  // 204 是「删成功、没有响应体」：不能去 parse json，否则变成「响应格式异常」
  if (response.status === 204) return { ok: true, data: undefined as T };
  try {
    if (init.parse === 'blob') return { ok: true, data: (await response.blob()) as T };
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, status: response.status, message: '响应格式异常', unauthorized: false };
  }
}
