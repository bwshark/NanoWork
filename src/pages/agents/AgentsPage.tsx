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
import GroupsIcon from "@mui/icons-material/Groups";
import PersonIcon from "@mui/icons-material/Person";
import { useAgentsStore } from "@/stores/agentsStore";
import { useExpertGroupsStore } from "@/stores/expertGroupsStore";
import { useSkillsStore } from "@/stores/skillsStore";
import { useSessionsStore } from "@/stores/sessionsStore";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SummonSlot } from "@/components/agents/SummonSlot";
import { AgentFormDialog } from "@/components/agents/AgentFormDialog";
import { PLATFORM_LABEL } from "@/lib/imPlatform";
import { ROUTES } from "@/lib/constants";
import {
  avatarGlyph,
  cardChipOutlinedSx,
  cardChipSx,
  cardGhostActionSx,
  cardGhostDangerSx,
  clampLines,
  entityAvatarSx,
  hoverCardSx,
} from "@/lib/cardSx";
import type { Agent, ExpertGroup, ExpertGroupMode } from "@/types";
import {
  isBuiltinAgentId,
  isBuiltinGroupId,
  EXPERT_GROUP_MODE_LABEL,
  EXPERT_GROUP_MODE_DESC,
  EXPERT_GROUP_MODE_NOT_EFFECTIVE_NOTICE,
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
 * 专家管理首页（/agents）：展示全部专家与专家团（含内置）。
 * 布局：左侧大标题；右侧检索框 + 「我的专家」+ 「创建专家/专家团」；
 * 专家/专家团分段切换 + 卡片网格。
 */
export function AgentsPage() {
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
  const [query, setQuery] = useState("");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [toDelete, setToDelete] = useState<string | null>(null);

  const [groupOpen, setGroupOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ExpertGroup | null>(null);
  const [groupForm, setGroupForm] = useState<Partial<ExpertGroup>>(EMPTY_GROUP);
  const [groupToDelete, setGroupToDelete] = useState<string | null>(null);

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.systemPrompt ?? "").toLowerCase().includes(q),
    );
  }, [agents, query]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        (g.role ?? "").toLowerCase().includes(q) ||
        (g.description ?? "").toLowerCase().includes(q),
    );
  }, [groups, query]);

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

  /** 召唤专家：设为当前 activeAgent，若有活跃会话则同步绑过去，跳回 chat。 */
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

  /** 召唤专家团：与召唤专家同构——设为当前 activeGroup，有活跃会话则同步绑过去，跳回 chat。
   *  会话 agentId 同步为团内首位启用成员（执行代表；完整多 Agent 编排依赖 nanobot 运行时，P2）。 */
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

  const isEmpty =
    tab === "agents"
      ? filteredAgents.length === 0
      : filteredGroups.length === 0;

  return (
    <Box sx={{ p: 3, maxWidth: "100%", margin: "0 auto" }}>
      {/** 标题行：左标题，右检索 + 我的专家 + 创建 */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          mb: 2,
          flexWrap: "wrap",
        }}
      >
        <Typography variant="h5" fontWeight={700}>
          专家管理
        </Typography>
        <Box sx={{ flex: 1 }} />
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
        <Button
          variant="outlined"
          onClick={() => navigate(ROUTES.myAgents)}
          sx={{ textTransform: "none" }}
        >
          我的专家
        </Button>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={tab === "agents" ? openNew : openNewGroup}
          sx={{ textTransform: "none" }}
        >
          {tab === "agents" ? "创建专家" : "创建专家团"}
        </Button>
      </Box>

      {/** 专家 / 专家团 分段切换 */}
      <TabsBlock
        tab={tab}
        onChange={setTab}
        agentCount={agents.length}
        groupCount={groups.length}
      />

      {isEmpty ? (
        <Box sx={{ py: 10, textAlign: "center" }}>
          <Typography sx={{ fontSize: 14, color: "text.secondary" }}>
            {query.trim()
              ? `未找到匹配「${query.trim()}」的${tab === "agents" ? "专家" : "专家团"}`
              : tab === "agents"
                ? "还没有专家，点击右上角「创建专家」开始"
                : "还没有专家团，点击右上角「创建专家团」开始"}
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
            ? filteredAgents.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  skills={skills}
                  onEdit={() => openEdit(a)}
                  onDelete={() => setToDelete(a.id)}
                  onToggle={() => toggleAgent(a.id)}
                  deleteDisabled={isBuiltinAgentId(a.id)}
                  onSummon={() => summonAgent(a)}
                  summonDisabled={!a.enabled}
                  summonTooltip={
                    a.enabled
                      ? "召唤该专家到当前会话"
                      : "该专家已停用，无法召唤"
                  }
                />
              ))
            : filteredGroups.map((g) => {
                const enabledMembers = g.memberIds
                  .map((id) => agents.find((a) => a.id === id))
                  .filter((a): a is Agent => !!a && a.enabled);
                return (
                  <GroupCard
                    key={g.id}
                    group={g}
                    agents={agents}
                    onEdit={() => openEditGroup(g)}
                    onDelete={() => setGroupToDelete(g.id)}
                    onToggle={() => toggleGroup(g.id)}
                    deleteDisabled={isBuiltinGroupId(g.id)}
                    onSummon={() => summonGroup(g)}
                    summonDisabled={!g.enabled || enabledMembers.length === 0}
                    summonTooltip={
                      g.enabled
                        ? enabledMembers.length
                          ? `召唤该专家团到当前会话（${EXPERT_GROUP_MODE_LABEL[g.mode]}）`
                          : "专家团内没有启用的成员"
                        : "该专家团已停用，无法召唤"
                    }
                  />
                );
              })}
        </Box>
      )}

      {/** 专家创建/编辑弹窗：与「我的专家」页共用同一个组件（字段集为超集） */}
      <AgentFormDialog
        open={open}
        editing={editing}
        onClose={() => setOpen(false)}
        onSave={saveAgent}
      />

      {/** 专家团创建/编辑弹窗 */}
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
          {/* FR-2.4 现状：模式只保存、不改变执行结果。必须紧贴选择控件 ——
              用户正是在这里做选择，看到三档可选就会以为会生效 */}
          <Alert severity="warning" sx={{ mt: 1, fontSize: 12.5 }}>
            {EXPERT_GROUP_MODE_NOT_EFFECTIVE_NOTICE}
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

