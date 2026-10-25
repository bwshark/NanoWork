import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  InputBase,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import GridOnOutlinedIcon from "@mui/icons-material/GridOnOutlined";
import CodeOutlinedIcon from "@mui/icons-material/CodeOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import { ROUTES } from "@/lib/core/constants";
import { toast } from "@/components/Toast";
import {
  KB_DUPLICATE_STATUS,
  KB_LOGIN_REQUIRED,
  KB_OFFLINE_HINT,
  KB_ROLE_LABELS,
  KB_SESSION_EXPIRED,
  type KbApiResult,
  type KbDepartment,
  type KbDocument,
  type KbGateway,
  type KbOrg,
  type KbRetrievalInfo,
  type KbSearchHit,
  type KbSummary,
} from "@/lib/kb/kbClient";
import { describeRetrieval } from "@/lib/kb/kbRetrievalCaption";
import { KB_UPLOAD_ACCEPT, precheckUpload } from "@/lib/kb/kbUpload";
import { docIndexHint } from "@/lib/kb/kbDocumentMeta";
import { readFileAsBase64 } from "@/lib/artifact/fileBase64";
import { createRuntimeKbGateway } from "@/sync/kbGateway";
import { useSyncRuntime } from "@/sync/useSyncRuntime";
import { KnowledgeSidebar } from "@/components/knowledge/KnowledgeSidebar";
import { HeaderSubtitle, KnowledgeHeader, type KbMenuItem } from "@/components/knowledge/KnowledgeHeader";
import { KnowledgeTeamPanel } from "@/components/knowledge/KnowledgeTeamPanel";
import { KnowledgeDocList, type KbDocView } from "@/components/knowledge/KnowledgeDocList";
import { CreateTeamDialog } from "@/components/knowledge/CreateTeamDialog";
import { CreateKbDialog } from "@/components/knowledge/CreateKbDialog";
import { TeamMembersDialog } from "@/components/knowledge/TeamMembersDialog";
import {
  DeleteDocDialog,
  NewDocDialog,
  PurgeDocDialog,
  RenameDocDialog,
  VisibilityDialog,
} from "@/components/knowledge/KnowledgeDocDialogs";
import { DepartmentDialog } from "@/components/knowledge/DepartmentDialog";

/**
 * 知识库（M7 客户端）：团队 → 知识库 → 文档 / 检索。
 *
 * ## 布局（与参考界面一致）
 *
 * ```
 * ┌ 侧栏（团队 → 知识库两级树）┬ 团队视图：知识库卡片网格 ┐
 * │ 个人知识库（占位）          │ 或                       │
 * │ 团队知识库                  │ 知识库视图：文件列表      │
 * └───────────────────────────┴─────────────────────────┘
 * ```
 *
 * 两个视图互斥，靠**有没有选中库**切换：没选库 = 先看清楚这个团队有哪些库
 * （卡片上是范围与篇数），选了库 = 看里面的文件。刻意不给「默认直接进第一个库」：
 * 那会让「这个团队一共有什么」变成必须点很多次才能回答的问题。
 *
 * ## 三条设计取舍（沿用上一版，重构没有改变它们）
 *
 * 1. **不复制服务端的可见性判断**：列表与检索结果都原样显示服务端给的集合。
 *    客户端再筛一次会让「服务端漏过滤」变成看不见的 bug（而它正是本模块最该防的事）。
 * 2. **不做全局 store**：这是**服务端状态**，不是本地领域数据；进 zustand + persist
 *    只会带来「离线时读到上周的库列表」这种更糟的错觉。页面持有即用即取。
 * 3. **网关可注入**（`gateway` prop）：页面逻辑可以在用例里跑，不必 mock 整个同步运行时。
 */

const ALL_ROLES = ["member", "admin", "owner"] as const;

/**
 * 登录态问题的三种结论。
 *
 * `anonymous` 与 `expired` 必须分开：前者是「还没有账户」，后者是「有账户，但这张
 * access token 不能用了」。access token 只有 30 分钟寿命，过期是**常态**；一律说
 * 「需要先登录账户」，就会出现「侧边栏明明显示着登录邮箱」的自相矛盾。
 */
type AuthIssue = "none" | "anonymous" | "expired";

function roleLabels(roles: readonly string[]): string {
  return roles.map((role) => KB_ROLE_LABELS[role] ?? role).join(" / ");
}

function errorText<T>(result: KbApiResult<T>): string {
  return result.ok ? "" : result.message;
}

/**
 * 入库失败的分级：**判重（409）不是错误**。
 *
 * 重复上传同一份资料，用户想确认的是「进去了吗」，而不是看见一条红色报错再猜
 * 「是不是坏了」。服务端的文案已经写清「已在库里，那篇叫《X》」，原样提示即可。
 */
