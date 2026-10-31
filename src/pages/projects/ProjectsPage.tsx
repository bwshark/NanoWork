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
import UnarchiveOutlinedIcon from "@mui/icons-material/UnarchiveOutlined";
import { toast } from "@/components/Toast";
import { ROUTES } from "@/lib/core/constants";
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
 * 3. **看板与产物是「尚未接入」而不是「0 个任务」**。后者会被读成「这个项目真的没有任务」，
 *    而事实是功能还不存在 —— 这两句话给用户的结论完全相反。
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

  const activeOrg = orgs.find((o) => o.id === activeOrgId);
  /** 组织角色只用来决定「删除项目」这一个入口的可见性（服务端只给 admin/owner） */
  const isOrgAdmin = activeOrg?.role === "admin" || activeOrg?.role === "owner";

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
                任务看板
              </Typography>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                尚未接入
              </Typography>
            </Box>
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 500, mb: 1 }}>
                产物库
              </Typography>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                尚未接入
              </Typography>
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
    </Stack>
  );
}
