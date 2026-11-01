import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Select,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import GroupsIcon from "@mui/icons-material/Groups";
import PersonIcon from "@mui/icons-material/Person";
import { useAgentsStore } from "@/stores/agentsStore";
import { useExpertGroupsStore } from "@/stores/expertGroupsStore";
import { useSkillsStore } from "@/stores/skillsStore";
import { useSessionsStore } from "@/stores/sessionsStore";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SummonSlot } from "@/components/agents/SummonSlot";
import { AgentFormDialog } from "@/components/agents/AgentFormDialog";
import { AgentKnowledgeChip } from "@/components/agents/AgentKnowledgeChip";
import { ExpertPackageImportDialog } from "@/components/agents/ExpertPackageImportDialog";
import { useExpertPackageExport } from "@/components/agents/useExpertPackageExport";
import { CreateExpertDialog } from "@/components/agents/CreateExpertDialog";
import { ImportableExpertsBar } from "@/components/agents/ImportableExpertsBar";
import {
  useExpertAutoCreate,
  type AutoCreateKind,
} from "@/components/agents/useExpertAutoCreate";
import { PLATFORM_LABEL } from "@/lib/channel/imPlatform";
import { ROUTES } from "@/lib/core/constants";
import {
  avatarGlyph,
  cardChipOutlinedSx,
  cardChipSx,
  cardGhostActionSx,
  cardGhostDangerSx,
  clampLines,
  entityAvatarSx,
  hoverCardSx,
} from "@/lib/ui/cardSx";
import type { Agent, ExpertGroup, ExpertGroupMode } from "@/types";
import {
  isBuiltinAgentId,
  isBuiltinGroupId,
  EXPERT_GROUP_MODE_LABEL,
  EXPERT_GROUP_MODE_DESC,
  EXPERT_GROUP_MODE_NOTICE,
} from "@/types";

/** IM 平台中文标签 */
/** 页内分段 tab：专家（单 Agent）/ 专家团（多 Agent 编排） */
type PageTab = "agents" | "groups";

const EMPTY_GROUP: Partial<ExpertGroup> = {
  name: "",
  role: "",
  description: "",
  memberIds: [],
  mode: "sequential",
  enabled: true,
};

/**
 * 我的专家页（/agents/mine）：专家 + 专家团管理。
 * 从专家管理页点击「我的专家」进入，面包屑返回专家管理页（/agents）。
 */
