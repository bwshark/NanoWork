import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ArchiveOutlinedIcon from "@mui/icons-material/ArchiveOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import GroupAddOutlinedIcon from "@mui/icons-material/GroupAddOutlined";
import LibraryAddOutlinedIcon from "@mui/icons-material/LibraryAddOutlined";
import PlaylistAddIcon from "@mui/icons-material/PlaylistAdd";
import UnarchiveOutlinedIcon from "@mui/icons-material/UnarchiveOutlined";
import { toast } from "@/components/Toast";
import { TaskFormDialog } from "@/components/tasks/TaskFormDialog";
import { useAgentsStore } from "@/stores/agentsStore";
import { ROUTES } from "@/lib/core/constants";
import type { TaskDraft } from "@/lib/task/taskDraft";
import type { Session, TaskConfig } from "@/types";
import {
  artifactsOfProject,
  sessionsOfProject,
  tasksOfProject,
} from "@/lib/project/projectScope";
import { useArtifactsStore } from "@/stores/artifactsStore";
import { useSessionsStore } from "@/stores/sessionsStore";
import { useTasksStore } from "@/stores/tasksStore";
import { KB_OFFLINE_HINT, type KbGateway, type KbOrg, type KbOrgMember, type KbSummary } from "@/lib/kb/kbClient";
import {
  PROJECT_LOGIN_REQUIRED,
  PROJECT_SESSION_EXPIRED,
  type ProjectDetail,
  type ProjectGateway,
  type ProjectSummary,
} from "@/lib/project/projectClient";
import { createRuntimeKbGateway } from "@/sync/kbGateway";
import { createRuntimeProjectGateway } from "@/sync/projectGateway";
import { useSyncRuntime } from "@/sync/useSyncRuntime";

/**
 * 项目空间页（FR-12.7 客户端）。
 *
 * 三条纪律写在这里，因为它们是这一页最容易做错的地方：
 *
 * 1. **`canManage` 只认服务端**。前端拿它决定「加人 / 加库 / 归档」这几个入口显不显示，
 *    不再自己算一遍「我是不是 lead」—— 重算就是第二套权限规则，后端一改必漏。
 * 2. **删除入口比 `canManage` 更严**：只有组织 admin/owner 才显示（服务端就是这么判的）。
 *    看着是同一个项目页，权限口径差一层是故意的。
 * 3. **看板与产物来自本机投影**（`lib/project/projectScope.ts`），不是服务端。
 *    归属是声明（`Session.projectId` / `TaskConfig.projectId` 随同步走），服务端只有
 *    `project_kbs` 一张关联表；再让服务端算一遍等于把同一件事实现两遍，必然漂移。
 *    产物的归属**派生**（产物 → 会话 → 项目），不在产物上冗余存一份 —— 否则会话
 *    移到别的项目时，产物那份快照留在原地，归属会慢慢烂掉。
 */