/** 分段标签块：专家 / 专家团，带数量徽标 */
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

/** 专家卡片：头像、名称、内置标签、描述、技能标签、启停与编辑删除；hover 显示召唤。 */
function AgentCard({
  agent,
  skills,
  onEdit,
  onDelete,
  onToggle,
  deleteDisabled,
  onSummon,
  summonDisabled,
  summonTooltip,
}: {
  agent: Agent;
  skills: { id: string; name: string }[];
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  deleteDisabled: boolean;
  onSummon: () => void;
  summonDisabled: boolean;
  summonTooltip: string;
}) {
  const isBuiltin = isBuiltinAgentId(agent.id);
  const { glyph, isEmoji } = avatarGlyph(agent.avatar, agent.name);
  const [hovered, setHovered] = useState(false);

  return (
    <Card
      variant="outlined"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      sx={hoverCardSx}
    >
      <CardContent sx={{ p: 2.5, "&:last-child": { pb: 2.5 } }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <Avatar sx={entityAvatarSx(agent.name, isEmoji)}>{glyph}</Avatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}
              noWrap
            >
              {agent.name}
            </Typography>
            <Typography
              sx={{ fontSize: 12, color: "text.secondary", mt: 0.25 }}
              noWrap
            >
              {agent.imBinding
                ? `IM·${PLATFORM_LABEL[agent.imBinding.platform]}`
                : agent.skillIds.length
                  ? (skills.find((s) => s.id === agent.skillIds[0])?.name ??
                    "专家")
                  : "专家"}
            </Typography>
          </Box>
          <SummonSlot
            hovered={hovered}
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
                  label={`${agent.skillIds.length} 技能`}
                  sx={cardChipOutlinedSx}
                />
              )
            }
            tooltip={summonTooltip}
            disabled={summonDisabled}
            onSummon={onSummon}
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
          {agent.systemPrompt || "（无系统提示）"}
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
          {agent.skillIds.slice(0, 3).map((id) => (
            <Chip
              key={id}
              size="small"
              label={skills.find((s) => s.id === id)?.name ?? id}
              sx={cardChipSx}
            />
          ))}
          {agent.skillIds.length > 3 && (
            <Chip
              size="small"
              label={`+${agent.skillIds.length - 3}`}
              sx={cardChipSx}
            />
          )}
        </Box>

        <Box sx={{ mt: 1.5, display: "flex", alignItems: "center", gap: 0.5 }}>
          <FormControlLabel
            sx={{ m: 0 }}
            control={
              <Switch
                size="small"
                checked={agent.enabled}
                onChange={onToggle}
              />
            }
            label={
              <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                {agent.enabled ? "启用" : "停用"}
              </Typography>
            }
          />
          <Box sx={{ flex: 1 }} />
          <Tooltip title="编辑">
            <IconButton
              size="small"
              aria-label={`编辑 ${agent.name}`}
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
                aria-label={`删除 ${agent.name}`}
                disabled={deleteDisabled}
                onClick={onDelete}
                sx={cardGhostDangerSx}
              >
                <DeleteOutlineIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </CardContent>
    </Card>
  );
}