export function MyAgentsPage() {
  const navigate = useNavigate();

  const agents = useAgentsStore((s) => s.agents);
  const createAgent = useAgentsStore((s) => s.createAgent);
  const updateAgent = useAgentsStore((s) => s.updateAgent);
  const removeAgent = useAgentsStore((s) => s.removeAgent);
  const toggleAgent = useAgentsStore((s) => s.toggleAgent);
  const setActiveAgent = useAgentsStore((s) => s.setActiveAgent);
  const skills = useSkillsStore((s) => s.skills);

  const groups = useExpertGroupsStore((s) => s.groups);
  const createGroup = useExpertGroupsStore((s) => s.createGroup);
  const updateGroup = useExpertGroupsStore((s) => s.updateGroup);
  const removeGroup = useExpertGroupsStore((s) => s.removeGroup);
  const toggleGroup = useExpertGroupsStore((s) => s.toggleGroup);
  const setActiveGroup = useExpertGroupsStore((s) => s.setActiveGroup);

  const activeSessionId = useSessionsStore((s) => s.activeId);
  const updateSession = useSessionsStore((s) => s.updateSession);

  const [tab, setTab] = useState<PageTab>("agents");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [toDelete, setToDelete] = useState<string | null>(null);
  /** 导入专家包对话框（FR-3.3）。打开即由组件自己去弹系统选文件框 */
  const [importOpen, setImportOpen] = useState(false);
  const { exportAgent } = useExpertPackageExport();

  const [groupOpen, setGroupOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ExpertGroup | null>(null);
  const [groupForm, setGroupForm] = useState<Partial<ExpertGroup>>(EMPTY_GROUP);
  const [groupToDelete, setGroupToDelete] = useState<string | null>(null);

  /** 创建模式选择：取值即「要创建的类型」，与专家管理页同构 */
  const [createKind, setCreateKind] = useState<AutoCreateKind | null>(null);
  const { startAutoCreate } = useExpertAutoCreate();

  // 「我的专家」只展示用户自建条目：内置模板不在此页出现（内置在专家管理首页可见）。
  const myAgents = useMemo(
    () => agents.filter((a) => !isBuiltinAgentId(a.id)),
    [agents],
  );
  const myGroups = useMemo(
    () => groups.filter((g) => !isBuiltinGroupId(g.id)),
    [groups],
  );

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return myAgents;
    return myAgents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.systemPrompt ?? "").toLowerCase().includes(q),
    );
  }, [myAgents, query]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return myGroups;
    return myGroups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        (g.role ?? "").toLowerCase().includes(q) ||
        (g.description ?? "").toLowerCase().includes(q),
    );
  }, [myGroups, query]);

  const openNew = () => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (a: Agent) => {
    setEditing(a);
    setOpen(true);
  };
  /** 表单草稿由 `AgentFormDialog` 持有；这里只负责落地到 store */
  const saveAgent = (form: Partial<Agent>) => {
    if (!form.name?.trim()) return;
    if (editing) updateAgent(editing.id, form);
    else createAgent(form);
    setOpen(false);
  };

  const summonAgent = (a: Agent) => {
    setActiveAgent(a.id);
    // 切到单专家模式：释放全局活跃专家团，避免后续新会话仍按团兜底
    setActiveGroup(null);
    if (activeSessionId) {
      updateSession(activeSessionId, (s) => ({
        ...s,
        agentId: a.id,
        groupId: null,
        updatedAt: new Date().toISOString(),
      }));
    }
    navigate(ROUTES.chat);
  };

  const openNewGroup = () => {
    setEditingGroup(null);
    setGroupForm(EMPTY_GROUP);
    setGroupOpen(true);
  };
  const openEditGroup = (g: ExpertGroup) => {
    setEditingGroup(g);
    setGroupForm({ ...g });
    setGroupOpen(true);
  };
  const saveGroup = () => {
    if (!groupForm.name?.trim() || !groupForm.memberIds?.length) return;
    if (editingGroup) updateGroup(editingGroup.id, groupForm);
    else createGroup(groupForm);
    setGroupOpen(false);
  };

  const summonGroup = (g: ExpertGroup) => {
    const leader = g.memberIds
      .map((id) => agents.find((a) => a.id === id))
      .find((a) => a && a.enabled);
    setActiveGroup(g.id);
    if (activeSessionId) {
      updateSession(activeSessionId, (s) => ({
        ...s,
        groupId: g.id,
        ...(leader ? { agentId: leader.id } : {}),
        updatedAt: new Date().toISOString(),
      }));
    }
    navigate(ROUTES.chat);
  };

  const cardHoverProps = (id: string) => ({
    onMouseEnter: () => setHoverId(id),
    onMouseLeave: () => setHoverId((v) => (v === id ? null : v)),
  });

  /**
   * 卡片底部：启用开关（常驻可点）+ 导出 / 编辑 / 删除（半透明，hover 回到全亮）。
   *
   * `onExport` 可选：专家团**不支持**导出（`expertType: 'team'` 需要带成员互相引用，
   * 本期包格式只定义了个体）。少一个入参比渲染一个点了会报错的按钮好。
   */
  const renderFooter = (
    enabled: boolean,
    onToggle: () => void,
    onEdit: () => void,
    onDelete: () => void,
    deleteDisabled: boolean,
    label: string,
    onExport?: () => void,
  ) => (
    <Box sx={{ mt: 1.5, display: "flex", alignItems: "center", gap: 0.5 }}>
      <FormControlLabel
        sx={{ m: 0 }}
        control={<Switch size="small" checked={enabled} onChange={onToggle} />}
        label={
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
            {enabled ? "启用" : "停用"}
          </Typography>
        }
      />
      <Box sx={{ flex: 1 }} />
      {onExport && (
        <Tooltip title="导出专家包">
          <span>
            <IconButton
              size="small"
              aria-label={`导出 ${label}`}
              onClick={onExport}
              sx={cardGhostActionSx}
            >
              <FileDownloadOutlinedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
      )}
      <Tooltip title="编辑">
        <IconButton
          size="small"
          aria-label={`编辑 ${label}`}
          onClick={onEdit}
          sx={cardGhostActionSx}
        >
          <EditIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title={deleteDisabled ? "内置条目不可删除" : "删除"}>
        <span>
          <IconButton
            size="small"
            aria-label={`删除 ${label}`}
            disabled={deleteDisabled}
            onClick={onDelete}
            sx={cardGhostDangerSx}
          >
            <DeleteOutlineIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );

  const renderAgentCard = (a: Agent) => {
    const isBuiltin = isBuiltinAgentId(a.id);
    const { glyph, isEmoji } = avatarGlyph(a.avatar, a.name);
    return (
      <Card
        key={a.id}
        variant="outlined"
        {...cardHoverProps(a.id)}
        sx={hoverCardSx}
      >
        <CardContent sx={{ p: 2.5, "&:last-child": { pb: 2.5 } }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Avatar sx={entityAvatarSx(a.name, isEmoji)}>{glyph}</Avatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}
                noWrap
              >
                {a.name}
              </Typography>
              <Typography
                sx={{ fontSize: 12, color: "text.secondary", mt: 0.25 }}
                noWrap
              >
                {a.imBinding
                  ? `IM·${PLATFORM_LABEL[a.imBinding.platform]}`
                  : a.skillIds.length
                    ? (skills.find((s) => s.id === a.skillIds[0])?.name ??
                      "专家")
                    : "专家"}
              </Typography>
            </Box>
            <SummonSlot
              hovered={hoverId === a.id}
              defaultChip={
                isBuiltin ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    label="内置"
                    sx={cardChipOutlinedSx}
                  />
                ) : (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${a.skillIds.length} 技能`}
                    sx={cardChipOutlinedSx}
                  />
                )
              }
              tooltip={
                a.enabled ? "召唤该专家到当前会话" : "该专家已停用，无法召唤"
              }
              disabled={!a.enabled}
              onSummon={() => summonAgent(a)}
            />
          </Box>
          <Typography
            sx={{
              fontSize: 13,
              color: "text.secondary",
              lineHeight: 1.6,
              mt: 1.5,
              minHeight: 42,
              ...clampLines(2),
            }}
          >
            {a.systemPrompt || "（无系统提示）"}
          </Typography>
          <Box
            sx={{
              mt: 1.25,
              display: "flex",
              gap: 0.75,
              flexWrap: "wrap",
              minHeight: 24,
            }}
          >
            {a.skillIds.slice(0, 3).map((id) => (
              <Chip
                key={id}
                size="small"
                label={skills.find((s) => s.id === id)?.name ?? id}
                sx={cardChipSx}
              />
            ))}
            {a.skillIds.length > 3 && (
              <Chip
                size="small"
                label={`+${a.skillIds.length - 3}`}
                sx={cardChipSx}
              />
            )}
            {/* 知识库绑定（FR-2.3 第四条）：绑了才出现。它只影响「回答里会不会引用
                组织资料」，不显示的话绑错了只能去翻编辑表单。 */}
            <AgentKnowledgeChip knowledge={a.knowledge} />
            {/* 工具权限（FR-2.2）：只在真的声明了策略时才出现。
                「未声明」与「声明为空白名单」在卡片上必须一眼可分——
                后者会让这个 Agent 什么都做不了，属于需要立刻看见的状态。 */}
            {a.toolAllow !== undefined && (
              <Tooltip
                title={
                  a.toolAllow.length === 0
                    ? "已声明白名单但一个工具都没勾——该 Agent 无法调用任何工具"
                    : `仅允许：${a.toolAllow.join("、")}`
                }
              >
                <Chip
                  size="small"
                  color={a.toolAllow.length === 0 ? "warning" : "default"}
                  variant="outlined"
                  label={
                    a.toolAllow.length === 0
                      ? "无工具可用"
                      : `仅 ${a.toolAllow.length} 个工具`
                  }
                  sx={cardChipOutlinedSx}
                />
              </Tooltip>
            )}
            {a.toolDeny && a.toolDeny.length > 0 && (
              <Tooltip title={`禁止：${a.toolDeny.join("、")}`}>
                <Chip
                  size="small"
                  variant="outlined"
                  label={`禁 ${a.toolDeny.length} 个`}
                  sx={cardChipOutlinedSx}
                />
              </Tooltip>
            )}
          </Box>
          {renderFooter(
            a.enabled,
            () => toggleAgent(a.id),
            () => openEdit(a),
            () => setToDelete(a.id),
            isBuiltin,
            a.name,
            () => void exportAgent(a),
          )}
        </CardContent>
      </Card>
    );
  };

  const renderGroupCard = (g: ExpertGroup) => {
    const isBuiltin = isBuiltinGroupId(g.id);
    const members = g.memberIds
      .map((id) => agents.find((a) => a.id === id))
      .filter((a): a is Agent => !!a);
    const enabledMembers = members.filter((m) => m.enabled);
    const { glyph, isEmoji } = avatarGlyph(g.icon, g.name);
    return (
      <Card
        key={g.id}
        variant="outlined"
        {...cardHoverProps(g.id)}
        sx={hoverCardSx}
      >
        <CardContent sx={{ p: 2.5, "&:last-child": { pb: 2.5 } }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Avatar sx={entityAvatarSx(g.name, isEmoji)}>{glyph}</Avatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}
                noWrap
              >
                {g.name}
              </Typography>
              <Typography
                sx={{ fontSize: 12, color: "text.secondary", mt: 0.25 }}
                noWrap
              >
                {g.role || EXPERT_GROUP_MODE_LABEL[g.mode]}
              </Typography>
            </Box>
            <SummonSlot
              hovered={hoverId === g.id}
              defaultChip={
                <Chip
                  size="small"
                  variant="outlined"
                  label={`${members.length} 成员`}
                  sx={cardChipOutlinedSx}
                />
              }
              tooltip={
                g.enabled
                  ? enabledMembers.length
                    ? `召唤该专家团到当前会话（${EXPERT_GROUP_MODE_LABEL[g.mode]}）`
                    : "专家团内没有启用的成员"
                  : "该专家团已停用，无法召唤"
              }
              disabled={!g.enabled || enabledMembers.length === 0}
              onSummon={() => summonGroup(g)}
            />
          </Box>
          <Typography
            sx={{
              fontSize: 13,
              color: "text.secondary",
              lineHeight: 1.6,
              mt: 1.5,
              minHeight: 42,
              ...clampLines(2),
            }}
          >
            {g.description || "（无描述）"}
          </Typography>
          <Box
            sx={{
              mt: 1.25,
              display: "flex",
              gap: 0.75,
              flexWrap: "wrap",
              minHeight: 24,
            }}
          >
            <Chip
              size="small"
              label={EXPERT_GROUP_MODE_LABEL[g.mode]}
              sx={cardChipSx}
            />
            {members.slice(0, 3).map((m) => (
              <Chip
                key={m.id}
                size="small"
                variant="outlined"
                label={m.name}
                sx={cardChipOutlinedSx}
              />
            ))}
            {members.length > 3 && (
              <Chip
                size="small"
                label={`+${members.length - 3}`}
                sx={cardChipSx}
              />
            )}
          </Box>
          {renderFooter(
            g.enabled,
            () => toggleGroup(g.id),
            () => openEditGroup(g),
            () => setGroupToDelete(g.id),
            isBuiltin,
            g.name,
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <Box sx={{ p: 3, maxWidth: "100%", margin: "0 auto" }}>
      <Button
        size="small"
        startIcon={<ChevronLeftIcon sx={{ fontSize: 18 }} />}
        onClick={() => navigate(ROUTES.agents)}
        sx={{
          px: 0,
          minWidth: 0,
          textTransform: "none",
          color: "text.secondary",
          mb: 0.5,
        }}
      >
        全部专家
      </Button>

      <Box sx={{ display: "flex", alignItems: "flex-end", mb: 1.5, gap: 1.5 }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>
            我的专家
          </Typography>
          <Typography
            sx={{ fontSize: 12.5, color: "text.secondary", mt: 0.25 }}
          >
            共 {myAgents.length} 位专家 · {myGroups.length} 个专家团
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          variant="outlined"
          startIcon={<FileUploadOutlinedIcon sx={{ fontSize: 18 }} />}
          onClick={() => setImportOpen(true)}
          sx={{ textTransform: "none" }}
        >
          导入专家包
        </Button>
        <Button
          size="small"
          variant="contained"
          startIcon={<AddIcon sx={{ fontSize: 18 }} />}
          onClick={() => setCreateKind(tab === "agents" ? "agent" : "team")}
          sx={{ textTransform: "none" }}
        >
          {tab === "agents" ? "创建专家" : "创建专家团"}
        </Button>
        <TextField
          size="small"
          placeholder={tab === "agents" ? "检索专家" : "检索专家团"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 18 }} />
              </InputAdornment>
            ),
          }}
          sx={{ width: 220 }}
        />
      </Box>

      {/** 插件带来的专家：直接给导入入口 */}
      <ImportableExpertsBar />

      <TabsBlock
        tab={tab}
        onChange={setTab}
        agentCount={myAgents.length}
        groupCount={myGroups.length}
      />

      {/** 检索无结果时仍给出提示；空列表（无检索）由创建卡片顺排在末尾承载引导，无须额外文案。 */}
      {query.trim() &&
      (tab === "agents"
        ? filteredAgents.length === 0
        : filteredGroups.length === 0) ? (
        <Box sx={{ py: 8, textAlign: "center" }}>
          <Typography sx={{ fontSize: 14, color: "text.secondary" }}>
            未找到匹配「{query.trim()}」的{tab === "agents" ? "专家" : "专家团"}
          </Typography>
        </Box>
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 2,
          }}
        >
          {tab === "agents"
            ? filteredAgents.map(renderAgentCard)
            : filteredGroups.map(renderGroupCard)}
          <Card
            variant="outlined"
            onClick={() => setCreateKind(tab === "agents" ? "agent" : "team")}
            sx={[
              hoverCardSx,
              {
                cursor: "pointer",
                minHeight: 220,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                "&:hover": {
                  "& .create-circle": {
                    borderColor: "text.primary",
                    color: "text.primary",
                  },
                },
              },
            ]}
          >
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 1.5,
                color: "text.secondary",
              }}
            >
              <Box
                className="create-circle"
                sx={{
                  width: 72,
                  height: 72,
                  borderRadius: "50%",
                  border: "1.5px solid",
                  borderColor: "divider",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "text.secondary",
                  transition: "border-color .2s, color .2s",
                }}
              >
                <AddIcon sx={{ fontSize: 36 }} />
              </Box>
              <Typography sx={{ fontSize: 13 }}>
                {tab === "agents" ? "创建专家" : "创建专家团"}
              </Typography>
            </Box>
          </Card>
        </Box>
      )}

      {/** 专家创建/编辑弹窗：与「专家管理」页共用同一个组件（字段集为超集） */}
      <AgentFormDialog
        open={open}
        editing={editing}
        onClose={() => setOpen(false)}
        onSave={saveAgent}
      />

      {/** 导入专家包（FR-3.3）：打开即弹系统选文件框，选完在本框里预览对账结果 */}
      <ExpertPackageImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
      />

      {/** 创建入口的模式选择：与专家管理页共用同一个弹层 */}
      <CreateExpertDialog
        open={createKind !== null}
        kind={createKind ?? "agent"}
        onClose={() => setCreateKind(null)}
        onManual={() => {
          const kind = createKind;
          setCreateKind(null);
          if (kind === "team") openNewGroup();
          else openNew();
        }}
        onAuto={() => {
          const kind = createKind ?? "agent";
          setCreateKind(null);
          startAutoCreate(kind);
        }}
      />

      <Dialog
        open={groupOpen}
        onClose={() => setGroupOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{editingGroup ? "编辑专家团" : "创建专家团"}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            margin="dense"
            label="名称"
            placeholder="如：市场分析团"
            value={groupForm.name ?? ""}
            onChange={(e) =>
              setGroupForm({ ...groupForm, name: e.target.value })
            }
          />
          <TextField
            fullWidth
            margin="dense"
            label="副标题（可选）"
            placeholder="如：Marketing"
            value={groupForm.role ?? ""}
            onChange={(e) =>
              setGroupForm({ ...groupForm, role: e.target.value })
            }
          />
          <TextField
            fullWidth
            margin="dense"
            multiline
            minRows={2}
            label="描述"
            value={groupForm.description ?? ""}
            onChange={(e) =>
              setGroupForm({ ...groupForm, description: e.target.value })
            }
          />
          <TextField
            fullWidth
            margin="dense"
            label="图标（emoji，可选）"
            placeholder="如：🧩"
            value={groupForm.icon ?? ""}
            onChange={(e) =>
              setGroupForm({ ...groupForm, icon: e.target.value })
            }
          />
          <Typography sx={{ fontSize: 13, mt: 1, mb: 0.5 }}>
            协作模式
          </Typography>
          <Select
            fullWidth
            value={groupForm.mode ?? "sequential"}
            onChange={(e) =>
              setGroupForm({
                ...groupForm,
                mode: e.target.value as ExpertGroupMode,
              })
            }
          >
            {(Object.keys(EXPERT_GROUP_MODE_LABEL) as ExpertGroupMode[]).map(
              (m) => (
                <MenuItem key={m} value={m}>
                  {EXPERT_GROUP_MODE_LABEL[m]}
                </MenuItem>
              ),
            )}
          </Select>
          <Typography variant="caption" color="text.secondary">
            {EXPERT_GROUP_MODE_DESC[groupForm.mode ?? "sequential"]}
          </Typography>
          {/* FR-2.4：模式已由引擎真实编排（≥2 名启用成员时生效）。说明紧贴选择控件 ——
              用户正是在这里做选择，「什么时候生效 / 什么时候不生效」必须当场看到 */}
          <Alert severity="info" sx={{ mt: 1, fontSize: 12.5 }}>
            {EXPERT_GROUP_MODE_NOTICE}
          </Alert>

          <Typography sx={{ fontSize: 13, mt: 1.5, mb: 0.5 }}>
            成员专家（{groupForm.memberIds?.length ?? 0}）
          </Typography>
          <Select
            fullWidth
            multiple
            value={groupForm.memberIds ?? []}
            onChange={(e) =>
              setGroupForm({
                ...groupForm,
                memberIds: e.target.value as string[],
              })
            }
            renderValue={(sel) =>
              (sel as string[])
                .map((id) => agents.find((a) => a.id === id)?.name ?? id)
                .join("、")
            }
          >
            {agents.map((a) => (
              <MenuItem key={a.id} value={a.id}>
                {a.name}
              </MenuItem>
            ))}
          </Select>
          <Typography variant="caption" color="text.secondary">
            顺序流水线 / 主从协调按选择顺序生效（首位即入口/协调者）。
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setGroupOpen(false)}>取消</Button>
          <Button
            variant="contained"
            onClick={saveGroup}
            disabled={!groupForm.name?.trim() || !groupForm.memberIds?.length}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!toDelete}
        title="删除 Agent"
        message="确认删除该 Agent？此操作不可撤销。"
        danger
        confirmText="删除"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) removeAgent(toDelete);
          setToDelete(null);
        }}
      />

      <ConfirmDialog
        open={!!groupToDelete}
        title="删除专家团"
        message="确认删除该专家团？此操作不会删除其中的专家成员。"
        danger
        confirmText="删除"
        onCancel={() => setGroupToDelete(null)}
        onConfirm={() => {
          if (groupToDelete) removeGroup(groupToDelete);
          setGroupToDelete(null);
        }}
      />
    </Box>
  );
}

function TabsBlock({
  tab,
  onChange,
  agentCount,
  groupCount,
}: {
  tab: PageTab;
  onChange: (t: PageTab) => void;
  agentCount: number;
  groupCount: number;
}) {
  return (
    <Box sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}>
      <Box role="tablist" sx={{ display: "flex", gap: 0.5 }}>
        {[
          {
            key: "agents" as PageTab,
            label: "专家",
            icon: <PersonIcon sx={{ fontSize: 16 }} />,
            count: agentCount,
          },
          {
            key: "groups" as PageTab,
            label: "专家团",
            icon: <GroupsIcon sx={{ fontSize: 16 }} />,
            count: groupCount,
          },
        ].map((t) => {
          const active = tab === t.key;
          return (
            <Box
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.key)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                px: 1.5,
                py: 1,
                cursor: "pointer",
                userSelect: "none",
                color: active ? "text.primary" : "text.secondary",
                fontWeight: active ? 600 : 400,
                fontSize: 14,
                borderBottom: "2px solid",
                borderColor: active ? "primary.main" : "transparent",
                transition: "color .15s, border-color .15s",
                "&:hover": { color: "text.primary" },
              }}
            >
              {t.icon}
              {t.label}
              <Box
                sx={{
                  fontSize: 11,
                  px: 0.75,
                  py: "1px",
                  borderRadius: 999,
                  bgcolor: active ? "primary.main" : "action.selected",
                  color: active ? "primary.contrastText" : "text.secondary",
                  lineHeight: 1.4,
                }}
              >
                {t.count}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
