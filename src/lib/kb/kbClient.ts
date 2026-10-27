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
  /** 当前 access token 的**静态快照**；`null` 表示未登录。有 `getToken` 时以它为准 */
  token: string | null;
  /**
   * 实时取 access token（优先于 `token`）。
   *
   * 为什么需要它：配置对象是**页面挂载时建一次**的，而 access token 只有 30 分钟寿命
   * （`cloud/app/auth/security.py` 的 `ACCESS_TTL`）。把票拷进配置，就等于把
   * 「半小时后必然 401」写死进页面 —— 之后即使同步引擎已经换过新票，这里仍是旧的。
   */
  getToken?: () => string | null;
  /**
   * 收到 401 时换一张新票；返回 `true` = 已拿到新票，可以重放一次原请求。
   *
   * ⚠️ 实现方**必须自己单飞**：服务端的 `/api/auth/refresh` 是**轮换 + 重用检测**
   * 制 —— 旧 refresh 换掉后会被标记 revoked 并指向新票，同一张旧票再用第二次会被
   * 判定为重放，**整条轮换链一起吊销**（用户被迫重新登录）。而页面首屏就是 3~4 个
   * 并发请求，遇到过期会同时回 401。生产实现传的是 `syncAccount.refresh()`，
   * 它自带在途合并。
   */
  refreshToken?: () => Promise<boolean>;
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
  /**
   * 部门范围（**收窄**）：空 = 不按部门收窄。
   *
   * 非空时只有「属于这些部门（含子部门）的成员」能看到——普通成员要同时满足
   * 角色与部门；管理员豁免（否则会出现「建完就看不见、也改不了范围」的死锁）。
   */
  allowedDepartments: string[];
  documentCount: number;
  createdAt: string;
}

/**
 * 组织（团队）里的一名成员。
 *
 * 与 `KbDepartmentMember` 是两个维度：这里说的是「他在这家公司是什么身份」，
 * 部门表说的是「他在哪个部门、是不是部门负责人」。界面上的「成员与权限」看的是前者。
 */
export interface KbOrgMember {
  userId: string;
  email: string;
  /** 组织角色：owner / admin / member */
  role: string;
  joinedAt: string;
}

/** 组织内的一个部门（树用一个扁平列表表示，`parentId` 为空串即根）。 */
export interface KbDepartment {
  id: string;
  orgId: string;
  parentId: string;
  name: string;
  memberCount: number;
  createdAt: string;
}

export interface KbDepartmentMember {
  userId: string;
  email: string;
  /** 部门内角色：member / manager（负责人可维护"仅限本部门"的知识库） */
  departmentRole?: string;
  /** 该用户在**组织**里的角色（部门本身没有角色，只有归属） */
  role: string;
  joinedAt: string;
}

export interface KbDocument {
  id: string;
  kbId: string;
  title: string;
  chars: number;
  chunkCount: number;
  createdAt: string;
  /**
   * 最后一次改动的时间（改名 / 恢复）；空串 = 这行产生于该字段之前 → 退回 `createdAt`。
   *
   * 列表上的「更新时间」必须读它：拿 `createdAt` 冒充更新时间，用户改完名会看到
   * 一个没动的时间，进而以为改名没生效。
   */
  updatedAt?: string;
  /** 实际写入的向量条数（0 = 没建索引） */
  embedded?: number;
  /** 来源格式：text / docx / pdf */
  kind?: string;
  /** 解析降级说明（如「2 页没有文本层」）——必须展示，否则用户不知道为什么搜不全 */
  warnings?: string[];
  /** 进回收站的时间；空串 = 正常文档。回收站视图靠它区分"删过的" */
  deletedAt?: string;
}

/**
 * 单篇详情 = 列表项 + 正文。
 *
 * `content` 是服务端**把块按序拼回来**的（不是原文件）：切块会吃掉原始排版，
 * 所以界面上必须标注这一点，别让人以为「打开文档」等于看原 PDF。
 */
export interface KbDocumentDetail extends KbDocument {
  content: string;
}

