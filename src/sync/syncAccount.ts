/**
 * 账户态：token 的获取 / 刷新 / 登出与会话持久化。
 *
 * ## 批次 2 的存储策略（关键裁决 A / #14）
 *
 * token 落在 **`platform.storage`（② 运行时存储）**，**不是** `secretsSet` 保险库——
 * 保险库纪律是「密钥值不回传渲染层」，而同步引擎恰恰在渲染层，需要拿 access token
 * 发请求；把票据塞进保险库只会得到一条「读不回来」的死路。也**不用 httpOnly cookie**：
 * 批次 1 的服务端把票据放在响应体（未 `Set-Cookie`），客户端只能自己保管。
 *
 * 两条实现（storage / memory）共享全部逻辑，只差持久化后端：
 * - `createStorageSyncAccount`：Web 落 localStorage、Electron 落 ② userData（经适配层）；
 * - `createMemorySyncAccount`：纯内存，供单测与「不落盘」场景。
 *
 * ## 持久化格式：字符串 JSON
 *
 * `platform.storage.set(KEY, JSON.stringify(session))` + `get<string>(KEY)` 再 `JSON.parse`。
 * **不要**直接 `set(KEY, session)`——适配层契约是「写进去什么、读出来什么」，但
 * Electron 桥按**文本**传递（对象会变成 `[object Object]`），Web 侧却会多包一层
 * JSON 转义，两侧反序列化行为不一致。统一成字符串 JSON 才能两端一致。
 */

import { platform } from '@/platform';
import { DEFAULT_SYNC_BASE_URL, SYNC_ACCOUNT_STORAGE_KEY } from './types';
import type { AccountSession } from './types';

/** 账户态接口：引擎只依赖它，不直接碰网络或存储。 */
export interface SyncAccount {
  /** 是否已登录（有非空 access token） */
  isAuthenticated(): boolean;
  /** 当前 access token；未登录返回 `null` */
  getAccessToken(): string | null;
  /** 当前会话快照（副本）；未登录返回 `null` */
  getSession(): AccountSession | null;
  /** 从持久化后端载入会话（memory 变体为 no-op 式清空） */
  load(): Promise<void>;
  /** 覆盖设置会话并持久化 */
  setSession(session: AccountSession): Promise<void>;
  /** 清空会话并删除持久化 */
  clearSession(): Promise<void>;
  /** 邮箱 + 密码登录；成功后写入会话 */
  login(email: string, password: string): Promise<AccountSession>;
  /** 邮箱 + 密码注册；成功后写入会话 */
  register(email: string, password: string): Promise<AccountSession>;
  /** 用 refresh token 轮换出新的 access / refresh；成功返回 true（失败**不清会话**） */
  refresh(): Promise<boolean>;
  /** 登出：尽力通知服务端，随后清空本地会话（网络失败也清） */
  logout(): Promise<void>;
  /**
   * 彻底删除云端账户及其全部同步数据（批次 6a，数据主权 FR-10.6）。
   *
   * 成功后走**与 `logout()` 相同**的本地收口（清本地会话 + 通知订阅者）；
   * 服务端失败时**抛错且不清本地会话**（否则会出现「云端还在、本机以为删了」的最坏状态）。
   */
  deleteAccount(): Promise<void>;
  /** 订阅会话变更（登录 / 登出 / 轮换）；返回取消订阅函数 */
  subscribe(cb: (session: AccountSession | null) => void): () => void;
}

/** 带 HTTP 状态码的鉴权错误。 */
export class SyncAuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SyncAuthError';
    this.status = status;
  }
}

/** 服务端 `TokenPair` 的形状（`cloud/app/auth/routes.py`）。 */
interface TokenPairBody {
  access: string;
  refresh: string;
  user: { id: string; email: string };
}

/** 会话的持久化后端抽象（storage / memory 两种实现）。 */
interface Persistence {
  read(): Promise<AccountSession | null>;
  write(session: AccountSession): Promise<void>;
  clear(): Promise<void>;
}

/** 运行时校验：把「读回来的任意值」收窄成合法会话（脏数据一律当未登录）。 */
function isSession(value: unknown): value is AccountSession {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.userId === 'string' &&
    typeof s.email === 'string' &&
    typeof s.access === 'string' &&
    typeof s.refresh === 'string'
  );
}

/** `platform.storage` 后端（② 运行时存储，字符串 JSON）。 */
function storagePersistence(): Persistence {
  return {
    async read(): Promise<AccountSession | null> {
      const raw = await platform.storage
        .get<string>(SYNC_ACCOUNT_STORAGE_KEY)
        .catch(() => null);
      if (typeof raw !== 'string' || raw.trim() === '') return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isSession(parsed) ? parsed : null;
      } catch {
        // 坏值不该让应用崩：当作未登录，用户重新登录即可覆盖
        return null;
      }
    },
    async write(session: AccountSession): Promise<void> {
      await platform.storage.set(SYNC_ACCOUNT_STORAGE_KEY, JSON.stringify(session));
    },
    async clear(): Promise<void> {
      await platform.storage.remove(SYNC_ACCOUNT_STORAGE_KEY).catch(() => undefined);
    },
  };
}