/** 专家团卡片：emoji 图标、名称、内置标签、协作模式、描述、成员标签、启停与编辑删除；hover 显示召唤。 */
function GroupCard({
  group,
  agents,
  onEdit,
  onDelete,
  onToggle,
  deleteDisabled,
  onSummon,
  summonDisabled,
  summonTooltip,
}: {
  group: ExpertGroup;
  agents: Agent[];
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  deleteDisabled: boolean;
  onSummon: () => void;
  summonDisabled: boolean;
  summonTooltip: string;
}) {
  const isBuiltin = isBuiltinGroupId(group.id);
  const members = group.memberIds
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is Agent => !!a);
  const { glyph, isEmoji } = avatarGlyph(group.icon, group.name);
  const [hovered, setHovered] = useState(false);

  return (
    <Card
      variant="outlined"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      sx={hoverCardSx}
    >
      <CardContent sx={{ p: 2.5, "&:last-child": { pb: 2.5 } }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <Avatar sx={entityAvatarSx(group.name, isEmoji)}>{glyph}</Avatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}
              noWrap
            >
              {group.name}
            </Typography>
            <Typography
              sx={{ fontSize: 12, color: "text.secondary", mt: 0.25 }}
              noWrap
            >
              {group.role || EXPERT_GROUP_MODE_LABEL[group.mode]}
            </Typography>
          </Box>
          <SummonSlot
            hovered={hovered}
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
                  label={`${members.length} 成员`}
                  sx={cardChipOutlinedSx}
                />
              )
            }
            tooltip={summonTooltip}
            disabled={summonDisabled}
            onSummon={onSummon}
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
          {group.description || "（无描述）"}
        </Typography>

        <Box sx={{ mt: 1, display: "flex", gap: 0.5, flexWrap: "wrap" }}>
          <Chip
            size="small"
            label={EXPERT_GROUP_MODE_LABEL[group.mode]}
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

        <Box sx={{ mt: 1.5, display: "flex", alignItems: "center", gap: 0.5 }}>
          <FormControlLabel
            sx={{ m: 0 }}
            control={
              <Switch
                size="small"
                checked={group.enabled}
                onChange={onToggle}
              />
            }
            label={
              <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                {group.enabled ? "启用" : "停用"}
              </Typography>
            }
          />
          <Box sx={{ flex: 1 }} />
          <Tooltip title="编辑">
            <IconButton
              size="small"
              aria-label={`编辑 ${group.name}`}
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
                aria-label={`删除 ${group.name}`}
                disabled={deleteDisabled}
                onClick={onDelete}
                sx={cardGhostDangerSx}
              >
                <DeleteOutlineIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </CardContent>
    </Card>
  );
}
