/**
 * 云端知识库 API 客户端（M7 客户端第一块）。
 *
 * ## 为什么单独一个纯函数模块，而不是塞进 `SyncClient`
 *
 * `SyncClient` 是**同步协议**的客户端（push/pull/events，服务端在写的是同步表）；
 * 组织与知识库是另一条资源线，接口形状、错误语义（403/404 有业务含义）都不同。
 * 混进去会让「同步失败要重试、权限失败不该重试」这类判断挤在一个类里。
 *
 * ## 三条约定
 *
 * 1. **不读全局状态**：`baseUrl` / `token` / `fetchImpl` 全部由调用方注入。
 *    页面负责从同步账户取 token，用例直接传桩 —— 无需 mock 整个 sync 运行时。
 * 2. **不抛异常**：一律返回 `{ ok, ... }` 结果对象。云端是可选能力，
 *    网络断了应该显示一行「连不上」，而不是把整页打成错误边界。
 * 3. **错误码要保留业务语义**：`403`（无权限）与 `404`（不存在 / 不是成员）
 *    对用户是两句不同的话，不能被压成「请求失败」。
 */

export interface KbClientConfig {
  /** 云端根地址（`resolveSyncBaseUrl()` 的产物），尾部斜杠会被去掉 */
  baseUrl: string;
  /** 当前 access token；`null` 表示未登录（调用方应先拦掉） */
  token: string | null;
  /** 注入 fetch（用例用桩；运行时不传即全局 fetch） */
  fetchImpl?: typeof fetch;
}

export type KbApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; unauthorized: boolean };

export interface KbOrg {
  id: string;
  name: string;
  /** 我在该组织里的角色（owner / admin / member） */
  role: string;
  memberCount: number;
  createdAt: string;
}

export interface KbSummary {
  id: string;
  orgId: string;
  name: string;
  description: string;
  /** 可见角色；界面据此解释「为什么同事看不到这个库」 */
  allowedRoles: string[];
  documentCount: number;
  createdAt: string;
}

export interface KbDocument {
  id: string;
  kbId: string;
  title: string;
  chars: number;
  chunkCount: number;
  createdAt: string;
  /** 实际写入的向量条数（0 = 没建索引） */
  embedded?: number;
  /** 来源格式：text / docx / pdf */
  kind?: string;
  /** 解析降级说明（如「2 页没有文本层」）——必须展示，否则用户不知道为什么搜不全 */
  warnings?: string[];
}

export interface KbSearchHit {
  chunkId: string;
  docId: string;
  docTitle: string;
  kbId: string;
  score: number;
  snippet: string;
}

/**
 * 检索能力与索引覆盖率（`GET /api/kb/retrieval`）。
 *
 * `mode` 是**能力口径**（这台服务能不能做向量检索），不是单次查询实际走的那条路
 * ——某次查询的候选一个向量都没有时仍会退回词法。界面文案必须按这个字段写，
 * 否则「说在做向量检索、其实走的是词法」就成了没法解释的现象。
 */
export interface KbRetrievalInfo {
  mode: 'lexical' | 'hybrid';
  /** `off` / `hash` / `openai`（后端可能新增，按字符串收） */
  embedder: string;
  model: string;
  dim: number;
  chunks: number;
  indexed: number;
  /** 有块没建索引（新文档 / 换了 embedder 还没重建） */
  stale: boolean;
  /** 配置错误（选了远程 embedder 但缺地址等），此时检索会退回词法 */
  error: string;
}

/** 重建索引的结果。`indexed < total` 说明中途失败（`error` 里有原因）。 */
export interface KbReindexResult {
  indexed: number;
  total: number;
  model: string;
  error: string;
}

/** 角色中文名（界面与提示共用）。 */
export const KB_ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
};

/** 未登录时的统一文案：调用方不必各自编一句。 */
export const KB_LOGIN_REQUIRED = '知识库在云端，需要先登录账户';