/** 纯内存后端（单测 / 不落盘场景）。 */
function memoryPersistence(): Persistence {
  let boxed: string | null = null;
  return {
    async read(): Promise<AccountSession | null> {
      if (boxed === null) return null;
      try {
        const parsed: unknown = JSON.parse(boxed);
        return isSession(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async write(session: AccountSession): Promise<void> {
      boxed = JSON.stringify(session);
    },
    async clear(): Promise<void> {
      boxed = null;
    },
  };
}

/**
 * 两种变体共享的实现：把持久化后端注入进来，其余逻辑只写一份。
 */
function createSyncAccount(
  persistence: Persistence,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch },
): SyncAccount {
  const baseUrl = (opts.baseUrl ?? DEFAULT_SYNC_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  let session: AccountSession | null = null;
  const listeners = new Set<(session: AccountSession | null) => void>();

  const emit = (): void => {
    for (const listener of Array.from(listeners)) listener(session);
  };

  const apply = async (next: AccountSession | null): Promise<void> => {
    session = next;
    if (next) {
      await persistence.write(next);
    } else {
      await persistence.clear();
    }
    emit();
  };

  const post = (path: string, body: unknown, token?: string): Promise<Response> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  };

  const postJson = async <T>(path: string, body: unknown, token?: string): Promise<T> => {
    const response = await post(path, body, token);
    if (!response.ok) {
      throw new SyncAuthError(response.status, `${path} 失败：HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  };

  /**
   * 发一次 DELETE（无请求体）。删除是破坏性操作，**不复用 `post`**：后者恒带
   * `Content-Type` 与 JSON 体，语义不符。
   */
  const del = (path: string, token?: string): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetchImpl(`${baseUrl}${path}`, { method: 'DELETE', headers });
  };

  const toSession = (pair: TokenPairBody): AccountSession => ({
    userId: pair.user.id,
    email: pair.user.email,
    access: pair.access,
    refresh: pair.refresh,
  });

  return {
    isAuthenticated: () => session !== null && session.access.trim() !== '',
    getAccessToken: () =>
      session !== null && session.access.trim() !== '' ? session.access : null,
    getSession: () => (session ? { ...session } : null),

    async load(): Promise<void> {
      session = await persistence.read();
      emit();
    },

    async setSession(next: AccountSession): Promise<void> {
      await apply(next);
    },

    async clearSession(): Promise<void> {
      await apply(null);
    },

    async login(email: string, password: string): Promise<AccountSession> {
      const pair = await postJson<TokenPairBody>('/api/auth/login', { email, password });
      const next = toSession(pair);
      await apply(next);
      return next;
    },

    async register(email: string, password: string): Promise<AccountSession> {
      const pair = await postJson<TokenPairBody>('/api/auth/register', { email, password });
      const next = toSession(pair);
      await apply(next);
      return next;
    },

    async refresh(): Promise<boolean> {
      if (session === null) return false;
      try {
        const pair = await postJson<TokenPairBody>('/api/auth/refresh', {
          refresh: session.refresh,
        });
        // 轮换成功：用新对覆盖，但**不清会话**（userId / email 不变）
        await apply(toSession(pair));
        return true;
      } catch {
        // 轮换失败（401 / 网络）：**不清会话**——批次 4 的 UI 据此提示「重新登录」，
        // 而不是把用户踢回未登录、丢掉本地状态
        return false;
      }
    },

    async logout(): Promise<void> {
      const access = session?.access;
      const refresh = session?.refresh;
      try {
        if (access) {
          await post('/api/auth/logout', refresh ? { refresh } : {}, access);
        }
      } catch {
        // 网络失败不阻断本地登出：票据终会过期，本地先断干净更重要
      }
      await apply(null);
    },

    async deleteAccount(): Promise<void> {
      const access = session?.access;
      if (!access) {
        // 未登录没有云端账户可删：明确报错，而不是静默成功骗过调用方
        throw new SyncAuthError(401, '未登录，无法删除账户');
      }
      const response = await del('/api/account', access);
      if (!response.ok) {
        // 失败**不清会话**：让用户看到失败、保留本地状态，稍后重试
        throw new SyncAuthError(response.status, `/api/account 失败：HTTP ${response.status}`);
      }
      // 成功：与 logout 相同的本地收口（清会话 + 通知订阅者）
      await apply(null);
    },

    subscribe(cb: (next: AccountSession | null) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/** 持久化变体（② 运行时的 `platform.storage`，字符串 JSON）。 */
export function createStorageSyncAccount(
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): SyncAccount {
  return createSyncAccount(storagePersistence(), opts);
}

/** 纯内存变体（单测 / 不落盘）。 */
export function createMemorySyncAccount(
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): SyncAccount {
  return createSyncAccount(memoryPersistence(), opts);
}