export function ProjectsPage({
  gateway,
  kbGateway,
}: {
  // `null` 是**明确的「未登录」**（`createRuntimeProjectGateway()` 在无票时也返回 null）；
  // `undefined` 才表示「用运行时装配」。两者分开，页面才测得出登录提示
  gateway?: ProjectGateway | null;
  kbGateway?: KbGateway | null;
}) {
  const navigate = useNavigate();
  // 登录态必须订阅：`initSyncRuntime()` 是异步的，路由可能先落到本页
  const runtime = useSyncRuntime();
  const client = useMemo<ProjectGateway | null>(
    () => (gateway !== undefined ? gateway : createRuntimeProjectGateway()),
    [gateway, runtime],
  );
  const kb = useMemo<KbGateway | null>(
    () => (kbGateway !== undefined ? kbGateway : createRuntimeKbGateway()),
    [kbGateway, runtime],
  );

  const [sessionExpired, setSessionExpired] = useState(false);
  useEffect(() => {
    setSessionExpired(false);
  }, [client]);

  const [orgs, setOrgs] = useState<KbOrg[]>([]);
  const [activeOrgId, setActiveOrgId] = useState("");
  const [orgsError, setOrgsError] = useState("");
  const [offline, setOffline] = useState(false);
  const [orgsLoading, setOrgsLoading] = useState(false);

  const [includeArchived, setIncludeArchived] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");

  const [activeId, setActiveId] = useState("");
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  /** 删除需二次点击：无对话框的确认，避免误删（删项目是硬删，成员与库关联一起清） */
  const [deleteArmed, setDeleteArmed] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [memberOpen, setMemberOpen] = useState(false);
  /** 候选只来自**本组织成员**（服务端加人时还会再校验一次，这条只是不让人盲填邮箱） */
  const [memberCandidates, setMemberCandidates] = useState<KbOrgMember[]>([]);
  const [kbOpen, setKbOpen] = useState(false);
  const [kbCandidates, setKbCandidates] = useState<KbSummary[]>([]);
  const [busy, setBusy] = useState(false);
  /** 「在项目里新建任务」：复用任务表单，只把 `projectId` 预填进去 */
  const [taskOpen, setTaskOpen] = useState(false);
  /**
   * 「把已有会话 / 任务移进来」：两个弹窗分开，因为候选来源不同
   * （会话取全部未归属项目的会话，任务取全部未归属项目的任务）。
   */
  const [moveSessionOpen, setMoveSessionOpen] = useState(false);
  const [moveTaskOpen, setMoveTaskOpen] = useState(false);

  const activeOrg = orgs.find((o) => o.id === activeOrgId);
  /** 组织角色只用来决定「删除项目」这一个入口的可见性（服务端只给 admin/owner） */
  const isOrgAdmin = activeOrg?.role === "admin" || activeOrg?.role === "owner";
  /**
   * 能不能往这个项目里添东西（会话 / 任务）。
   *
   * 口径是「项目成员 **或** 组织管理员」：`myRole` 非空 = 我是这个项目的人；
   * 组织管理员按管理豁免同款处理（与知识库的可见性口径一致 —— 否则管理员在自己
   * 建的、但没把自己加进去的项目里连一个会话都建不了）。
   */
  const canContribute = detail
    ? detail.project.myRole !== "" || isOrgAdmin
    : false;

  /*
   * 项目内的任务 / 会话 / 产物：**本机投影**（不是服务端返回的）。
   *
   * 为什么不用服务端：项目归属是本机声明的（`Session.projectId` / `TaskConfig.projectId`
   * 随同步走），服务端只存了 `project_kbs` 这一张关联表。再让服务端算一遍「这个项目
   * 有哪些会话」等于把同一件事实现两遍，而两遍必然漂移。
   *
   * 订阅 store 而不是读一次：用户在别的页面新建会话 / 跑任务，回到这里应当立刻看到。
   */
  const allSessions = useSessionsStore((s) => s.sessions);
  const allTasks = useTasksStore((s) => s.tasks);
  const artifactIndex = useArtifactsStore((s) => s.index);
  // 任务表单的默认专家：订阅而不是 getState()，否则专家列表后到时会拿不到（表单已挂载）
  const defaultAgentId = useAgentsStore((s) => s.agents[0]?.id ?? "");
  const projectSessions = useMemo(
    () => sessionsOfProject(allSessions, activeId),
    [allSessions, activeId],
  );
  const projectTasks = useMemo(
    () => tasksOfProject(allTasks, activeId),
    [allTasks, activeId],
  );
  const projectArtifacts = useMemo(
    () =>
      artifactsOfProject(
        allSessions,
        Object.values(artifactIndex ?? {}),
        activeId,
      ),
    [allSessions, artifactIndex, activeId],
  );

  const loadOrgs = useCallback(async () => {
    if (!kb) return;
    setOrgsLoading(true);
    setOffline(false);
    setOrgsError("");
    const result = await kb.listOrgs();
    setOrgsLoading(false);
    if (!result.ok) {
      if (result.status === 0) setOffline(true);
      else if (result.unauthorized) setSessionExpired(true);
      else setOrgsError(result.message);
      return;
    }
    setOrgs(result.data);
    setActiveOrgId((prev) => prev || result.data[0]?.id || "");
  }, [kb]);

  const loadProjects = useCallback(
    async (orgId: string) => {
      if (!client || !orgId) return;
      setListLoading(true);
      setListError("");
      const result = await client.listProjects(orgId, { includeArchived });
      setListLoading(false);
      if (!result.ok) {
        if (result.unauthorized) setSessionExpired(true);
        else setListError(result.message);
        setProjects([]);
        return;
      }
      setProjects(result.data);
      // 选中的项目不在新列表里（换组织 / 归档被收起）→ 清空，避免右侧显示一个「不存在」的详情
      setActiveId((prev) => (result.data.some((p) => p.id === prev) ? prev : ""));
    },
    [client, includeArchived],
  );

  const loadDetail = useCallback(
    async (projectId: string) => {
      if (!client || !projectId) return;
      setDetailLoading(true);
      setDetailError("");
      const result = await client.getProject(projectId);
      setDetailLoading(false);
      if (!result.ok) {
        if (result.unauthorized) setSessionExpired(true);
        else setDetailError(result.message);
        setDetail(null);
        return;
      }
      setDetail(result.data);
    },
    [client],
  );

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs]);

  useEffect(() => {
    if (activeOrgId) void loadProjects(activeOrgId);
  }, [activeOrgId, loadProjects]);

  useEffect(() => {
    setDetail(null);
    setDeleteArmed(false);
    if (activeId) void loadDetail(activeId);
  }, [activeId, loadDetail]);

  const refreshAll = async () => {
    if (!activeOrgId) return;
    await loadProjects(activeOrgId);
    if (activeId) await loadDetail(activeId);
  };

  const createProject = async () => {
    if (!client || !activeOrgId) return;
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    const result = await client.createProject(activeOrgId, {
      name,
      description: newDesc.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    setCreateOpen(false);
    setNewName("");
    setNewDesc("");
    toast.success("项目已创建");
    await loadProjects(activeOrgId);
    setActiveId(result.data.id);
  };

  const toggleArchive = async (project: ProjectSummary) => {
    if (!client) return;
    const archived = project.archivedAt === "";
    const result = await client.updateProject(project.id, { archived });
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(archived ? "已归档" : "已恢复");
    await refreshAll();
  };

  const removeProject = async (projectId: string) => {
    if (!client) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    const result = await client.deleteProject(projectId);
    if (!result.ok) {
      toast.error(result.message);
      setDeleteArmed(false);
      return;
    }
    setDeleteArmed(false);
    setActiveId("");
    toast.success("项目已删除");
    await loadProjects(activeOrgId);
  };

  const openMemberDialog = async () => {
    if (!kb || !activeOrgId) return;
    setMemberOpen(true);
    const result = await kb.listMembers(activeOrgId);
    if (!result.ok) {
      toast.error(result.message);
      setMemberCandidates([]);
      return;
    }
    const joined = new Set(detail?.members.map((m) => m.userId) ?? []);
    setMemberCandidates(result.data.filter((m) => !joined.has(m.userId)));
  };

  const addMember = async (email: string) => {
    if (!client || !detail) return;
    setBusy(true);
    const result = await client.addMember(detail.project.id, email);
    setBusy(false);
    if (!result.ok) {
      // 409 的两种语义（不是组织成员 / 已在项目里）都在 message 里，原样提示即可
      toast.error(result.message);
      return;
    }
    setMemberOpen(false);
    toast.success("已加入项目");
    await refreshAll();
  };

  const removeMember = async (userId: string) => {
    if (!client || !detail) return;
    const result = await client.removeMember(detail.project.id, userId);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    await refreshAll();
  };

  const openKbDialog = async () => {
    if (!kb || !activeOrgId) return;
    setKbOpen(true);
    const result = await kb.listKbs(activeOrgId);
    if (!result.ok) {
      toast.error(result.message);
      setKbCandidates([]);
      return;
    }
    // 候选取自「我可见的库」——服务端加库时还会再校验一次读权限，前端这层只是少让人白点
    const linked = new Set(detail?.kbs.map((k) => k.id) ?? []);
    setKbCandidates(result.data.filter((k) => !linked.has(k.id)));
  };

  const addKb = async (kbId: string) => {
    if (!client || !detail) return;
    const result = await client.addKb(detail.project.id, kbId);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    setKbOpen(false);
    toast.success("已加入共享库");
    await refreshAll();
  };

  const removeKb = async (kbId: string) => {
    if (!client || !detail) return;
    const result = await client.removeKb(detail.project.id, kbId);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    await refreshAll();
  };

  /**
   * 在项目里新建会话：切到聊天页并带上 `projectId`。
   *
   * 顺序刻意是「先建再跳」：`createSession` 会把新会话设为 active，聊天页打开时
   * 落在它上面 —— 若反过来先跳页再建，用户会先看到旧会话闪一下。
   */
  const createSessionInProject = () => {
    if (!activeId) return;
    useSessionsStore.getState().createSession(undefined, "新会话", {
      projectId: activeId,
    });
    navigate(ROUTES.chat);
  };

  /**
   * 在项目里新建任务。
   *
   * **`projectId` 只在这里写一次**，表单 `initial` 刻意**不带**它：
   * 两处都写的话，拆掉任意一处用例都不会红（另处在兜底）—— 看似更稳，实际让
   * 「归属从哪来」变成两个来源。表单里的 `projectId` 字段只是让用户能看见
   * 「这条会归属本项目」，落库以这里为准。
   */
  const createTaskInProject = (draft: TaskDraft) => {
    if (!activeId) return;
    const created = useTasksStore.getState().addTask({ ...draft, projectId: activeId });
    if (created) toast.success("已在项目里创建任务");
    else toast.error("创建失败（该任务可能已被删除）");
    setTaskOpen(false);
  };

  /**
   * 把已有会话 / 任务移进 / 移出项目。
   *
   * 只调 `updateSession` / `updateTask`，**不手写 `rev`**：
   * 会话的 `rev` 由 `updateSession` 内的 `withSessionSync` 比较白名单字段后自动递增，
   * 任务的由 `updateTask` 的 `metaForEdit` 递增。手写一遍就会出现「同一个改动涨两次」，
   * 而同步层会把它当成两次独立变更反复推送。
   *
   * 移出用 `undefined` 而不是空串：`undefined` 才是「不属于任何项目」，
   * 空串在 `sessionsOfProject` 里同样是假，但它会让 `SESSION_SYNC_FIELDS` 的比较
   * 把「没归属」和「归属为空」判成同一次改动之外的东西 —— 语义上不该有那个中间态。
   */
  const moveSessionIntoProject = (session: Session) => {
    if (!activeId) return;
    useSessionsStore
      .getState()
      .updateSession(session.id, (s) => ({ ...s, projectId: activeId }));
    toast.success(`已把「${session.title}」移入项目`);
    setMoveSessionOpen(false);
  };

  const moveSessionOutOfProject = (session: Session) => {
    useSessionsStore
      .getState()
      .updateSession(session.id, (s) => ({ ...s, projectId: undefined }));
    toast.success(`已把「${session.title}」移出项目`);
  };

  const moveTaskIntoProject = (task: TaskConfig) => {
    if (!activeId) return;
    useTasksStore.getState().updateTask(task.id, { projectId: activeId });
    toast.success(`已把「${task.name}」移入项目`);
    setMoveTaskOpen(false);
  };

  const moveTaskOutOfProject = (task: TaskConfig) => {
    useTasksStore.getState().updateTask(task.id, { projectId: undefined });
    toast.success(`已把「${task.name}」移出项目`);
  };

  /** 候选 = 不属于任何项目的会话（已归属别的项目的不列：跨项目搬移是另一件事） */
  const movableSessions = useMemo(
    () => allSessions.filter((s) => !s.projectId),
    [allSessions],
  );
  const movableTasks = useMemo(
    () => allTasks.filter((t) => !t.projectId && t.deletedAt == null),
    [allTasks],
  );

  if (client === null) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert
          severity="info"
          action={
            <Button color="inherit" onClick={() => navigate(ROUTES.auth)}>
              去登录
            </Button>
          }
        >
          {PROJECT_LOGIN_REQUIRED}
        </Alert>
      </Box>
    );
  }

  return (
    <Stack direction="row" spacing={2} sx={{ p: 2, height: "100%", alignItems: "stretch" }}>
      <Paper variant="outlined" sx={{ width: 280, display: "flex", flexDirection: "column" }}>
        <Stack spacing={1} sx={{ p: 1.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 500 }}>
            项目
          </Typography>
          <Select
            size="small"
            value={activeOrgId}
            displayEmpty
            onChange={(e) => {
              setActiveOrgId(e.target.value);
              setActiveId("");
            }}
          >
            {orgs.length === 0 && (
              <MenuItem value="" disabled>
                {orgsLoading ? "正在加载团队…" : "还没有团队"}
              </MenuItem>
            )}
            {orgs.map((org) => (
              <MenuItem key={org.id} value={org.id}>
                {org.name}
              </MenuItem>
            ))}
          </Select>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Button
              size="small"
              variant="contained"
              startIcon={<AddIcon />}
              disabled={!activeOrgId}
              onClick={() => setCreateOpen(true)}
            >
              新建
            </Button>
            <Chip
              size="small"
              label="含归档"
              color={includeArchived ? "primary" : "default"}
              variant={includeArchived ? "filled" : "outlined"}
              onClick={() => setIncludeArchived((v) => !v)}
            />
          </Stack>
        </Stack>
        <Divider />
        <Box sx={{ flex: 1, overflowY: "auto" }}>
          {listLoading && (
            <Stack sx={{ p: 2, alignItems: "center" }}>
              <CircularProgress size={18} />
            </Stack>
          )}
          {!listLoading && listError && (
            <Alert severity="error" sx={{ m: 1 }}>
              {listError}
            </Alert>
          )}
          {!listLoading && !listError && projects.length === 0 && (
            <Typography variant="body2" sx={{ p: 2, color: "text.secondary" }}>
              这个团队还没有项目
            </Typography>
          )}
          <List dense disablePadding>
            {projects.map((p) => (
              <ListItemButton
                key={p.id}
                selected={p.id === activeId}
                onClick={() => setActiveId(p.id)}
              >
                <ListItemText
                  primary={p.name}
                  secondary={`${p.memberCount} 人 · ${p.kbCount} 个库${
                    p.archivedAt ? " · 已归档" : ""
                  }`}
                  primaryTypographyProps={{ noWrap: true }}
                  secondaryTypographyProps={{ noWrap: true }}
                />
                {p.myRole === "lead" && <Chip size="small" label="负责人" sx={{ ml: 1 }} />}
              </ListItemButton>
            ))}
          </List>
        </Box>
        {offline && (
          <Alert severity="warning" sx={{ m: 1, fontSize: 12 }}>
            {KB_OFFLINE_HINT}
          </Alert>
        )}
        {sessionExpired && (
          <Alert severity="warning" sx={{ m: 1 }}>
            {PROJECT_SESSION_EXPIRED}
          </Alert>
        )}
        {orgsError && (
          <Alert severity="error" sx={{ m: 1 }}>
            {orgsError}
          </Alert>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ flex: 1, p: 2, overflowY: "auto" }}>
        {!activeId && (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            从左侧选一个项目
          </Typography>
        )}
        {activeId && detailLoading && <CircularProgress size={20} />}
        {activeId && !detailLoading && detailError && (
          <Alert severity="error">{detailError}</Alert>
        )}
        {detail && !detailLoading && (
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Typography variant="h3" sx={{ fontSize: 18, fontWeight: 500 }}>
                {detail.project.name}
              </Typography>
              {detail.project.archivedAt && <Chip size="small" label="已归档" />}
              <Box sx={{ flex: 1 }} />
              {/*
               * 「新建会话 / 新建任务」对**项目成员或组织管理员**开放（`canContribute`）。
               * 这不是权限校验（数据在本机，前端拦不住也不需要拦），而是**别提供做不了的动作**：
               * 一个没加入项目的组织成员在这里点新建，成果会出现在别人的项目看板里。
               */}
              {canContribute && (
                <>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={createSessionInProject}
                  >
                    新建会话
                  </Button>
                  <Button
                    size="small"
                    startIcon={<PlaylistAddIcon />}
                    onClick={() => setTaskOpen(true)}
                  >
                    新建任务
                  </Button>
                </>
              )}
              {detail.project.canManage && (
                <>
                  <Button
                    size="small"
                    startIcon={
                      detail.project.archivedAt ? <UnarchiveOutlinedIcon /> : <ArchiveOutlinedIcon />
                    }
                    onClick={() => void toggleArchive(detail.project)}
                  >
                    {detail.project.archivedAt ? "恢复" : "归档"}
                  </Button>
                  <Button
                    size="small"
                    startIcon={<GroupAddOutlinedIcon />}
                    onClick={() => void openMemberDialog()}
                  >
                    加人
                  </Button>
                  <Button
                    size="small"
                    startIcon={<LibraryAddOutlinedIcon />}
                    onClick={() => void openKbDialog()}
                  >
                    加库
                  </Button>
                </>
              )}
              {/* 删除比 canManage 更严：服务端只给组织 admin/owner */}
              {isOrgAdmin && (
                <Button
                  size="small"
                  color="error"
                  startIcon={<DeleteOutlineIcon />}
                  onClick={() => void removeProject(detail.project.id)}
                >
                  {deleteArmed ? "再点一次确认" : "删除"}
                </Button>
              )}
            </Stack>
            {detail.project.description && (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {detail.project.description}
              </Typography>
            )}

            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 500, mb: 1 }}>
                成员（{detail.members.length}）
              </Typography>
              <List dense disablePadding>
                {detail.members.map((m) => (
                  <ListItemButton key={m.userId} disabled={!detail.project.canManage}>
                    <ListItemText
                      primary={m.email}
                      secondary={m.role === "lead" ? "负责人" : "成员"}
                    />
                    {detail.project.canManage && (
                      <Button size="small" onClick={() => void removeMember(m.userId)}>
                        移除
                      </Button>
                    )}
                  </ListItemButton>
                ))}
              </List>
            </Box>

            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 500, mb: 1 }}>
                共享知识库（{detail.kbs.length}）
              </Typography>
              {detail.kbs.length === 0 && (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  还没有关联知识库
                </Typography>
              )}
              <List dense disablePadding>
                {detail.kbs.map((k) => (
                  <ListItemButton key={k.id} disabled={!detail.project.canManage}>
                    <ListItemText primary={k.name} secondary={`${k.documentCount} 篇文档`} />
                    {detail.project.canManage && (
                      <Button size="small" onClick={() => void removeKb(k.id)}>
                        移除
                      </Button>
                    )}
                  </ListItemButton>
                ))}
              </List>
            </Box>

            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 500, mb: 1 }}>
                任务（{projectTasks.length}）
              </Typography>
              {projectTasks.length === 0 ? (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  这个项目里还没有任务
                </Typography>
              ) : (
                <List dense disablePadding>
                  {projectTasks.map((t) => (
                    <ListItemButton key={t.id} onClick={() => navigate(ROUTES.tasks)}>
                      <ListItemText
                        primary={t.name}
                        secondary={t.status === "enabled" ? "启用中" : "已停用"}
                        primaryTypographyProps={{ noWrap: true }}
                      />
                      {canContribute && (
                        <Button
                          size="small"
                          /* aria-label 带对象名：页面上有两个「移出」（任务行 / 会话行），
                             纯文字会让辅助技术与用例都点错行 */
                          aria-label={`把任务「${t.name}」移出项目`}
                          onClick={(e) => {
                            // 阻止冒泡：这一行本身是「打开任务页」的按钮
                            e.stopPropagation();
                            moveTaskOutOfProject(t);
                          }}
                        >
                          移出
                        </Button>
                      )}
                    </ListItemButton>
                  ))}
                </List>
              )}
              {canContribute && (
                <Button size="small" onClick={() => setMoveTaskOpen(true)}>
                  把已有任务移进来
                </Button>
              )}
            </Box>
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 500, mb: 1 }}>
                会话与产物（{projectSessions.length} 个会话 / {projectArtifacts.length} 个产物）
              </Typography>
              {projectSessions.length === 0 ? (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  这个项目里还没有会话
                </Typography>
              ) : (
                <List dense disablePadding>
                  {projectSessions.map((s) => (
                    <ListItemButton
                      key={s.id}
                      onClick={() => {
                        // 用 store 的公开入口切会话再跳页：聊天页不读路由 state，
                        // 只 navigate 会落在「上次打开的会话」上（点了却像没反应）
                        useSessionsStore.getState().selectSession(s.id);
                        navigate(ROUTES.chat);
                      }}
                    >
                      <ListItemText
                        primary={s.title}
                        secondary={`${s.messageCount ?? 0} 条消息`}
                        primaryTypographyProps={{ noWrap: true }}
                      />
                      {canContribute && (
                        <Button
                          size="small"
                          aria-label={`把会话「${s.title}」移出项目`}
                          onClick={(e) => {
                            e.stopPropagation();
                            moveSessionOutOfProject(s);
                          }}
                        >
                          移出
                        </Button>
                      )}
                    </ListItemButton>
                  ))}
                </List>
              )}
              {canContribute && (
                <Button size="small" onClick={() => setMoveSessionOpen(true)}>
                  把已有会话移进来
                </Button>
              )}
              {projectArtifacts.length > 0 && (
                <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: "wrap" }}>
                  {projectArtifacts.slice(0, 12).map((a) => (
                    <Chip
                      key={a.id}
                      size="small"
                      label={a.title || a.id}
                      onClick={() => navigate(ROUTES.artifacts)}
                    />
                  ))}
                  {projectArtifacts.length > 12 && (
                    <Chip size="small" variant="outlined" label={`另有 ${projectArtifacts.length - 12} 个`} />
                  )}
                </Stack>
              )}
            </Box>
          </Stack>
        )}
      </Paper>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>新建项目</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              size="small"
              autoFocus
            />
            <TextField
              label="描述（可选）"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              size="small"
              multiline
              minRows={2}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>取消</Button>
          <Button variant="contained" disabled={busy || !newName.trim()} onClick={() => void createProject()}>
            创建
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={memberOpen} onClose={() => setMemberOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>加入成员</DialogTitle>
        <DialogContent>
          {memberCandidates.length === 0 ? (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
              本组织里没有可加入的成员（要么都已加入，要么组织里只有你）
            </Typography>
          ) : (
            <List dense>
              {memberCandidates.map((m) => (
                <ListItemButton key={m.userId} disabled={busy} onClick={() => void addMember(m.email)}>
                  <ListItemText primary={m.email} secondary={m.role} />
                </ListItemButton>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMemberOpen(false)}>关闭</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={kbOpen} onClose={() => setKbOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>关联知识库</DialogTitle>
        <DialogContent>
          {kbCandidates.length === 0 ? (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
              没有可关联的库（要么都已关联，要么你没有其它可见的库）
            </Typography>
          ) : (
            <List dense>
              {kbCandidates.map((k) => (
                <ListItemButton key={k.id} onClick={() => void addKb(k.id)}>
                  <ListItemText primary={k.name} secondary={`${k.documentCount} 篇文档`} />
                </ListItemButton>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setKbOpen(false)}>关闭</Button>
        </DialogActions>
      </Dialog>

      {/*
       * 复用任务表单，只把 `projectId` 预填进去 —— 不另建一个小表单：
       * 调度 / 权限 / 推送这一整套校验只有一份实现，复制一份必然漂移。
       * `key` 绑项目 id：切项目后再打开必须是空表单，不能留着上一个项目的预填值。
       */}
      <TaskFormDialog
        key={activeId || "new-task"}
        open={taskOpen}
        title="新建任务（归属本项目）"
        submitLabel="创建任务"
        initial={{ agentId: defaultAgentId }}
        onSubmit={createTaskInProject}
        onClose={() => setTaskOpen(false)}
      />

      {/*
       * 两个「移进来」的选择弹窗。候选**只列未归属任何项目**的条目：
       * 已属于别的项目的会话/任务是「跨项目搬移」，那是另一件事（涉及对面项目
       * 的成员要不要知道），不在这一版里顺手做。
       */}
      <Dialog
        open={moveSessionOpen}
        onClose={() => setMoveSessionOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>把已有会话移进来</DialogTitle>
        <DialogContent>
          {movableSessions.length === 0 ? (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
              没有可移入的会话（不属于任何项目的会话才会出现在这里）
            </Typography>
          ) : (
            <List dense>
              {movableSessions.map((s) => (
                <ListItemButton key={s.id} onClick={() => moveSessionIntoProject(s)}>
                  <ListItemText
                    primary={s.title}
                    secondary={`${s.messageCount ?? 0} 条消息`}
                    primaryTypographyProps={{ noWrap: true }}
                  />
                </ListItemButton>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMoveSessionOpen(false)}>关闭</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={moveTaskOpen} onClose={() => setMoveTaskOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>把已有任务移进来</DialogTitle>
        <DialogContent>
          {movableTasks.length === 0 ? (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
              没有可移入的任务（不属于任何项目的任务才会出现在这里）
            </Typography>
          ) : (
            <List dense>
              {movableTasks.map((t) => (
                <ListItemButton key={t.id} onClick={() => moveTaskIntoProject(t)}>
                  <ListItemText
                    primary={t.name}
                    secondary={t.status === "enabled" ? "启用中" : "已停用"}
                    primaryTypographyProps={{ noWrap: true }}
                  />
                </ListItemButton>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMoveTaskOpen(false)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
