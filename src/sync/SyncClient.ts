/**
 * 同步 HTTP 封装：`push` / `pull` + Bearer 鉴权 + 401 时刷新令牌并**仅重试一次**。
 *
 * ## 只依赖可注入的 fetch，不依赖任何 store
 *
 * 引擎要「未登录 = 零网络请求」，而这条不变量能否被测试守卫，取决于网络调用可否
 * 被替换成假实现。`fetchImpl` 因此是构造参数（缺省用全局 `fetch`）——测试注入一个
 * 计数用的替身即可断言「fetch 调用次数 = 0」，而不用真的起服务端。
 *
 * ## 401 → refresh → 仅重试一次
 *
 * access token 短命，过期时服务端回 401。策略是：先尝试刷新一次（`refreshAccessToken`），
 * 成功则**重放一次原请求**。只重试一次是刻意的：
 * - 刷新后仍 401，说明不是「access 过期」而是「凭据整体失效」（refresh 被吊销 /
 *   账户被删），继续重试只会把无效凭据反复打上去；
 * - 重试无限次 = 401 风暴，且掩盖了真正的失败原因。
 *
 * 刷新动作本身由 `SyncAccount` 提供（它才知道 refresh token 在哪、要不要轮换），
 * `SyncClient` 只负责「什么时候该调用它」。
 */

import { DEFAULT_SYNC_BASE_URL } from './types';
import type { PullResponse, PushResponse, SyncChange } from './types';

export interface SyncClientOptions {
  /** 服务端根地址（缺省 `DEFAULT_SYNC_BASE_URL`） */
  baseUrl?: string;
  /** 可注入的 fetch（测试用）；缺省用全局 `fetch` */
  fetchImpl?: typeof fetch;
  /** 取当前 access token；未登录返回 `null`（不带 Authorization 头） */
  getAccessToken: () => string | null;
  /** 刷新 access token；返回是否成功。仅在收到 401 时被调用一次 */
  refreshAccessToken?: () => Promise<boolean>;
}

/** 带 HTTP 状态码的同步错误（调用方据 `status` 区分 401 / 5xx / 其它）。 */
export class SyncHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SyncHttpError';
    this.status = status;
  }
}

export class SyncClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken: () => string | null;
  private readonly refreshAccessToken?: () => Promise<boolean>;

  constructor(options: SyncClientOptions) {
    // 去掉尾部斜杠：`baseUrl` 带不带 `/` 都应拼出同一个 URL，避免出现 `//api/...`
    this.baseUrl = (options.baseUrl ?? DEFAULT_SYNC_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.getAccessToken = options.getAccessToken;
    this.refreshAccessToken = options.refreshAccessToken;
  }

  /** 提交一批变更；返回服务端裁决结果（accepted / conflicts / cursor）。 */
  push(changes: SyncChange[]): Promise<PushResponse> {
    return this.request<PushResponse>('POST', '/api/sync/push', { changes });
  }

  /**
   * 拉取 `server_seq > since` 的全部变更。
   *
   * `since` 是**序号**（服务端 `server_seq`），不是 ISO 时间——见 `types.ts` 的说明。
   */
  pull(since: number): Promise<PullResponse> {
    const query = encodeURIComponent(String(since));
    return this.request<PullResponse>('GET', `/api/sync/pull?since=${query}`);
  }

  /**
   * 统一请求流程：发送 → 401 则尝试刷新并重放一次 → 非 2xx 抛错 → 解析 JSON。
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response = await this.send(method, path, body);

    if (response.status === 401 && this.refreshAccessToken) {
      // 刷新失败（返回 false / 抛错）都视为「没法拿到新票」，落到下面的非 2xx 分支抛错
      const refreshed = await this.refreshAccessToken().catch(() => false);
      if (refreshed) {
        response = await this.send(method, path, body);
      }
    }

    if (!response.ok) {
      throw new SyncHttpError(response.status, `${method} ${path} 失败：HTTP ${response.status}`);
    }
    if (response.status === 204) {
      // 无正文（如 logout）：调用方若期望正文会拿到 undefined，这是刻意的
      return undefined as unknown as T;
    }
    return (await response.json()) as T;
  }

  /** 发一次原始请求：拼 URL、补鉴权头、按需序列化 JSON 体。 */
  private send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = this.getAccessToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return this.fetchImpl(`${this.baseUrl}${path}`, init);
  }
}
