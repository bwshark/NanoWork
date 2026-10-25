import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import SearchIcon from "@mui/icons-material/Search";
import AddIcon from "@mui/icons-material/Add";
import TuneIcon from "@mui/icons-material/Tune";
import RestoreFromTrashIcon from "@mui/icons-material/RestoreFromTrash";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import { ROUTES } from "@/lib/core/constants";
import { toast } from "@/components/Toast";
import {
  KB_DUPLICATE_STATUS,
  KB_LOGIN_REQUIRED,
  KB_OFFLINE_HINT,
  KB_ROLE_LABELS,
  KB_SESSION_EXPIRED,
  type KbApiResult,
  type KbDocument,
  type KbGateway,
  type KbOrg,
  type KbDepartment,
  type KbRetrievalInfo,
  type KbSearchHit,
  type KbSummary,
} from "@/lib/kb/kbClient";
import { describeRetrieval } from "@/lib/kb/kbRetrievalCaption";
import { DepartmentDialog } from "@/components/knowledge/DepartmentDialog";
import { KB_UPLOAD_ACCEPT, kindLabel, precheckUpload } from "@/lib/kb/kbUpload";
import { readFileAsBase64 } from "@/lib/artifact/fileBase64";
import { createRuntimeKbGateway } from "@/sync/kbGateway";
import { useSyncRuntime } from "@/sync/useSyncRuntime";