/**
 * 原文件与预览的状态（`GET /api/kbs/{kb}/documents/{doc}/preview`）。
 *
 * ## 为什么单独一个接口，不并进 `KbDocumentDetail`
 *
 * 文档列表里每行都查一次 `kb_files` 就是 N+1；而只有「打开抽屉」这一件事需要它。
 *
 * ## 四个 `previewState` 各对应一种界面
 *
 * - `ready`：能看原文（PDF 直通，或已转好）；
 * - `pending`：服务端能转，还没转（用户点开时同步转，会等几秒）；
 * - `failed`：转失败了（`previewError` 是 Office 的原话）；
 * - `unavailable`：这台机器转不了（没装 Office / 早期文档没留原文件 / 格式不支持）。
 *
 * 把 `failed` 和 `unavailable` 混成一个，用户就分不清「要不要找管理员」。
 */
export interface KbFilePreview {
  fileName: string;
  bytesLen: number;
  suffix: string;
  previewState: 'ready' | 'pending' | 'failed' | 'unavailable';
  previewError: string;
  /** 转换耗时（毫秒）。0 = 没转过（PDF 直通或读缓存） */
  renderMs: number;
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

/**
 * 入库被判重（HTTP 409）。
 *
 * 单独导出一个判据而不是让调用方写 `status === 409`：重复入库**不是错误**，
 * 是「这篇已经在库里了」。界面上它该是一条提示，而不是一条红色报错 ——
 * 这两者混起来，用户会去查「为什么上传失败了」。
 */
export const KB_DUPLICATE_STATUS = 409;

/** 未登录时的统一文案：调用方不必各自编一句。 */
export const KB_LOGIN_REQUIRED = '知识库在云端，需要先登录账户';

/**
 * 「已登录，但这张票不能用了」的文案（401 且刷新也失败）。
 *
 * 必须与 `KB_LOGIN_REQUIRED` 分开：两者在用户眼里是**相反**的事实。access token
 * 只有 30 分钟寿命，过期是常态；页面上却写着「需要先登录账户」，而侧边栏同一时刻
 * 显示着登录邮箱 —— 用户看到的就是一句自相矛盾的话。
 */
export const KB_SESSION_EXPIRED = '登录状态已过期，需要重新登录';

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

/**
 * 取这次请求该用的票。
 *
 * `getToken` 存在时**只信它**（哪怕它回 `null`）：`token` 是快照，快照过期后继续拿它
 * 去请求，就会得到一串「明知道会 401 的请求」。
 */
function currentToken(config: KbClientConfig): string | null {
  if (config.getToken) return config.getToken();
  return config.token;
}

async function request<T>(
  config: KbClientConfig,
  path: string,
  init: { method?: string; body?: unknown; parse?: 'json' | 'blob' } = {},
): Promise<KbApiResult<T>> {
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
    /*
     * 401 → 刷新一次 → 重放一次（与 `SyncClient.request` 同一套语义，只重试一次）。
     *
     * 重放前必须**重新取票**：刷新成功后新票在 account 里，config 上的快照还是旧的。
     * 刷新后仍 401 说明不是「access 过期」而是「凭据整体失效」（refresh 被吊销 /
     * 账户已删），此时继续重试只会把无效凭据反复打上去。
     *
     * 并发安全由 `refreshToken` 的实现方负责（`syncAccount.refresh()` 是单飞的）：
     * 本层的 3~4 个并发请求会**等同一个**刷新结果，不会把同一张 refresh 用两次。
     */
    if (response.status === 401 && config.refreshToken) {
      // 刷新抛错与返回 false 等价（都是「拿不到新票」）：不能让它落进下面的 catch，
      // 那会把「票过期」误报成「无法连接云端服务」
      const refreshed = await config.refreshToken().catch(() => false);
      if (refreshed) response = await send(currentToken(config));
    }
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
    // 图片要的是二进制：`<img src>` 不能带 Authorization 头，所以由这里带票取回
    // 字节，再在页面里换成 blob URL（见 `lib/kb/assetLoader.ts`）
    if (init.parse === 'blob') return { ok: true, data: (await response.blob()) as T };
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
  /** 改库的可见范围（角色 + 部门）。要求 admin —— 它会改变别人能不能看见 */
  updateKbVisibility(
    kbId: string,
    input: { name?: string; allowedRoles?: string[]; allowedDepartments?: string[] },
  ): Promise<KbApiResult<KbSummary>>;
  createKb(
    orgId: string,
    input: {
      name: string;
      description?: string;
      allowedRoles?: string[];
      allowedDepartments?: string[];
    },
  ): Promise<KbApiResult<KbSummary>>;
  listDepartments(orgId: string): Promise<KbApiResult<KbDepartment[]>>;
  createDepartment(
    orgId: string,
    input: { name: string; parentId?: string },
  ): Promise<KbApiResult<KbDepartment>>;
  /** 改名 / 换父节点（`parentId` 省略 = 不动结构，空串 = 移到根） */
  updateDepartment(
    departmentId: string,
    input: { name?: string; parentId?: string },
  ): Promise<KbApiResult<KbDepartment>>;
  /** 设置部门内角色（manager = 该部门负责人，可维护"仅限本部门"的知识库） */
  setDepartmentMemberRole(
    departmentId: string,
    userId: string,
    role: string,
  ): Promise<KbApiResult<KbDepartmentMember>>;
  deleteDepartment(departmentId: string): Promise<KbApiResult<undefined>>;
  listDepartmentMembers(departmentId: string): Promise<KbApiResult<KbDepartmentMember[]>>;
  addDepartmentMember(
    departmentId: string,
    email: string,
  ): Promise<KbApiResult<KbDepartmentMember>>;
  removeDepartmentMember(departmentId: string, userId: string): Promise<KbApiResult<undefined>>;
  /** 文档列表。`trashed` = 看回收站（**只看删过的**，不含正常文档） */
  listDocuments(kbId: string, input?: { trashed?: boolean }): Promise<KbApiResult<KbDocument[]>>;
  /**
   * 取一张图片的字节（`<img>` 不能带票，所以由 JS 取回再换 blob 地址）。
   * 权限与读文档同一套：库不可见就是 403。
   */
  fetchAsset(kbId: string, assetId: string): Promise<KbApiResult<Blob>>;
  /**
   * 上传一张图片（粘贴 / 选文件）。要写权限。
   *
   * 图片是「先入库、正文后引用」：粘贴时要立刻看到图，不能等文档保存。
   */
  uploadAsset(
    kbId: string,
    input: { filename: string; contentBase64: string },
  ): Promise<KbApiResult<KbAssetInfo>>;
  /**
   * 读单篇（元数据 + 正文，抽屉里「打开文档」用）。
   *
   * 失败语义照旧原样转达：403 = 角色不够，404 = 不存在 / 在回收站里。
   */
  getDocument(kbId: string, docId: string): Promise<KbApiResult<KbDocumentDetail>>;
  /** 原文件/预览状态（不触发转换） */
  getFilePreview(kbId: string, docId: string): Promise<KbApiResult<KbFilePreview>>;
  /** 要求生成预览并等它转完（同步、幂等） */
  buildFilePreview(kbId: string, docId: string): Promise<KbApiResult<KbFilePreview>>;
  /** 预览 PDF 的字节（pdf.js 用；带票取回，不走 URL） */
  getPreviewPdf(kbId: string, docId: string): Promise<KbApiResult<Blob>>;
  uploadDocument(
    kbId: string,
    input: { title: string; content: string },
  ): Promise<KbApiResult<KbDocument>>;
  /** 上传文件（服务端解析成文本再切块入库）；`title` 缺省用文件名 */
  uploadFile(
    kbId: string,
    input: { filename: string; contentBase64: string; title?: string },
  ): Promise<KbApiResult<KbDocument>>;
  /** 改标题（内容与块都不动）；需要管理员 */
  renameDocument(kbId: string, docId: string, title: string): Promise<KbApiResult<KbDocument>>;
  /**
   * 改标题 / 改正文（同一个接口，字段传了才改）；需要管理员。
   *
   * 改正文是**重新入库**：服务端会重新切块、重算摘要、重建向量 —— 所以它比改名慢，
   * 而且可能因为「和库里另一篇内容一样」被 409 拦下。
   */
  updateDocument(
    kbId: string,
    docId: string,
    input: { title?: string; content?: string },
  ): Promise<KbApiResult<KbDocument>>;
  /**
   * 删文档。默认**进回收站**（可从 `undo` 恢复），`purge` = 彻底删除（不可撤销）。
   * 需要管理员或该库允许部门的负责人。
   */
  deleteDocument(
    kbId: string,
    docId: string,
    input?: { purge?: boolean },
  ): Promise<KbApiResult<undefined>>;
  /** 从回收站恢复（块与向量都在，恢复即刻可检索） */
  restoreDocument(kbId: string, docId: string): Promise<KbApiResult<KbDocument>>;
  search(
    orgId: string,
    input: { query: string; kbId?: string; kbIds?: string[]; topK?: number },
  ): Promise<KbApiResult<KbSearchHit[]>>;
  /** 当前检索能力与索引覆盖率（页面的说明文字按它渲染，不写死） */
  retrievalInfo(kbId?: string): Promise<KbApiResult<KbRetrievalInfo>>;
  /** 给一个库重建向量索引（补老文档 / 换 embedder 之后） */
  reindex(kbId: string): Promise<KbApiResult<KbReindexResult>>;
  /** 组织成员列表（任何成员都能看：知道同事是谁不需要管理员权限） */
  listMembers(orgId: string): Promise<KbApiResult<KbOrgMember[]>>;
  /** 按邮箱加人。对方**必须已有账户**（服务端 404「该邮箱还没有账户」） */
  addMember(
    orgId: string,
    input: { email: string; role?: string },
  ): Promise<KbApiResult<KbOrgMember>>;
  /** 改组织角色（要 admin；不能授予高于自己的角色） */
  updateMemberRole(
    orgId: string,
    userId: string,
    role: string,
  ): Promise<KbApiResult<KbOrgMember>>;
  /** 移除成员；**移除自己 = 主动退出**（不需要管理员权限） */
  removeMember(orgId: string, userId: string): Promise<KbApiResult<undefined>>;
}

/** 用一份配置装配网关（页面在拿到 token 后调用一次）。 */
export function createKbGateway(config: KbClientConfig): KbGateway {
  return {
    listOrgs: () => listMyOrgs(config),
    createOrg: (name) => createOrg(config, name),
    listKbs: (orgId) => listKbs(config, orgId),
    updateKbVisibility: (kbId, input) => updateKbVisibility(config, kbId, input),
    createKb: (orgId, input) => createKb(config, orgId, input),
    listDocuments: (kbId, input) => listDocuments(config, kbId, input),
    fetchAsset: (kbId, assetId) => fetchKbAsset(config, kbId, assetId),
    uploadAsset: (kbId, input) => uploadKbAsset(config, kbId, input),
    getDocument: (kbId, docId) => getKbDocument(config, kbId, docId),
    getFilePreview: (kbId, docId) => getKbFilePreview(config, kbId, docId),
    buildFilePreview: (kbId, docId) => buildKbFilePreview(config, kbId, docId),
    getPreviewPdf: (kbId, docId) => getKbPreviewPdf(config, kbId, docId),
    uploadDocument: (kbId, input) => uploadDocument(config, kbId, input),
    uploadFile: (kbId, input) => uploadKbFile(config, kbId, input),
    renameDocument: (kbId, docId, title) => renameKbDocument(config, kbId, docId, title),
    updateDocument: (kbId, docId, input) => updateKbDocument(config, kbId, docId, input),
    deleteDocument: (kbId, docId, input) => deleteKbDocument(config, kbId, docId, input),
    restoreDocument: (kbId, docId) => restoreKbDocument(config, kbId, docId),
    search: (orgId, input) => searchOrgKbs(config, orgId, input),
    retrievalInfo: (kbId) => retrievalInfo(config, kbId),
    reindex: (kbId) => reindexKb(config, kbId),
    listDepartments: (orgId) => listDepartments(config, orgId),
    createDepartment: (orgId, input) => createDepartment(config, orgId, input),
    updateDepartment: (departmentId, input) => updateDepartment(config, departmentId, input),
    setDepartmentMemberRole: (departmentId, userId, role) =>
      setDepartmentMemberRole(config, departmentId, userId, role),
    deleteDepartment: (departmentId) => deleteDepartment(config, departmentId),
    listDepartmentMembers: (departmentId) => listDepartmentMembers(config, departmentId),
    addDepartmentMember: (departmentId, email) =>
      addDepartmentMember(config, departmentId, email),
    removeDepartmentMember: (departmentId, userId) =>
      removeDepartmentMember(config, departmentId, userId),
    listMembers: (orgId) => listOrgMembers(config, orgId),
    addMember: (orgId, input) => addOrgMember(config, orgId, input),
    updateMemberRole: (orgId, userId, role) => updateOrgMemberRole(config, orgId, userId, role),
    removeMember: (orgId, userId) => removeOrgMember(config, orgId, userId),
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
  input: {
    name: string;
    description?: string;
    allowedRoles?: string[];
    allowedDepartments?: string[];
  },
): Promise<KbApiResult<KbSummary>> {
  return request<KbSummary>(config, `/api/orgs/${encodeURIComponent(orgId)}/kbs`, {
    method: 'POST',
    body: input,
  });
}

export function listDocuments(
  config: KbClientConfig,
  kbId: string,
  input: { trashed?: boolean } = {},
): Promise<KbApiResult<KbDocument[]>> {
  const query = input.trashed ? '?includeDeleted=true' : '';
  return request<KbDocument[]>(
    config,
    `/api/kbs/${encodeURIComponent(kbId)}/documents${query}`,
  );
}

/**
 * 读单篇详情（正文由服务端把块拼回来）。
 *
 * 与列表分开是因为**代价不同**：列表只读元数据，一次几十行；正文可能有几十万字，
 * 打开哪一篇才拉哪一篇。
 */
export function getKbDocument(
  config: KbClientConfig,
  kbId: string,
  docId: string,
): Promise<KbApiResult<KbDocumentDetail>> {
  return request<KbDocumentDetail>(
    config,
    `/api/kbs/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
  );
}

/** 原文件/预览状态（只读，不触发转换）。 */
export function getKbFilePreview(
  config: KbClientConfig,
  kbId: string,
  docId: string,
): Promise<KbApiResult<KbFilePreview>> {
  return request<KbFilePreview>(config, previewPath(kbId, docId));
}

/**
 * 要求服务端**生成**预览并等它转完（同步、幂等）。
 *
 * 服务端只在状态不是 `ready`/`unavailable` 时才真的去拉 Office，所以这里可以放心
 * 在「点了原文但还没转」时直接调 —— 已经转好的文档是一次空转。
 */
export function buildKbFilePreview(
  config: KbClientConfig,
  kbId: string,
  docId: string,
): Promise<KbApiResult<KbFilePreview>> {
  return request<KbFilePreview>(config, previewPath(kbId, docId), { method: 'POST' });
}

/**
 * 取预览 PDF 的字节。
 *
 * 为什么是 blob 而不是 URL：`<embed src>` / pdf.js 的 URL 模式都**带不上
 * Authorization 头**，而知识库的接口一律要 Bearer 票。带票取回字节再交给 pdf.js，
 * 与图片走的是同一条路（见 `lib/kb/assetLoader.ts`）。
 */
export function getKbPreviewPdf(
  config: KbClientConfig,
  kbId: string,
  docId: string,
): Promise<KbApiResult<Blob>> {
  return request<Blob>(config, `${previewPath(kbId, docId)}.pdf`, { parse: 'blob' });
}

/** 原文件的下载地址（带票，走 `downloadKbFile`）。 */
export function downloadKbFile(
  config: KbClientConfig,
  kbId: string,
  docId: string,
): Promise<KbApiResult<Blob>> {
  return request<Blob>(
    config,
    `/api/kbs/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/file`,
    { parse: 'blob' },
  );
}

function previewPath(kbId: string, docId: string): string {
  return `/api/kbs/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/preview`;
}

/** 改可见范围。`name` 也走同一个接口（服务端复用同一份请求体，字段全部可选）。 */
export function updateKbVisibility(
  config: KbClientConfig,
  kbId: string,
  input: { name?: string; allowedRoles?: string[]; allowedDepartments?: string[] },
): Promise<KbApiResult<KbSummary>> {
  return request<KbSummary>(config, `/api/kbs/${encodeURIComponent(kbId)}/visibility`, {
    method: 'PATCH',
    body: input,
  });
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

/** 改标题。内容不动，所以不重新切块、也不动向量（改错标题不该丢索引）。 */
export function renameKbDocument(
  config: KbClientConfig,
  kbId: string,
  docId: string,
  title: string,
): Promise<KbApiResult<KbDocument>> {
  return request<KbDocument>(
    config,
    `/api/kbs/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
    { method: 'PATCH', body: { title } },
  );
}

/**
 * 改标题 / 改正文。
 *
 * 与 `renameKbDocument` 是同一条路由：服务端两个字段都可选，传了才改。留两个入口
 * 是因为调用方的语义不同（改名不该被误传成"覆盖正文"，反之亦然）。
 */
export function updateKbDocument(
  config: KbClientConfig,
  kbId: string,
  docId: string,
  input: { title?: string; content?: string },
): Promise<KbApiResult<KbDocument>> {
  return request<KbDocument>(
    config,
    `/api/kbs/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
    { method: 'PATCH', body: input },
  );
}

/** 一张已入库的图片。`alt` 是图注 —— 它唯一的检索信号。 */
export interface KbAssetInfo {
  id: string;
  mime: string;
  bytesLen: number;
  alt: string;
}

/**
 * 上传一张图片（粘贴截图 / 选文件）。
 *
 * 走 JSON + base64，与文件上传同一套理由（服务端不引 `python-multipart`）。
 * 服务端按**内容**判定类型（魔数），所以改扩展名骗不过。
 */
export function uploadKbAsset(
  config: KbClientConfig,
  kbId: string,
  input: { filename: string; contentBase64: string },
): Promise<KbApiResult<KbAssetInfo>> {
  return request<KbAssetInfo>(config, `/api/kbs/${encodeURIComponent(kbId)}/assets`, {
    method: 'POST',
    body: input,
  });
}

/**
 * 取一张图片的字节。
 *
 * 为什么要单独一个方法而不是把 URL 直接放进 `<img src>`：`<img>` **不会**带
 * `Authorization` 头，而知识库的接口一律要 Bearer 票。所以图片必须由 JS 带票取回，
 * 再在页面里换成 `blob:` 地址（`lib/kb/assetLoader.ts`）。
 *
 * 权限判定在服务端走的是**读文档那一套**（库的可见性），没有任何旁路。
 */
export function fetchKbAsset(
  config: KbClientConfig,
  kbId: string,
  assetId: string,
): Promise<KbApiResult<Blob>> {
  return request<Blob>(
    config,
    `/api/kbs/${encodeURIComponent(kbId)}/assets/${encodeURIComponent(assetId)}`,
    { parse: 'blob' },
  );
}

/**
 * 删文档。服务端会连同**块与向量**一起删（否则会留下检索得到、列表里却没有的
 * 幽灵数据）。客户端不做任何本地清理：删完重新拉列表，界面上就是服务端的样子。
 */
export function deleteKbDocument(
  config: KbClientConfig,
  kbId: string,
  docId: string,
  input: { purge?: boolean } = {},
): Promise<KbApiResult<undefined>> {
  const query = input.purge ? '?purge=true' : '';
  return request<undefined>(
    config,
    `/api/kbs/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}${query}`,
    { method: 'DELETE' },
  );
}

/** 从回收站恢复。 */
export function restoreKbDocument(
  config: KbClientConfig,
  kbId: string,
  docId: string,
): Promise<KbApiResult<KbDocument>> {
  return request<KbDocument>(
    config,
    `/api/kbs/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/restore`,
    { method: 'POST' },
  );
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

/** 组织里的部门树（**父在子前**的扁平顺序，按 parentId 缩进即可）。 */export function listDepartments(
  config: KbClientConfig,
  orgId: string,
): Promise<KbApiResult<KbDepartment[]>> {
  return request<KbDepartment[]>(config, `/api/orgs/${encodeURIComponent(orgId)}/departments`);
}

/** 建部门（要 admin）。`parentId` 省略 = 根。 */
export function createDepartment(
  config: KbClientConfig,
  orgId: string,
  input: { name: string; parentId?: string },
): Promise<KbApiResult<KbDepartment>> {
  return request<KbDepartment>(config, `/api/orgs/${encodeURIComponent(orgId)}/departments`, {
    method: 'POST',
    body: input,
  });
}

export function updateDepartment(
  config: KbClientConfig,
  departmentId: string,
  input: { name?: string; parentId?: string },
): Promise<KbApiResult<KbDepartment>> {
  return request<KbDepartment>(config, `/api/departments/${encodeURIComponent(departmentId)}`, {
    method: 'PATCH',
    body: input,
  });
}

/** 设置部门内角色（manager = 负责人）。 */
export function setDepartmentMemberRole(
  config: KbClientConfig,
  departmentId: string,
  userId: string,
  role: string,
): Promise<KbApiResult<KbDepartmentMember>> {
  return request<KbDepartmentMember>(
    config,
    `/api/departments/${encodeURIComponent(departmentId)}/members/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: { role } },
  );
}