function toastIngestFailure<T>(result: KbApiResult<T>): void {
  if (result.ok) return;
  if (result.status === KB_DUPLICATE_STATUS) toast.warning(result.message);
  else toast.error(result.message);
}

export function KnowledgePage({ gateway }: { gateway?: KbGateway }) {
  const navigate = useNavigate();
  /*
   * 登录态**必须订阅**，不能只在挂载时读一次：`initSyncRuntime()` 是异步的
   * （App 启动块要等设备号与会话列表就位），而路由可能先落到本页——读一次就永远
   * 停在「去登录」，即使运行时随后就到了。`AccountEntry` 解的是同一个问题。
   */
  const runtime = useSyncRuntime();
  /*
   * 网关只建一次（`useMemo`）：它现在是**长期可用**的——票由 `getToken` 实时取、
   * 401 由 `kbClient` 自己刷新重放，所以不必随 token 变化重建，否则每次刷新都会
   * 把三份列表重新拉一遍。
   */
  const client = useMemo<KbGateway | null>(
    () => (gateway !== undefined ? gateway : createRuntimeKbGateway()),
    [gateway, runtime],
  );
  /** 401 且刷新失败才会置真（`kbClient` 已经先尝试过换票） */
  const [sessionExpired, setSessionExpired] = useState(false);

  // 网关换了（重新登录 / 运行时到位）：上一次的「过期」结论作废
  useEffect(() => {
    setSessionExpired(false);
  }, [client]);

  const authIssue: AuthIssue =
    client === null ? "anonymous" : sessionExpired ? "expired" : "none";

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [orgs, setOrgs] = useState<KbOrg[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string>("");
  const [orgsError, setOrgsError] = useState("");
  // status=0 = 根本没连上（服务没起 / 地址错）。与 403/404 分开：那两种是业务语义，
  // 给它们贴「请启动服务」只会误导。
  const [orgsOffline, setOrgsOffline] = useState(false);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [teamBusy, setTeamBusy] = useState(false);

  /** 团队 id → 该团队下我可见的库。一次全取：侧栏的树要同时显示多个团队 */
  const [kbsByOrg, setKbsByOrg] = useState<Record<string, KbSummary[]>>({});
  const [kbsError, setKbsError] = useState("");
  const [kbsLoading, setKbsLoading] = useState(false);
  const [activeKbId, setActiveKbId] = useState<string>("");

  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [docsError, setDocsError] = useState("");
  const [docsLoading, setDocsLoading] = useState(false);
  /** 回收站视图：看的是「删过的」，与正常列表互斥（服务端也是两个口径） */
  const [trashOpen, setTrashOpen] = useState(false);
  const [view, setView] = useState<KbDocView>("list");

  // 检索能力 + 索引覆盖率：说明文字按它渲染（原来写死「词法检索」，开了向量就说谎）
  const [retrieval, setRetrieval] = useState<KbRetrievalInfo | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [uploading, setUploading] = useState(false);
  // 部门树：既用于「仅限部门」的选项，也用于列表里把范围显示成人话
  const [departments, setDepartments] = useState<KbDepartment[]>([]);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KbSearchHit[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searching, setSearching] = useState(false);

  // —— 弹窗状态 ——
  const [teamDialogOpen, setTeamDialogOpen] = useState(false);
  const [kbDialogOpen, setKbDialogOpen] = useState(false);
  const [newKbOrgId, setNewKbOrgId] = useState("");
  const [newKbName, setNewKbName] = useState("");
  const [newKbDescription, setNewKbDescription] = useState("");
  const [newKbRoles, setNewKbRoles] = useState<string[]>([...ALL_ROLES]);
  const [newKbDeptIds, setNewKbDeptIds] = useState<string[]>([]);
  const [kbBusy, setKbBusy] = useState(false);

  const [docDialogOpen, setDocDialogOpen] = useState(false);
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");

  // 改名 / 删除都要先确认：目标文档 + 改名时正在编辑的标题。
  // 用两个独立状态而不是一个 `{ doc, mode }`：两个弹窗的打开条件互斥，
  // 合成一个对象会让「关掉其中一个」把另一个也顺手关掉。
  const [renameTarget, setRenameTarget] = useState<KbDocument | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<KbDocument | null>(null);
  /** 彻底删除的目标：与「删除」分开一个弹窗，因为两者的后果不一样 */
  const [purgeTarget, setPurgeTarget] = useState<KbDocument | null>(null);
  /** 改可见范围的目标库（null = 弹窗关着） */
  const [scopeKb, setScopeKb] = useState<KbSummary | null>(null);
  const [scopeRoles, setScopeRoles] = useState<string[]>([]);
  const [scopeDeptIds, setScopeDeptIds] = useState<string[]>([]);
  const [rowBusy, setRowBusy] = useState(false);

  const [membersOpen, setMembersOpen] = useState(false);
  const [deptOpen, setDeptOpen] = useState(false);

  const activeOrg = useMemo(
    () => orgs.find((org) => org.id === activeOrgId) ?? null,
    [orgs, activeOrgId],
  );
  const kbs = useMemo(() => kbsByOrg[activeOrgId] ?? [], [kbsByOrg, activeOrgId]);
  const activeKb = useMemo(() => {
    for (const list of Object.values(kbsByOrg)) {
      const found = list.find((kb) => kb.id === activeKbId);
      if (found) return found;
    }
    return null;
  }, [kbsByOrg, activeKbId]);

  const loadOrgs = useCallback(async (target: KbGateway) => {
    setOrgsLoading(true);
    setOrgsError("");
    setOrgsOffline(false);
    const result = await target.listOrgs();
    setOrgsLoading(false);
    if (!result.ok) {
      // 走到这里说明 `kbClient` 已经试过刷新：仍 401 = 凭据整体失效（refresh 被吊销 /
      // 账户被删），只能请用户重新登录。这不是「没登录」。
      if (result.unauthorized) setSessionExpired(true);
      setOrgsOffline(result.status === 0);
      setOrgsError(result.message);
      return;
    }
    setOrgs(result.data);
    // 这一次成功了：之前的「过期」结论作废（重试 / 引擎刚换过票都会走到这里）
    setSessionExpired(false);
    // 只在「当前选择失效」时改选中项：否则每次刷新都会把用户踢回第一个团队
    setActiveOrgId((prev) =>
      result.data.some((org) => org.id === prev) ? prev : result.data[0]?.id ?? "",
    );
  }, []);

  useEffect(() => {
    if (client) void loadOrgs(client);
  }, [client, loadOrgs]);

  /**
   * 一次取回**所有团队**的库列表。
   *
   * 侧栏的树要同时显示多个团队下的库，逐个团队懒加载会让「同事说他有个库」
   * 在自己侧栏里看不见（得先猜是哪个团队）。团队数量是个位数，一次并发取完
   * 比这种猜测便宜得多。
   *
   * 单个团队失败**不影响**其它团队：失败的那个记空数组并把第一句错误报出来，
   * 其余照常渲染——一次 403 不该让整个页面变成错误态。
   */
  const loadKbs = useCallback(async (target: KbGateway, list: readonly KbOrg[]) => {
    if (list.length === 0) {
      setKbsByOrg({});
      setKbsError("");
      return;
    }
    setKbsLoading(true);
    const results = await Promise.all(
      list.map(async (org) => [org.id, await target.listKbs(org.id)] as const),
    );
    setKbsLoading(false);
    const next: Record<string, KbSummary[]> = {};
    let firstError = "";
    for (const [orgId, result] of results) {
      next[orgId] = result.ok ? result.data : [];
      if (!result.ok && firstError === "") firstError = result.message;
    }
    setKbsByOrg(next);
    setKbsError(firstError);
    // 选中的库可能刚被删掉 / 权限被收回：清掉，别让右侧挂着一个不存在的库
    setActiveKbId((prev) =>
      prev !== "" && Object.values(next).some((items) => items.some((kb) => kb.id === prev))
        ? prev
        : "",
    );
  }, []);

  useEffect(() => {
    if (client) void loadKbs(client, orgs);
  }, [client, orgs, loadKbs]);

  const loadDocs = useCallback(async (target: KbGateway, kbId: string, trashed = false) => {
    if (!kbId) {
      setDocs([]);
      return;
    }
    setDocsLoading(true);
    setDocsError("");
    const result = await target.listDocuments(kbId, { trashed });
    setDocsLoading(false);
    if (!result.ok) {
      setDocs([]);
      setDocsError(result.message);
      return;
    }
    setDocs(result.data);
  }, []);

  useEffect(() => {
    if (client) void loadDocs(client, activeKbId, trashOpen);
  }, [client, activeKbId, trashOpen, loadDocs]);

  /**
   * 读部门树。失败**不 toast**：它是「可见范围」的附加信息，云端连不上时
   * 知识库页该说的第一句话是「连不上」，不是弹一排部门加载失败。
   */
  const loadDepartments = useCallback(async (target: KbGateway, orgId: string) => {
    if (!orgId) {
      setDepartments([]);
      return;
    }
    const result = await target.listDepartments(orgId);
    setDepartments(result.ok ? result.data : []);
  }, []);

  useEffect(() => {
    if (client) void loadDepartments(client, activeOrgId);
  }, [client, activeOrgId, loadDepartments]);

  /**
   * 读检索状态。**失败不报错、只保留上一次**：它是说明文字的数据源，
   * 拿不到时就退回「不猜引擎」的中性文案，不该因为一个附加信息把整页打成错误态。
   */
  const loadRetrieval = useCallback(async (target: KbGateway, kbId: string) => {
    const result = await target.retrievalInfo(kbId || undefined);
    if (result.ok) setRetrieval(result.data);
  }, []);

  useEffect(() => {
    if (client) void loadRetrieval(client, activeKbId);
  }, [client, activeKbId, loadRetrieval]);

  /**
   * 库的可见范围人话：`N 篇 · 角色可见 · 仅 部门A、部门B`。
   *
   * 部门名字查不到时退回 id —— 比显示空白强：空白会让用户以为「没设范围」，
   * 而实际情况是「设了但部门已被删」（这种情况删部门时会被服务端拦住，理论上不该出现）。
   */
  const describeKb = (kb: KbSummary): string => {
    const parts = [`${kb.documentCount} 篇`, `${roleLabels(kb.allowedRoles)}可见`];
    const ids = kb.allowedDepartments ?? [];
    if (ids.length > 0) {
      const names = ids.map((id) => departments.find((item) => item.id === id)?.name ?? id);
      parts.push(`仅 ${names.join("、")}`);
    }
    return parts.join(" · ");
  };

  const indexHintFor = (doc: KbDocument): string =>
    docIndexHint(doc, retrieval === null || retrieval.embedder === "off");

  const resetSearch = () => {
    setHits(null);
    setSearchError("");
  };

  const selectTeam = (orgId: string) => {
    setActiveOrgId(orgId);
    setActiveKbId("");
    setTrashOpen(false);
    resetSearch();
  };

  const selectKb = (orgId: string, kbId: string) => {
    setActiveOrgId(orgId);
    setActiveKbId(kbId);
    setTrashOpen(false);
    resetSearch();
  };

  const openCreateKb = (orgId?: string) => {
    const target = orgId ?? activeOrgId;
    if (target === "") {
      toast.error("先建一个团队：知识库挂在团队下");
      return;
    }
    setNewKbOrgId(target);
    setNewKbName("");
    setNewKbDescription("");
    setNewKbRoles([...ALL_ROLES]);
    setNewKbDeptIds([]);
    setKbDialogOpen(true);
  };

  const toggleRole = (role: string) =>
    setNewKbRoles((previous) =>
      previous.includes(role) ? previous.filter((item) => item !== role) : [...previous, role],
    );

  const toggleNewKbDept = (id: string) =>
    setNewKbDeptIds((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
    );

  const handleCreateKb = async () => {
    if (!client || newKbOrgId === "" || !newKbName.trim()) return;
    if (newKbRoles.length === 0) {
      // 服务端也会 422，但这里先挡一次：省一趟往返，也说清是哪个字段不对
      toast.error("至少要选一个可见角色");
      return;
    }
    setKbBusy(true);
    const result = await client.createKb(newKbOrgId, {
      name: newKbName.trim(),
      ...(newKbDescription.trim() !== "" ? { description: newKbDescription.trim() } : {}),
      allowedRoles: newKbRoles,
      // 空数组与"不传"在服务端语义不同：不传 = 不动；建库时两者等价，
      // 但显式只在非空时下发，避免把「没选」写成一个刻意的收窄
      ...(newKbDeptIds.length > 0 ? { allowedDepartments: newKbDeptIds } : {}),
    });
    setKbBusy(false);
    if (!result.ok) {
      toast.error(errorText(result));
      return;
    }
    setKbDialogOpen(false);
    toast.success(`已创建知识库「${result.data.name}」`);
    await loadKbs(client, orgs);
    // 建完直接进去：用户刚建它就是为了往里放东西
    selectKb(newKbOrgId, result.data.id);
  };

  const handleCreateOrg = async () => {
    if (!client || !newOrgName.trim()) return;
    const result = await client.createOrg(newOrgName.trim());
    if (!result.ok) {
      toast.error(errorText(result));
      return;
    }
    setNewOrgName("");
    toast.success(`已创建「${result.data.name}」`);
    await loadOrgs(client);
  };

  const handleCreateTeam = async (input: { name: string; emails: string[] }) => {
    if (!client) return;
    setTeamBusy(true);
    const created = await client.createOrg(input.name);
    if (!created.ok) {
      setTeamBusy(false);
      toast.error(errorText(created));
      return;
    }
    // 团队已经建好了：后面加人失败不能回滚（也不该回滚），逐条报出来
    const failed: string[] = [];
    for (const email of input.emails) {
      const added = await client.addMember(created.data.id, { email });
      if (!added.ok) failed.push(`${email}：${added.message}`);
    }
    setTeamBusy(false);
    setTeamDialogOpen(false);
    if (failed.length === 0) toast.success(`已创建团队「${created.data.name}」`);
    else {
      toast.success(`已创建团队「${created.data.name}」`);
      for (const item of failed) toast.warning(`没加进去 · ${item}`);
    }
    await loadOrgs(client);
    selectTeam(created.data.id);
  };

  const handleUpload = async () => {
    if (!client || !activeKbId || !docTitle.trim() || !docContent.trim()) return;
    setRowBusy(true);
    const result = await client.uploadDocument(activeKbId, {
      title: docTitle.trim(),
      content: docContent,
    });
    setRowBusy(false);
    if (!result.ok) {
      toastIngestFailure(result);
      return;
    }
    setDocDialogOpen(false);
    setDocTitle("");
    setDocContent("");
    toast.success(`已入库：${result.data.chunkCount} 块`);
    await loadDocs(client, activeKbId);
    await loadKbs(client, orgs);
  };

  /**
   * 上传文件：客户端预检 → 读 base64 → 服务端解析入库。
   *
   * 三个必须做对的细节：
   * 1. 预检失败**不读文件**（8MB 的文件读成 base64 本身就慢）；
   * 2. 解析警告（PDF 某几页没文本层 / docx 表格被摊平）要逐条 toast —— 这类信息
   *    不告诉用户，就会变成「我明明传了那份资料，它就是搜不到」；
   * 3. `<input>` 的 value 要清空，否则**同一个文件再选一次不触发 onChange**。
   */
  const handleFileUpload = async (file: File) => {
    if (!client || !activeKbId) return;
    const problem = precheckUpload(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    setUploading(true);
    try {
      const contentBase64 = await readFileAsBase64(file);
      const result = await client.uploadFile(activeKbId, {
        filename: file.name,
        contentBase64,
      });
      if (!result.ok) {
        toastIngestFailure(result);
        return;
      }
      const { title, kind, chunkCount, warnings } = result.data;
      toast.success(`已入库《${title}》（${kind ?? "文件"}，${chunkCount} 块）`);
      for (const warning of warnings ?? []) toast.warning(warning);
      await loadDocs(client, activeKbId);
      await loadRetrieval(client, activeKbId);
      await loadKbs(client, orgs);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取文件失败");
    } finally {
      setUploading(false);
    }
  };

  const openRename = (doc: KbDocument) => {
    setRenameValue(doc.title);
    setRenameTarget(doc);
  };

  const handleRename = async () => {
    if (!client || !activeKbId || !renameTarget) return;
    const title = renameValue.trim();
    if (title === "" || title === renameTarget.title) {
      setRenameTarget(null);
      return;
    }
    setRowBusy(true);
    const result = await client.renameDocument(activeKbId, renameTarget.id, title);
    setRowBusy(false);
    if (!result.ok) {
      // 不关弹窗：改失败时用户还在里面，关掉等于让他重新找一遍
      toast.error(result.message);
      return;
    }
    setRenameTarget(null);
    toast.success("标题已更新");
    await loadDocs(client, activeKbId);
  };

  const handleDeleteDoc = async () => {
    if (!client || !activeKbId || !deleteTarget) return;
    setRowBusy(true);
    const result = await client.deleteDocument(activeKbId, deleteTarget.id);
    setRowBusy(false);
    setDeleteTarget(null);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(`已删除「${deleteTarget.title}」`);
    // 三样都变了：文档列表、库上的文档数、索引覆盖率（块少了一批）
    await loadDocs(client, activeKbId);
    await loadKbs(client, orgs);
    await loadRetrieval(client, activeKbId);
  };

  const handleRestore = async (doc: KbDocument) => {
    if (!client || !activeKbId) return;
    const result = await client.restoreDocument(activeKbId, doc.id);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(`已恢复「${doc.title}」`);
    await loadDocs(client, activeKbId, true);
    await loadKbs(client, orgs);
    await loadRetrieval(client, activeKbId);
  };

  /**
   * 彻底删除：**不可撤销**，所以文案与弹窗都与「删除」分开。
   */
  const handlePurge = async () => {
    if (!client || !activeKbId || purgeTarget === null) return;
    const target = purgeTarget;
    setRowBusy(true);
    const result = await client.deleteDocument(activeKbId, target.id, { purge: true });
    setRowBusy(false);
    setPurgeTarget(null);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(`已彻底删除「${target.title}」`);
    await loadDocs(client, activeKbId, true);
    await loadKbs(client, orgs);
    await loadRetrieval(client, activeKbId);
  };

  const openScope = (kb: KbSummary) => {
    setScopeRoles([...kb.allowedRoles]);
    setScopeDeptIds([...(kb.allowedDepartments ?? [])]);
    setScopeKb(kb);
  };

  const handleSaveScope = async () => {
    if (!client || scopeKb === null) return;
    if (scopeRoles.length === 0) {
      // 服务端也会 422，但这里先挡一次：省一趟往返，也说清是哪个字段不对
      toast.error("至少要选一个能看见的角色");
      return;
    }
    setRowBusy(true);
    const result = await client.updateKbVisibility(scopeKb.id, {
      allowedRoles: scopeRoles,
      allowedDepartments: scopeDeptIds,
    });
    setRowBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    setScopeKb(null);
    toast.success(`已更新「${result.data.name}」的可见范围`);
    await loadKbs(client, orgs);
  };

  const handleReindex = async () => {
    if (!client || !activeKbId) return;
    setReindexing(true);
    const result = await client.reindex(activeKbId);
    setReindexing(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    const { indexed, total, error } = result.data;
    // 分批建的：中途失败要如实说「做到哪了」，否则用户点完看到「成功」但还搜不到
    if (error !== "") toast.warning(`索引未全部完成（${indexed}/${total}）：${error}`);
    else toast.success(`已为 ${indexed} 块建立索引`);
    await loadRetrieval(client, activeKbId);
    await loadDocs(client, activeKbId);
  };

  const handleSearch = async () => {
    if (!client || !activeOrgId || !query.trim()) return;
    setSearching(true);
    setSearchError("");
    const result = await client.search(activeOrgId, {
      query: query.trim(),
      kbId: activeKbId || undefined,
    });
    setSearching(false);
    if (!result.ok) {
      setHits(null);
      setSearchError(result.message);
      return;
    }
    setHits(result.data);
  };

  const refreshAll = () => {
    if (!client) return;
    void loadOrgs(client);
    void loadKbs(client, orgs);
    void loadDocs(client, activeKbId, trashOpen);
    void loadRetrieval(client, activeKbId);
  };

  const caption = describeRetrieval(retrieval);
  const canReindex =
    retrieval !== null && retrieval.embedder !== "off" && retrieval.stale && activeKbId !== "";

  if (authIssue !== "none") {
    const expired = authIssue === "expired";
    return (
      <Box sx={{ p: 2.5 }}>
        <Alert
          severity={expired ? "warning" : "info"}
          data-testid="kb-auth-issue"
          action={
            <Stack direction="row" spacing={1}>
              {/* 过期多半是「这张票废了」，但换票也可能只是刚才网络抖了一下 —— 给条退路 */}
              {expired && (
                <Button
                  size="small"
                  data-testid="kb-auth-retry"
                  onClick={() => client && void loadOrgs(client)}
                >
                  重试
                </Button>
              )}
              <Button size="small" onClick={() => navigate(ROUTES.auth)}>
                去登录
              </Button>
            </Stack>
          }
        >
          {expired
            ? `${KB_SESSION_EXPIRED}。access token 有效期 30 分钟，过期不会把你登出，但界面手上这张票已经不能用了。`
            : `${KB_LOGIN_REQUIRED}。知识库是云端资源：资料的存取与可见范围都在服务端判定。`}
        </Alert>
      </Box>
    );
  }

  const hasKb = activeKb !== null;
  const needKbHint = "先在左侧选一个知识库";

  /** 「+」菜单：未开放项灰掉并写明原因（点了没反应会被读成「卡了」） */
  const addItems: KbMenuItem[] = [
    ...(hasKb
      ? []
      : [
          {
            key: "new-kb",
            group: "新建知识",
            label: "知识库",
            hint: "建在当前团队下",
            icon: <AddIcon fontSize="small" />,
            onSelect: () => openCreateKb(),
          } satisfies KbMenuItem,
        ]),
    {
      key: "new-doc",
      group: "新建知识",
      label: "文档",
      hint: hasKb ? "粘贴纯文本入库" : needKbHint,
      disabled: !hasKb,
      icon: <ArticleOutlinedIcon fontSize="small" />,
      onSelect: () => setDocDialogOpen(true),
    },
    {
      key: "new-sheet",
      group: "新建知识",
      label: "智能表格",
      hint: "暂未支持",
      disabled: true,
      icon: <GridOnOutlinedIcon fontSize="small" />,
    },
    {
      key: "new-folder",
      group: "新建知识",
      label: "文件夹",
      hint: "暂未支持（知识库是扁平结构）",
      disabled: true,
      icon: <FolderOutlinedIcon fontSize="small" />,
    },
    {
      key: "upload-file",
      group: "从本地上传",
      label: "文件",
      hint: hasKb ? "Word / PDF / Excel / PPT / 文本" : needKbHint,
      disabled: !hasKb,
      icon: <UploadFileOutlinedIcon fontSize="small" />,
      onSelect: () => fileInputRef.current?.click(),
    },
    {
      key: "upload-folder",
      group: "从本地上传",
      label: "文件夹",
      hint: "暂未支持（一次一个文件）",
      disabled: true,
      icon: <FolderOutlinedIcon fontSize="small" />,
    },
    {
      key: "upload-html",
      group: "从本地上传",
      label: "HTML",
      hint: "暂未支持（另存为 .txt / .md 再传）",
      disabled: true,
      icon: <CodeOutlinedIcon fontSize="small" />,
    },
    {
      key: "import-mp",
      group: "从其他平台导入",
      label: "公众号文章",
      hint: "暂未支持（需要公众号抓取）",
      disabled: true,
      icon: <ChatBubbleOutlineIcon fontSize="small" />,
    },
  ];

  const moreItems: KbMenuItem[] = [
    {
      key: "members",
      group: "团队",
      label: hasKb ? "成员与权限" : "团队成员与权限",
      hint: hasKb ? "谁可以看这本库" : "管理团队里的人和角色",
      onSelect: () => (hasKb && activeKb ? openScope(activeKb) : setMembersOpen(true)),
    },
    {
      key: "departments",
      group: "团队",
      label: "团队管理",
      hint: "部门树与部门负责人",
      disabled: activeOrgId === "",
      onSelect: () => setDeptOpen(true),
    },
    {
      key: "refresh",
      group: "团队",
      label: "刷新",
      icon: <RefreshIcon fontSize="small" />,
      onSelect: refreshAll,
    },
  ];

  return (
    <Box sx={{ display: "flex", height: "100%", minHeight: 0, bgcolor: "background.default" }}>
      <KnowledgeSidebar
        orgs={orgs}
        kbsByOrg={kbsByOrg}
        activeOrgId={activeOrgId}
        activeKbId={activeKbId}
        onSelectTeam={selectTeam}
        onSelectKb={selectKb}
        onCreateTeam={() => setTeamDialogOpen(true)}
        onCreateKb={(orgId) => openCreateKb(orgId)}
      />

      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          bgcolor: "background.paper",
          borderTopLeftRadius: 10,
          overflow: "hidden",
        }}
      >
        {orgsError !== "" && (
          <Alert
            severity="error"
            data-testid="kb-error"
            sx={{ m: 2, mb: 0 }}
            action={<Button onClick={() => client && void loadOrgs(client)}>重试</Button>}
          >
            {orgsError}
            {orgsOffline && (
              <Typography sx={{ fontSize: 12, mt: 0.5, color: "text.secondary" }}>
                {KB_OFFLINE_HINT}
              </Typography>
            )}
          </Alert>
        )}

        {orgsLoading && orgs.length === 0 && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 2.5 }}>
            <CircularProgress size={14} />
            <Typography variant="caption" color="text.secondary">
              正在读取团队…
            </Typography>
          </Stack>
        )}

        {/* 没有任何组织：说明白 + 给创建入口（不假装「加载中」） */}
        {!orgsLoading && orgsError === "" && orgs.length === 0 && (
          <Box sx={{ p: 3 }}>
            <Paper variant="outlined" sx={{ p: 2.5, maxWidth: 520 }}>
              <Typography sx={{ fontSize: 13.5, mb: 1.5 }}>
                你还没有加入任何团队。知识库挂在团队下，先建一个（你成为所有者），
                或让管理员把你加进去。
              </Typography>
              <Stack direction="row" spacing={1}>
                <InputBase
                  placeholder="团队名称"
                  value={newOrgName}
                  onChange={(event) => setNewOrgName(event.target.value)}
                  inputProps={{ "data-testid": "new-org-name" }}
                  sx={{
                    flex: 1,
                    px: 1.25,
                    py: 0.5,
                    fontSize: 13,
                    borderRadius: 1.5,
                    border: "1px solid",
                    borderColor: "divider",
                  }}
                />
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<AddIcon />}
                  disabled={!client || !newOrgName.trim()}
                  onClick={() => void handleCreateOrg()}
                >
                  创建团队
                </Button>
              </Stack>
            </Paper>
          </Box>
        )}

        {activeOrg !== null && (
          <>
            <KnowledgeHeader
              variant={hasKb ? "kb" : "team"}
              title={hasKb && activeKb ? activeKb.name : activeOrg.name}
              subtitle={
                <HeaderSubtitle>
                  {hasKb && activeKb
                    ? describeKb(activeKb)
                    : `${KB_ROLE_LABELS[activeOrg.role] ?? activeOrg.role} · ${activeOrg.memberCount} 人 · ${kbs.length} 个知识库`}
                </HeaderSubtitle>
              }
              addItems={addItems}
              moreItems={moreItems}
              primary={
                hasKb ? (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<UploadFileOutlinedIcon />}
                    disabled={uploading}
                    data-testid="kb-upload-file"
                    onClick={() => fileInputRef.current?.click()}
                    sx={{ ml: 1, flexShrink: 0 }}
                  >
                    {uploading ? "上传中…" : "上传文件"}
                  </Button>
                ) : (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<AddIcon />}
                    data-testid="kb-header-create"
                    onClick={() => openCreateKb()}
                    sx={{ ml: 1, flexShrink: 0 }}
                  >
                    新建知识库
                  </Button>
                )
              }
            />

            <Divider />

            {kbsError !== "" && (
              <Typography sx={{ px: 2.5, py: 1, fontSize: 12.5, color: "error.main" }}>
                {kbsError}
              </Typography>
            )}

            {hasKb && activeKb ? (
              <KnowledgeDocList
                docs={docs}
                loading={docsLoading}
                error={docsError}
                trashOpen={trashOpen}
                onToggleTrash={() => setTrashOpen((previous) => !previous)}
                view={view}
                onViewChange={setView}
                indexHint={indexHintFor}
                retrieval={{
                  caption: caption.text,
                  warning: caption.warning,
                  canReindex,
                  reindexing,
                  onReindex: () => void handleReindex(),
                }}
                search={{
                  query,
                  onQueryChange: setQuery,
                  onSubmit: () => void handleSearch(),
                  searching,
                  error: searchError,
                  hits,
                  lexicalOnly: retrieval === null || retrieval.embedder === "off",
                }}
                actions={{
                  onRename: openRename,
                  onDelete: setDeleteTarget,
                  onRestore: (doc) => void handleRestore(doc),
                  onPurge: setPurgeTarget,
                }}
                emptyHint={
                  trashOpen ? "回收站是空的。" : "这个知识库还没有文档。用右上角「上传文件」加一篇。"
                }
              />
            ) : (
              <KnowledgeTeamPanel
                kbs={kbs}
                loading={kbsLoading}
                error=""
                describe={describeKb}
                onOpenKb={(kbId) => selectKb(activeOrgId, kbId)}
                onCreateKb={() => openCreateKb()}
              />
            )}
          </>
        )}

        {/* 组织存在但还没选到库时，若正在加载库列表，给一行进度 */}
        {activeOrg !== null && !hasKb && kbsLoading && kbs.length === 0 && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 2.5, pb: 1 }}>
            <CircularProgress size={12} />
            <Typography variant="caption" color="text.secondary">
              正在读取知识库…
            </Typography>
          </Stack>
        )}
      </Box>

      {/* 唯一的文件选择框：菜单项与「上传文件」都点它（value 清空见 handleFileUpload） */}
      <input
        ref={fileInputRef}
        type="file"
        hidden
        accept={KB_UPLOAD_ACCEPT}
        data-testid="kb-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // 清空：否则再选同一个文件不会触发 onChange（浏览器认为值没变）
          event.target.value = "";
          if (file) void handleFileUpload(file);
        }}
      />

      <CreateTeamDialog
        open={teamDialogOpen}
        busy={teamBusy}
        onClose={() => setTeamDialogOpen(false)}
        onSubmit={(input) => void handleCreateTeam(input)}
      />

      <CreateKbDialog
        open={kbDialogOpen}
        busy={kbBusy}
        teamName={orgs.find((org) => org.id === newKbOrgId)?.name ?? ""}
        name={newKbName}
        onNameChange={setNewKbName}
        description={newKbDescription}
        onDescriptionChange={setNewKbDescription}
        roles={newKbRoles}
        onToggleRole={toggleRole}
        deptIds={newKbDeptIds}
        onToggleDept={toggleNewKbDept}
        departments={departments}
        onClose={() => setKbDialogOpen(false)}
        onSubmit={() => void handleCreateKb()}
      />

      <NewDocDialog
        open={docDialogOpen}
        busy={rowBusy}
        kbName={activeKb?.name ?? ""}
        title={docTitle}
        content={docContent}
        onTitleChange={setDocTitle}
        onContentChange={setDocContent}
        onClose={() => setDocDialogOpen(false)}
        onSubmit={() => void handleUpload()}
      />

      <RenameDocDialog
        target={renameTarget}
        value={renameValue}
        busy={rowBusy}
        onChange={setRenameValue}
        onClose={() => setRenameTarget(null)}
        onConfirm={() => void handleRename()}
      />

      <DeleteDocDialog
        target={deleteTarget}
        busy={rowBusy}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDeleteDoc()}
      />

      <PurgeDocDialog
        target={purgeTarget}
        busy={rowBusy}
        onClose={() => setPurgeTarget(null)}
        onConfirm={() => void handlePurge()}
      />

      <VisibilityDialog
        target={scopeKb}
        busy={rowBusy}
        roles={scopeRoles}
        onToggleRole={(role) =>
          setScopeRoles((previous) =>
            previous.includes(role)
              ? previous.filter((item) => item !== role)
              : [...previous, role],
          )
        }
        deptIds={scopeDeptIds}
        onToggleDept={(id) =>
          setScopeDeptIds((previous) =>
            previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
          )
        }
        departments={departments}
        onClose={() => setScopeKb(null)}
        onSave={() => void handleSaveScope()}
      />

      <TeamMembersDialog
        open={membersOpen}
        orgId={activeOrgId}
        teamName={activeOrg?.name ?? ""}
        gateway={client}
        onClose={() => setMembersOpen(false)}
        onChanged={() => {
          if (client) void loadKbs(client, orgs);
        }}
      />

      <DepartmentDialog
        open={deptOpen}
        orgId={activeOrgId}
        gateway={client}
        onClose={() => setDeptOpen(false)}
        onChanged={() => {
          if (client) void loadDepartments(client, activeOrgId);
        }}
      />
    </Box>
  );
}