/**
 * 知识库（M7 客户端）：组织 → 知识库 → 文档 / 检索。
 *
 * ## 三条设计取舍
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

  const [orgs, setOrgs] = useState<KbOrg[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string>("");
  const [orgsError, setOrgsError] = useState("");
  // status=0 = 根本没连上（服务没起 / 地址错）。与 403/404 分开：那两种是业务语义，
  // 给它们贴「请启动服务」只会误导。
  const [orgsOffline, setOrgsOffline] = useState(false);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");

  const [kbs, setKbs] = useState<KbSummary[]>([]);
  const [activeKbId, setActiveKbId] = useState<string>("");
  // 检索能力 + 索引覆盖率：说明文字按它渲染（原来写死「词法检索」，开了向量就说谎）
  const [retrieval, setRetrieval] = useState<KbRetrievalInfo | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [uploading, setUploading] = useState(false);
  // 部门树：既用于「仅限部门」的选项，也用于列表里把范围显示成人话
  const [departments, setDepartments] = useState<KbDepartment[]>([]);
  const [newKbDeptIds, setNewKbDeptIds] = useState<string[]>([]);
  const [deptOpen, setDeptOpen] = useState(false);
  const [kbsError, setKbsError] = useState("");
  const [kbsLoading, setKbsLoading] = useState(false);
  const [newKbName, setNewKbName] = useState("");
  const [newKbRoles, setNewKbRoles] = useState<string[]>([...ALL_ROLES]);

  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [docsError, setDocsError] = useState("");
  const [docsLoading, setDocsLoading] = useState(false);
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");
  // 改名 / 删除都要先确认：目标文档 + 改名时正在编辑的标题。
  // 用两个独立状态而不是一个 `{ doc, mode }`：两个弹窗的打开条件互斥，
  // 合成一个对象会让「关掉其中一个」把另一个也顺手关掉。
  const [renameTarget, setRenameTarget] = useState<KbDocument | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<KbDocument | null>(null);
  /** 回收站视图：看的是"删过的"，与正常列表互斥（服务端也是两个口径） */
  const [trashOpen, setTrashOpen] = useState(false);
  /** 彻底删除的目标：与「删除」分开一个弹窗，因为两者的后果不一样 */
  const [purgeTarget, setPurgeTarget] = useState<KbDocument | null>(null);
  /** 改可见范围的目标库（null = 弹窗关着） */
  const [scopeKb, setScopeKb] = useState<KbSummary | null>(null);
  const [scopeRoles, setScopeRoles] = useState<string[]>([]);
  const [scopeDeptIds, setScopeDeptIds] = useState<string[]>([]);
  const [rowBusy, setRowBusy] = useState(false);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KbSearchHit[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searching, setSearching] = useState(false);

  const activeOrg = useMemo(() => orgs.find((org) => org.id === activeOrgId) ?? null, [orgs, activeOrgId]);
  const activeKb = useMemo(() => kbs.find((kb) => kb.id === activeKbId) ?? null, [kbs, activeKbId]);

  const loadOrgs = useCallback(
    async (target: KbGateway) => {
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
      // 只在「当前选择失效」时改选中项：否则每次刷新都会把用户踢回第一个组织
      setActiveOrgId((prev) =>
        result.data.some((org) => org.id === prev) ? prev : result.data[0]?.id ?? "",
      );
    },
    [],
  );

  useEffect(() => {
    if (client) void loadOrgs(client);
  }, [client, loadOrgs]);

  const loadKbs = useCallback(async (target: KbGateway, orgId: string) => {
    if (!orgId) {
      setKbs([]);
      setActiveKbId("");
      return;
    }
    setKbsLoading(true);
    setKbsError("");
    const result = await target.listKbs(orgId);
    setKbsLoading(false);
    if (!result.ok) {
      setKbs([]);
      setKbsError(result.message);
      return;
    }
    setKbs(result.data);
    setActiveKbId((prev) =>
      result.data.some((kb) => kb.id === prev) ? prev : result.data[0]?.id ?? "",
    );
  }, []);

  useEffect(() => {
    if (client) void loadKbs(client, activeOrgId);
  }, [client, activeOrgId, loadKbs]);

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
   * 读检索状态。**失败不报错、只保留上一次**：它是说明文字的数据源，
   * 拿不到时就退回「不猜引擎」的中性文案，不该因为一个附加信息把整页打成错误态。
   */
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
   * 而实际情况是"设了但部门已被删"（这种情况删部门时会被服务端拦住，理论上不该出现）。
   */
  const kbSecondary = (kb: KbSummary): string => {
    const parts = [`${kb.documentCount} 篇`, `${roleLabels(kb.allowedRoles)}可见`];
    const ids = kb.allowedDepartments ?? [];
    if (ids.length > 0) {
      const names = ids.map((id) => departments.find((item) => item.id === id)?.name ?? id);
      parts.push(`仅 ${names.join("、")}`);
    }
    return parts.join(" · ");
  };

  /**
   * 文档副标题：`PDF · 1234 字 · 5 块`。
   *
   * 格式显示出来是有用的：同一份资料传成 .docx 还是粘贴纯文本，出问题时的排查
   * 路径完全不同（前者可能丢表格结构，后者可能是复制时带了奇怪换行）。
   */
  const docSecondary = (doc: KbDocument): string =>
    `${kindLabel(doc.kind)} · ${doc.chars} 字 · ${doc.chunkCount} 块`;

  /**
   * 「这篇有没有建索引」只在**缺**的时候说。
   *
   * 没索引的文档搜不到，而它在列表里和正常文档长得一样 —— 那正是
   * 「我明明传了，它就是搜不到」最常见的来源。反过来，正常文档不必挂个「已索引」，
   * 那只是噪音。
   */
  const docIndexHint = (doc: KbDocument): string => {
    if (retrieval === null || retrieval.embedder === "off") return "";
    const indexed = doc.embedded ?? 0;
    if (doc.chunkCount === 0 || indexed >= doc.chunkCount) return "";
    return indexed === 0 ? "未建索引" : `索引 ${indexed}/${doc.chunkCount}`;
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

  const handleCreateKb = async () => {
    if (!client || !activeOrgId || !newKbName.trim()) return;
    if (newKbRoles.length === 0) {
      toast.error("至少要选一个可见角色");
      return;
    }
    const result = await client.createKb(activeOrgId, {
      name: newKbName.trim(),
      allowedRoles: newKbRoles,
      // 空数组与"不传"在服务端语义不同：不传 = 不动；建库时两者等价，
      // 但显式只在非空时下发，避免把「没选」写成一个刻意的收窄
      ...(newKbDeptIds.length > 0 ? { allowedDepartments: newKbDeptIds } : {}),
    });
    if (!result.ok) {
      toast.error(errorText(result));
      return;
    }
    setNewKbName("");
    setNewKbRoles([...ALL_ROLES]);
    setNewKbDeptIds([]);
    toast.success(`已创建知识库「${result.data.name}」`);
    await loadKbs(client, activeOrgId);
  };

  const handleUpload = async () => {
    if (!client || !activeKbId || !docTitle.trim() || !docContent.trim()) return;
    const result = await client.uploadDocument(activeKbId, {
      title: docTitle.trim(),
      content: docContent,
    });
    if (!result.ok) {
      toastIngestFailure(result);
      return;
    }
    setDocTitle("");
    setDocContent("");
    toast.success(`已入库：${result.data.chunkCount} 块`);
    await loadDocs(client, activeKbId);
    await loadKbs(client, activeOrgId);
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
    await loadKbs(client, activeOrgId);
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
    await loadKbs(client, activeOrgId);
    await loadRetrieval(client, activeKbId);
  };

  /**
   * 彻底删除：**独立的确认弹窗**。
   *
   * 与「删除」分开是刻意的：删除只是进回收站（可恢复），彻底删除不可撤销。
   * 两者共用同一个弹窗，用户会以为"反正能恢复"，然后点错 —— 那是这一屏里
   * 唯一一个真正不可逆的操作。
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
    await loadKbs(client, activeOrgId);
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
    await loadKbs(client, activeOrgId);
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

  return (
    <Box sx={{ p: 2.5, height: "100%", display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      {/* 标题栏 */}
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Box minWidth={0}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            知识库
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography
              variant="caption"
              color={caption.warning ? "warning.main" : "text.secondary"}
              data-testid="kb-caption"
            >
              {caption.text}
            </Typography>
            {/* 只在「引擎开着但还有块没索引」时出现：其余时候这个按钮点了也没意义 */}
            {canReindex && (
              <Button
                size="small"
                data-testid="kb-reindex"
                disabled={reindexing}
                onClick={() => void handleReindex()}
              >
                {reindexing ? "重建中…" : "重建索引"}
              </Button>
            )}
          </Stack>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          {orgs.length > 0 && (
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel>组织</InputLabel>
              <Select
                label="组织"
                value={activeOrgId}
                onChange={(event) => {
                  setActiveOrgId(event.target.value);
                  setHits(null);
                  setSearchError("");
                }}
              >
                {orgs.map((org) => (
                  <MenuItem key={org.id} value={org.id}>
                    {org.name}（{KB_ROLE_LABELS[org.role] ?? org.role}）
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <Button
            size="small"
            data-testid="kb-open-departments"
            disabled={!client || !activeOrgId}
            onClick={() => setDeptOpen(true)}
          >
            部门
          </Button>
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            disabled={!client || orgsLoading}
            onClick={() => {
              if (!client) return;
              void loadOrgs(client);
              void loadKbs(client, activeOrgId);
              void loadDocs(client, activeKbId);
            }}
          >
            刷新
          </Button>
        </Stack>
      </Stack>

      {orgsError && (
        <Alert
          severity="error"
          action={<Button onClick={() => client && void loadOrgs(client)}>重试</Button>}
          data-testid="kb-error"
        >
          {orgsError}
          {orgsOffline && (
            <Typography sx={{ fontSize: 12, mt: 0.5, color: "text.secondary" }}>
              {KB_OFFLINE_HINT}
            </Typography>
          )}
        </Alert>
      )}

      {/* 没有任何组织：说明白 + 给创建入口（不假装「加载中」） */}
      {!orgsLoading && !orgsError && orgs.length === 0 && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography sx={{ fontSize: 13.5, mb: 1 }}>
            你还没有加入任何组织。知识库挂在组织下，先建一个（你成为所有者），或让管理员把你加进去。
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              label="组织名称"
              value={newOrgName}
              onChange={(event) => setNewOrgName(event.target.value)}
              inputProps={{ "data-testid": "new-org-name" }}
            />
            <Button
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              disabled={!client || !newOrgName.trim()}
              onClick={() => void handleCreateOrg()}
            >
              创建组织
            </Button>
          </Stack>
        </Paper>
      )}

      {orgsLoading && (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size={14} />
          <Typography variant="caption" color="text.secondary">
            正在读取组织…
          </Typography>
        </Stack>
      )}

      {activeOrg && (
        <Stack direction="row" spacing={2} sx={{ flex: 1, minHeight: 0 }}>
          {/* 左：知识库列表 */}
          <Paper
            variant="outlined"
            sx={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}
          >
            <Box sx={{ p: 1.5 }}>
              <Typography sx={{ fontSize: 13.5, fontWeight: 600, mb: 1 }}>知识库</Typography>
              <Stack direction="row" spacing={1}>
                <TextField
                  size="small"
                  placeholder="新建知识库"
                  value={newKbName}
                  onChange={(event) => setNewKbName(event.target.value)}
                  inputProps={{ "data-testid": "new-kb-name" }}
                  fullWidth
                />
                <Button
                  size="small"
                  variant="outlined"
                  disabled={!newKbName.trim()}
                  onClick={() => void handleCreateKb()}
                  sx={{ flexShrink: 0 }}
                >
                  建
                </Button>
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                {ALL_ROLES.map((role) => (
                  <FormControlLabel
                    key={role}
                    control={
                      <Checkbox
                        size="small"
                        checked={newKbRoles.includes(role)}
                        onChange={(_event, checked) =>
                          setNewKbRoles((prev) =>
                            checked ? [...prev, role] : prev.filter((item) => item !== role),
                          )
                        }
                      />
                    }
                    label={<Typography sx={{ fontSize: 12 }}>{KB_ROLE_LABELS[role]}可见</Typography>}
                  />
                ))}
              </Stack>
              {/* 部门范围（FR-4.7「按部门/角色设访问范围」的后半句）。
                  用可点选的 Chip 而不是下拉框：部门通常只有几个，点两下比
                  「打开菜单 → 勾选 → 关闭」快，也不用处理多选下拉的交互细节。
                  只有组织建过部门才出现——没部门时给一个空控件只会让人困惑。 */}
              {departments.length > 0 && (
                <Stack
                  direction="row"
                  spacing={0.75}
                  alignItems="center"
                  flexWrap="wrap"
                  useFlexGap
                  sx={{ mt: 1 }}
                >
                  <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                    仅限部门
                  </Typography>
                  {departments.map((item) => {
                    const selected = newKbDeptIds.includes(item.id);
                    return (
                      <Chip
                        key={item.id}
                        size="small"
                        label={item.name}
                        data-testid={`new-kb-dept-${item.id}`}
                        color={selected ? "primary" : "default"}
                        variant={selected ? "filled" : "outlined"}
                        onClick={() =>
                          setNewKbDeptIds((previous) =>
                            previous.includes(item.id)
                              ? previous.filter((id) => id !== item.id)
                              : [...previous, item.id],
                          )
                        }
                      />
                    );
                  })}
                  <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
                    {newKbDeptIds.length === 0
                      ? "不选 = 角色能看就能看"
                      : "普通成员还需属于这些部门（含子部门）"}
                  </Typography>
                </Stack>
              )}
            </Box>
            <Divider />
            {kbsError && (
              <Alert severity="error" sx={{ m: 1 }}>
                {kbsError}
              </Alert>
            )}
            <List dense sx={{ overflowY: "auto", flex: 1 }}>
              {kbs.map((kb) => (
                <ListItem
                  key={kb.id}
                  disablePadding
                  // 范围入口放在行尾：它是"改这个库对谁可见"，属于库级设置，
                  // 不是"进这个库"的一部分——混在正文点击里会误触。
                  secondaryAction={
                    <IconButton
                      size="small"
                      edge="end"
                      aria-label={`设置 ${kb.name} 的可见范围`}
                      data-testid={`kb-scope-${kb.id}`}
                      onClick={() => openScope(kb)}
                    >
                      <TuneIcon fontSize="small" />
                    </IconButton>
                  }
                >
                  <ListItemButton
                    selected={kb.id === activeKbId}
                    onClick={() => {
                      setActiveKbId(kb.id);
                      setHits(null);
                      setSearchError("");
                      setTrashOpen(false);
                    }}
                  >
                    <ListItemText
                      primary={kb.name}
                      secondary={kbSecondary(kb)}
                      primaryTypographyProps={{ fontSize: 13.5 }}
                    />
                  </ListItemButton>
                </ListItem>
              ))}
              {!kbsLoading && kbs.length === 0 && !kbsError && (
                <Typography sx={{ fontSize: 12, color: "text.secondary", p: 2 }}>
                  这个组织下还没有你能看到的知识库。
                </Typography>
              )}
            </List>
          </Paper>

          {/* 右：选中库的文档 / 上传 / 检索 */}
          <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  size="small"
                  label="在组织内检索"
                  placeholder="例如：报销流程"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleSearch();
                  }}
                  inputProps={{ "data-testid": "kb-query" }}
                  sx={{ flex: 1 }}
                />
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<SearchIcon />}
                  disabled={searching || !query.trim()}
                  onClick={() => void handleSearch()}
                >
                  检索
                </Button>
              </Stack>
              {searchError && (
                <Alert severity="error" sx={{ mt: 1 }}>
                  {searchError}
                </Alert>
              )}
              {hits !== null && !searchError && (
                <Box sx={{ mt: 1 }} data-testid="kb-hits">
                  {hits.length === 0 ? (
                    <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                      没有命中。换个关键词试试（当前是词法匹配，同义词不会命中）。
                    </Typography>
                  ) : (
                    <Stack spacing={1}>
                      {hits.map((hit) => (
                        <Paper key={hit.chunkId} variant="outlined" sx={{ p: 1.25 }}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{hit.docTitle}</Typography>
                            <Chip size="small" variant="outlined" label={hit.score.toFixed(3)} />
                          </Stack>
                          <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: 0.5 }}>
                            {hit.snippet}
                          </Typography>
                        </Paper>
                      ))}
                    </Stack>
                  )}
                </Box>
              )}
            </Paper>

            <Paper variant="outlined" sx={{ p: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
              <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>
                {activeKb ? `上传到「${activeKb.name}」` : "上传文档"}
              </Typography>
              <Stack direction="row" spacing={1}>
                <TextField
                  size="small"
                  label="标题"
                  value={docTitle}
                  onChange={(event) => setDocTitle(event.target.value)}
                  inputProps={{ "data-testid": "doc-title" }}
                  sx={{ width: 240 }}
                />
                <Button
                  size="small"
                  variant="contained"
                  disabled={!activeKbId || !docTitle.trim() || !docContent.trim()}
                  onClick={() => void handleUpload()}
                >
                  入库
                </Button>
              </Stack>
              {/* 文件上传：改成「选文件」而不是「粘贴」是这一步的实际价值——
                  真实资料都在 .docx / .pdf 里，要求用户先复制成纯文本等于没这个功能。 */}
              <Stack direction="row" spacing={1} alignItems="center">
                <Button
                  component="label"
                  size="small"
                  variant="outlined"
                  disabled={!activeKbId || uploading}
                  data-testid="kb-upload-file"
                >
                  {uploading ? "上传中…" : "上传文件"}
                  <input
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
                </Button>
                <Typography variant="caption" color="text.secondary">
                  支持 {KB_UPLOAD_ACCEPT.split(",").join(" / ")}（单文件 8MB；PDF 需服务端装 pypdf）
                </Typography>
              </Stack>
              <TextField
                size="small"
                label="正文（纯文本，按空行分段；单篇上限 20 万字符）"
                value={docContent}
                onChange={(event) => setDocContent(event.target.value)}
                inputProps={{ "data-testid": "doc-content" }}
                multiline
                minRows={3}
                maxRows={6}
              />
              <Typography variant="caption" color="text.secondary">
                正文会被切成若干块入库，只有块参与检索。也可以直接上传 .docx / .pdf ——
                服务端会先解析成文本再切块；解析失败会说明原因（旧版 .doc 需要另存为新格式）。
                同一个库里重复入库相同内容会被拦下（提示已在库里的那一篇）。
              </Typography>
            </Paper>

            <Paper variant="outlined" sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {/* 回收站是**独立视图**，不是一个过滤器：默认列表只有活文档，
                  这里换成"只看删过的"。两个口径都由服务端给，前端不合并。 */}
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ px: 2, pt: 1.5, pb: 0.5 }}
              >
                <Button
                  size="small"
                  variant={trashOpen ? "contained" : "text"}
                  startIcon={<RestoreFromTrashIcon />}
                  data-testid="kb-trash-toggle"
                  disabled={!activeKbId}
                  onClick={() => setTrashOpen((previous) => !previous)}
                >
                  {trashOpen ? "返回文档" : "回收站"}
                </Button>
                {trashOpen && (
                  <Typography variant="caption" color="text.secondary">
                    回收站里的资料不参与检索；保留 30 天，过期自动清理
                  </Typography>
                )}
              </Stack>
              {docsError && (
                <Alert severity="error" sx={{ m: 1 }}>
                  {docsError}
                </Alert>
              )}
              <List dense>
                {docs.map((doc) => {
                  const hint = docIndexHint(doc);
                  return (
                    <ListItem
                      key={doc.id}
                      divider
                      secondaryAction={
                        trashOpen ? (
                          <Stack direction="row" spacing={0.25}>
                            <IconButton
                              size="small"
                              aria-label={`恢复 ${doc.title}`}
                              data-testid={`kb-doc-restore-${doc.id}`}
                              onClick={() => void handleRestore(doc)}
                            >
                              <RestoreFromTrashIcon fontSize="small" />
                            </IconButton>
                            <IconButton
                              size="small"
                              edge="end"
                              aria-label={`彻底删除 ${doc.title}`}
                              data-testid={`kb-doc-purge-${doc.id}`}
                              onClick={() => setPurgeTarget(doc)}
                            >
                              <DeleteForeverIcon fontSize="small" />
                            </IconButton>
                          </Stack>
                        ) : (
                          <Stack direction="row" spacing={0.25}>
                            <IconButton
                              size="small"
                              aria-label={`重命名 ${doc.title}`}
                              data-testid={`kb-doc-rename-${doc.id}`}
                              onClick={() => openRename(doc)}
                            >
                              <EditOutlinedIcon fontSize="small" />
                            </IconButton>
                            <IconButton
                              size="small"
                              edge="end"
                              aria-label={`删除 ${doc.title}`}
                              data-testid={`kb-doc-delete-${doc.id}`}
                              onClick={() => setDeleteTarget(doc)}
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Stack>
                        )
                      }
                    >
                      <ListItemText
                        primary={doc.title}
                        secondary={
                          <Stack direction="row" spacing={1} alignItems="center">
                            <span>{docSecondary(doc)}</span>
                            {hint !== "" && (
                              <Chip
                                size="small"
                                color="warning"
                                variant="outlined"
                                label={hint}
                                data-testid={`kb-doc-index-${doc.id}`}
                                sx={{ height: 18, fontSize: 11 }}
                              />
                            )}
                          </Stack>
                        }
                        primaryTypographyProps={{ fontSize: 13 }}
                        secondaryTypographyProps={{ component: "div" }}
                      />
                    </ListItem>
                  );
                })}
                {!docsLoading && docs.length === 0 && !docsError && (
                  <Typography sx={{ fontSize: 12, color: "text.secondary", p: 2 }}>
                    {!activeKbId
                      ? "先在左侧选一个知识库。"
                      : trashOpen
                        ? "回收站是空的。"
                        : "这个知识库还没有文档。"}
                  </Typography>
                )}
              </List>
            </Paper>
          </Box>
        </Stack>
      )}

      {/* 彻底删除：不可撤销，所以文案要说明"和进回收站不是一回事" */}
      <Dialog
        open={purgeTarget !== null}
        onClose={() => setPurgeTarget(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle sx={{ fontSize: 16 }}>彻底删除「{purgeTarget?.title}」？</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 13 }}>
            分块与向量索引会被清空，**无法恢复**，只能重新上传。
            只想暂时移除的话，右上角返回文档列表后点删除即可（那会进回收站）。
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setPurgeTarget(null)}>
            取消
          </Button>
          <Button
            size="small"
            color="error"
            variant="contained"
            disabled={rowBusy}
            data-testid="kb-purge-confirm"
            onClick={() => void handlePurge()}
          >
            彻底删除
          </Button>
        </DialogActions>
      </Dialog>

      {/* 改名：内容不动，所以这里只开一个输入框。判重会让「换个标题重传」变成 409，
          所以标题必须能单独改 —— 否则改错标题只能删了重传。 */}
      <Dialog open={renameTarget !== null} onClose={() => setRenameTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ fontSize: 16 }}>重命名文档</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="标题"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            inputProps={{ "data-testid": "kb-rename-input" }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setRenameTarget(null)}>
            取消
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={rowBusy || renameValue.trim() === ""}
            data-testid="kb-rename-confirm"
            onClick={() => void handleRename()}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* 删除：**必须确认**。它连带块与向量一起消失，且退不回来（
          重建索引救不了，只能重新上传）。确认文案里写清这一点，而不是只问「确定吗」。 */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle sx={{ fontSize: 16 }}>删除「{deleteTarget?.title}」？</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 13 }}>
            这篇文档会进入回收站，立刻从检索结果里消失；{deleteTarget?.chunkCount ?? 0} 个分块和
            索引会保留 30 天，期间可以恢复。
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setDeleteTarget(null)}>
            取消
          </Button>
          <Button
            size="small"
            color="error"
            variant="contained"
            disabled={rowBusy}
            data-testid="kb-delete-confirm"
            onClick={() => void handleDeleteDoc()}
          >
            删除
          </Button>
        </DialogActions>
      </Dialog>

      {/* 改可见范围：角色 × 部门。这是"谁能看见"的唯一入口，所以两条都必须能改，
          而且必须显示当前值（否则用户不知道现在是收紧还是放开）。 */}
      <Dialog open={scopeKb !== null} onClose={() => setScopeKb(null)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ fontSize: 16 }}>「{scopeKb?.name}」的可见范围</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12.5, color: "text.secondary", mb: 1 }}>
            角色决定「谁有这个身份能看」，部门再收窄一层；普通成员要同时满足两者。
            管理员与所有者始终可见（否则会出现「建完自己看不见、也改不了」）。
          </Typography>
          <Typography sx={{ fontSize: 12.5, mb: 0.5 }}>可见角色</Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            {(["member", "admin", "owner"] as const).map((role) => {
              const checked = scopeRoles.includes(role);
              return (
                <Chip
                  key={role}
                  size="small"
                  label={KB_ROLE_LABELS[role]}
                  data-testid={`kb-scope-role-${role}`}
                  color={checked ? "primary" : "default"}
                  variant={checked ? "filled" : "outlined"}
                  onClick={() =>
                    setScopeRoles((previous) =>
                      previous.includes(role)
                        ? previous.filter((item) => item !== role)
                        : [...previous, role],
                    )
                  }
                />
              );
            })}
          </Stack>
          <Typography sx={{ fontSize: 12.5, mb: 0.5 }}>仅限部门（不选 = 不按部门收窄）</Typography>
          {departments.length === 0 ? (
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
              这个组织还没有部门。要按部门收窄，先点上方的「部门」建几个。
            </Typography>
          ) : (
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {departments.map((item) => {
                const checked = scopeDeptIds.includes(item.id);
                return (
                  <Chip
                    key={item.id}
                    size="small"
                    label={item.name}
                    data-testid={`kb-scope-dept-${item.id}`}
                    color={checked ? "primary" : "default"}
                    variant={checked ? "filled" : "outlined"}
                    onClick={() =>
                      setScopeDeptIds((previous) =>
                        previous.includes(item.id)
                          ? previous.filter((id) => id !== item.id)
                          : [...previous, item.id],
                      )
                    }
                  />
                );
              })}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setScopeKb(null)}>
            取消
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={rowBusy}
            data-testid="kb-scope-save"
            onClick={() => void handleSaveScope()}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

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