/** 删部门（要 admin；有子部门 / 有成员 / 被知识库引用时服务端会 409 并说明原因）。 */
export function deleteDepartment(
  config: KbClientConfig,
  departmentId: string,
): Promise<KbApiResult<undefined>> {
  return request<undefined>(config, `/api/departments/${encodeURIComponent(departmentId)}`, {
    method: 'DELETE',
  });
}

export function listDepartmentMembers(
  config: KbClientConfig,
  departmentId: string,
): Promise<KbApiResult<KbDepartmentMember[]>> {
  return request<KbDepartmentMember[]>(
    config,
    `/api/departments/${encodeURIComponent(departmentId)}/members`,
  );
}

/** 加人：要求对方**已经是组织成员**（部门不是邀请入口）。 */
export function addDepartmentMember(
  config: KbClientConfig,
  departmentId: string,
  email: string,
): Promise<KbApiResult<KbDepartmentMember>> {
  return request<KbDepartmentMember>(
    config,
    `/api/departments/${encodeURIComponent(departmentId)}/members`,
    { method: 'POST', body: { email } },
  );
}

export function removeDepartmentMember(
  config: KbClientConfig,
  departmentId: string,
  userId: string,
): Promise<KbApiResult<undefined>> {
  return request<undefined>(
    config,
    `/api/departments/${encodeURIComponent(departmentId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}

/*
 * 组织成员（团队级权限）。
 *
 * 与知识库的 `allowedRoles` 是**两层**：这里决定"他在这家公司是什么身份"，
 * 库上的角色决定"这个身份能不能看这个库"。界面上混在一起说会让人以为
 * 「把某人从管理员改成成员」= 「把他从这个库里踢掉」，其实前者影响所有库。
 */

export function listOrgMembers(
  config: KbClientConfig,
  orgId: string,
): Promise<KbApiResult<KbOrgMember[]>> {
  return request<KbOrgMember[]>(config, `/api/orgs/${encodeURIComponent(orgId)}/members`);
}

/** 加人：按邮箱（MVP 不发邀请邮件，对方必须已有账户）。 */
export function addOrgMember(
  config: KbClientConfig,
  orgId: string,
  input: { email: string; role?: string },
): Promise<KbApiResult<KbOrgMember>> {
  return request<KbOrgMember>(config, `/api/orgs/${encodeURIComponent(orgId)}/members`, {
    method: 'POST',
    // 不传 role 时服务端默认 member；这里显式给一个，省得调用方以为"不传=继承"
    body: { email: input.email, role: input.role ?? 'member' },
  });
}

export function updateOrgMemberRole(
  config: KbClientConfig,
  orgId: string,
  userId: string,
  role: string,
): Promise<KbApiResult<KbOrgMember>> {
  return request<KbOrgMember>(
    config,
    `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: { role } },
  );
}

/** 移除成员（自己移除自己 = 退出组织，服务端允许）。 */
export function removeOrgMember(
  config: KbClientConfig,
  orgId: string,
  userId: string,
): Promise<KbApiResult<undefined>> {
  return request<undefined>(
    config,
    `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}