/**
 * 连不上云端时**补一句怎么把它拉起来**。
 *
 * 只报「无法连接云端服务」等于把排查成本丢给用户：知识库、同步、账户全挂在这一台上，
 * 而这台服务是**本地起的**（默认 `127.0.0.1:8910`），最常见的原因就是终端没开。
 * 所以文案里直接给可复制的命令，而不是让人去翻 README。
 */
export const KB_OFFLINE_HINT =
  '本地开发请在 cloud/ 目录启动服务：.venv/Scripts/python.exe -m uvicorn app.main:app --port 8910（生产请检查 VITE_SYNC_BASE_URL 是否指向可达地址）';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function request<T>(
  config: KbClientConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<KbApiResult<T>> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetchImpl(`${normalizeBaseUrl(config.baseUrl)}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    // 网络层失败（断网 / 服务未起）：不给 status，让界面说「连不上」而不是「500」。
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
  if (response.status === 204) return { ok: true, data: undefined as T };
  try {
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, status: response.status, message: '响应格式异常', unauthorized: false };
  }
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

/**
 * 网关：把「一组接口」收成一个可注入对象。
 *
 * 页面的 `gateway` prop 就是它 —— 用例传桩即可覆盖「加载 / 空态 / 403 / 网络断」，
 * 不必 mock 同步运行时，也不必起 HTTP 服务。
 */
export interface KbGateway {
  listOrgs(): Promise<KbApiResult<KbOrg[]>>;
  createOrg(name: string): Promise<KbApiResult<KbOrg>>;
  listKbs(orgId: string): Promise<KbApiResult<KbSummary[]>>;
  createKb(
    orgId: string,
    input: { name: string; description?: string; allowedRoles?: string[] },
  ): Promise<KbApiResult<KbSummary>>;
  listDocuments(kbId: string): Promise<KbApiResult<KbDocument[]>>;
  uploadDocument(
    kbId: string,
    input: { title: string; content: string },
  ): Promise<KbApiResult<KbDocument>>;
  /** 上传文件（服务端解析成文本再切块入库）；`title` 缺省用文件名 */
  uploadFile(
    kbId: string,
    input: { filename: string; contentBase64: string; title?: string },
  ): Promise<KbApiResult<KbDocument>>;
  search(
    orgId: string,
    input: { query: string; kbId?: string; kbIds?: string[]; topK?: number },
  ): Promise<KbApiResult<KbSearchHit[]>>;
  /** 当前检索能力与索引覆盖率（页面的说明文字按它渲染，不写死） */
  retrievalInfo(kbId?: string): Promise<KbApiResult<KbRetrievalInfo>>;
  /** 给一个库重建向量索引（补老文档 / 换 embedder 之后） */
  reindex(kbId: string): Promise<KbApiResult<KbReindexResult>>;
}

/** 用一份配置装配网关（页面在拿到 token 后调用一次）。 */
export function createKbGateway(config: KbClientConfig): KbGateway {
  return {
    listOrgs: () => listMyOrgs(config),
    createOrg: (name) => createOrg(config, name),
    listKbs: (orgId) => listKbs(config, orgId),
    createKb: (orgId, input) => createKb(config, orgId, input),
    listDocuments: (kbId) => listDocuments(config, kbId),
    uploadDocument: (kbId, input) => uploadDocument(config, kbId, input),
    uploadFile: (kbId, input) => uploadKbFile(config, kbId, input),
    search: (orgId, input) => searchOrgKbs(config, orgId, input),
    retrievalInfo: (kbId) => retrievalInfo(config, kbId),
    reindex: (kbId) => reindexKb(config, kbId),
  };
}

/** 我加入的组织。 */
export function listMyOrgs(config: KbClientConfig): Promise<KbApiResult<KbOrg[]>> {
  return request<KbOrg[]>(config, '/api/orgs');
}

/** 建组织（创建者自动成为 owner）。 */
export function createOrg(config: KbClientConfig, name: string): Promise<KbApiResult<KbOrg>> {
  return request<KbOrg>(config, '/api/orgs', { method: 'POST', body: { name } });
}

/** 组织内我可见的知识库（服务端已按角色过滤，客户端**不做二次过滤**）。 */
export function listKbs(config: KbClientConfig, orgId: string): Promise<KbApiResult<KbSummary[]>> {
  return request<KbSummary[]>(config, `/api/orgs/${encodeURIComponent(orgId)}/kbs`);
}

export function createKb(
  config: KbClientConfig,
  orgId: string,
  input: { name: string; description?: string; allowedRoles?: string[] },
): Promise<KbApiResult<KbSummary>> {
  return request<KbSummary>(config, `/api/orgs/${encodeURIComponent(orgId)}/kbs`, {
    method: 'POST',
    body: input,
  });
}

export function listDocuments(
  config: KbClientConfig,
  kbId: string,
): Promise<KbApiResult<KbDocument[]>> {
  return request<KbDocument[]>(config, `/api/kbs/${encodeURIComponent(kbId)}/documents`);
}

export function uploadDocument(
  config: KbClientConfig,
  kbId: string,
  input: { title: string; content: string },
): Promise<KbApiResult<KbDocument>> {
  return request<KbDocument>(config, `/api/kbs/${encodeURIComponent(kbId)}/documents`, {
    method: 'POST',
    body: input,
  });
}

/**
 * 上传文件入库（FR-4.7 解析）。
 *
 * 走 JSON + base64 而不是 multipart：服务端不必为此引入 `python-multipart`，
 * 客户端也不必拼表单边界。代价是体积 +1/3，对知识库文档（几百 KB）无所谓。
 */
export function uploadKbFile(
  config: KbClientConfig,
  kbId: string,
  input: { filename: string; contentBase64: string; title?: string },
): Promise<KbApiResult<KbDocument>> {
  return request<KbDocument>(config, `/api/kbs/${encodeURIComponent(kbId)}/documents/file`, {
    method: 'POST',
    body: input,
  });
}

/**
 * 检索（跨库 / 指定一本 / 指定一组）。
 *
 * ⚠️ 客户端**不再做可见性判断**：服务端已按角色过滤（且是检索前过滤）。
 * 在这里再筛一次只会掩盖服务端的 bug —— 而这条不变量正是要靠
 * 「服务端漏过滤时客户端原样显示越权结果」被测试发现。
 *
 * `kbIds` 是**范围收窄**（专家绑定的那几本），不是权限：越权的 id 由服务端回 403，
 * 客户端不预先过滤 —— 同上，静默跳过会把"绑定过期"伪装成"库里没资料"。
 */
export function searchOrgKbs(
  config: KbClientConfig,
  orgId: string,
  input: { query: string; kbId?: string; kbIds?: string[]; topK?: number },
): Promise<KbApiResult<KbSearchHit[]>> {
  return request<KbSearchHit[]>(config, `/api/orgs/${encodeURIComponent(orgId)}/search`, {
    method: 'POST',
    body: input,
  });
}

/** 当前检索能力 + 索引覆盖率。`kbId` 缺省 = 全站口径。 */
export function retrievalInfo(
  config: KbClientConfig,
  kbId?: string,
): Promise<KbApiResult<KbRetrievalInfo>> {
  const query = kbId ? `?kbId=${encodeURIComponent(kbId)}` : '';
  return request<KbRetrievalInfo>(config, `/api/kb/retrieval${query}`);
}

/** 重建一个库的向量索引（幂等，分批；中途失败会在 `error` 里说明）。 */
export function reindexKb(
  config: KbClientConfig,
  kbId: string,
): Promise<KbApiResult<KbReindexResult>> {
  return request<KbReindexResult>(config, `/api/kbs/${encodeURIComponent(kbId)}/reindex`, {
    method: 'POST',
  });
}
