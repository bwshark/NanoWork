import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Autocomplete,
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
  Divider,
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
import GroupsIcon from "@mui/icons-material/Groups";
import PersonIcon from "@mui/icons-material/Person";
import { useAgentsStore } from "@/stores/agentsStore";
import { useExpertGroupsStore } from "@/stores/expertGroupsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSkillsStore } from "@/stores/skillsStore";
import { useSessionsStore } from "@/stores/sessionsStore";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SummonSlot } from "@/components/agents/SummonSlot";
import { PromptProfileFields } from "@/components/prompts/PromptProfileFields";
import { AGENT_TOOL_CATALOG, AGENT_TOOL_LABELS, ROUTES } from "@/lib/constants";
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
import type { Agent, ExpertGroup, ExpertGroupMode, IMPlatform } from "@/types";
import {
  isBuiltinAgentId,
  isBuiltinGroupId,
  EXPERT_GROUP_MODE_LABEL,
  EXPERT_GROUP_MODE_DESC,
} from "@/types";

/** IM 平台中文标签 */
const PLATFORM_LABEL: Record<IMPlatform, string> = {
  wecom: "企业微信",
  feishu: "飞书",
  dingtalk: "钉钉",
  slack: "Slack",
  telegram: "Telegram",
  other: "其他",
};

/** 页内分段 tab：专家（单 Agent）/ 专家团（多 Agent 编排） */
type PageTab = "agents" | "groups";

const EMPTY: Partial<Agent> = {
  name: "",
  systemPrompt: "",
  skillIds: [],
  imBinding: null,
  enabled: true,
};

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

  /** 全局提示词档案：Agent 级覆盖未设置时展示「跟随全局」的继承结果 */
  const settings = useSettingsStore((s) => s.settings);

  const [tab, setTab] = useState<PageTab>("agents");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [form, setForm] = useState<Partial<Agent>>(EMPTY);
  const [toDelete, setToDelete] = useState<string | null>(null);

  const [groupOpen, setGroupOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ExpertGroup | null>(null);
  const [groupForm, setGroupForm] = useState<Partial<ExpertGroup>>(EMPTY_GROUP);
  const [groupToDelete, setGroupToDelete] = useState<string | null>(null);

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
    setForm(EMPTY);
    setOpen(true);
  };
  const openEdit = (a: Agent) => {
    setEditing(a);
    setForm({ ...a });
    setOpen(true);
  };
  const save = () => {
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

  const toggleImBinding = () => {
    if (form.imBinding) {
      setForm({ ...form, imBinding: null });
    } else {
      setForm({
        ...form,
        imBinding: {
          platform: "feishu",
          account: "",
          status: "online",
          lastSyncAt: new Date().toISOString(),
        },
      });
    }
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

  /** 卡片底部：启用开关（常驻可点）+ 编辑 / 删除（半透明，hover 回到全亮）。 */
  const renderFooter = (
    enabled: boolean,
    onToggle: () => void,
    onEdit: () => void,
    onDelete: () => void,
    deleteDisabled: boolean,
    label: string,
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
    <Box sx={{ p: 3, maxWidth: 1100, margin: "0 auto" }}>
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
            onClick={tab === "agents" ? openNew : openNewGroup}
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

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{editing ? "编辑专家" : "新建专家"}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            margin="dense"
            label="名称"
            value={form.name ?? ""}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextField
            fullWidth
            margin="dense"
            multiline
            minRows={3}
            label="系统身份提示"
            value={form.systemPrompt ?? ""}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          />
          <Typography sx={{ fontSize: 13, mt: 1, mb: 0.5 }}>
            绑定技能
          </Typography>
          <Select
            fullWidth
            multiple
            value={form.skillIds ?? []}
            onChange={(e) =>
              setForm({ ...form, skillIds: e.target.value as string[] })
            }
            renderValue={(sel) =>
              (sel as string[])
                .map((id) => skills.find((s) => s.id === id)?.name ?? id)
                .join("、")
            }
          >
            {skills.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.name}
              </MenuItem>
            ))}
          </Select>

          {/* 领域 / 风格覆盖（design §13.1）：留空 = 跟随全局设置。
              刻意不预填全局值——把「跟随」落成具体值后，改全局就再也影响不到
              这个 Agent，而用户根本没做过这个决定。 */}
          <PromptProfileFields
            domain={form.promptDomain}
            style={form.promptStyle}
            allowInherit
            globalDomain={settings.promptDomain}
            globalStyle={settings.promptStyle}
            label="领域 / 风格覆盖（可选）"
            onDomainChange={(v) => setForm({ ...form, promptDomain: v })}
            onStyleChange={(v) => setForm({ ...form, promptStyle: v })}
          />

          {/* 工具权限（FR-2.2）：在引擎的工具网关强制，不依赖系统提示词。
              关掉开关 = 不声明限制（undefined）；打开 = 声明白名单。
              两者必须保持可区分——把「没设置」落成空数组会把这个 Agent 直接锁死。 */}
          <Divider sx={{ my: 1.5 }} />
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
            工具权限（FR-2.2）
          </Typography>
          <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.5 }}>
            白名单在引擎侧强制：不在名单里的工具连调用都会被拒，改提示词也绕不过。
          </Typography>
          <FormControlLabel
            sx={{ mt: 0.5 }}
            control={
              <Switch
                size="small"
                checked={form.toolAllow !== undefined}
                onChange={(e) =>
                  setForm({
                    ...form,
                    // 打开时默认全选（等于「先不收紧，再逐个取消」），关掉时回到
                    // undefined（不限制）而不是空数组（一个都不许）。
                    toolAllow: e.target.checked
                      ? [...AGENT_TOOL_CATALOG]
                      : undefined,
                  })
                }
              />
            }
            label={
              <Typography sx={{ fontSize: 13 }}>
                仅允许指定工具（最小权限）
              </Typography>
            }
          />
          {form.toolAllow !== undefined && (
            <Autocomplete
              multiple
              freeSolo
              size="small"
              sx={{ mt: 1 }}
              options={[...AGENT_TOOL_CATALOG]}
              getOptionLabel={(o) => String(o)}
              value={form.toolAllow}
              onChange={(_e, value) =>
                setForm({ ...form, toolAllow: value.map((v) => String(v)) })
              }
              renderOption={(props, option) => (
                <li {...props} key={option}>
                  <Box>
                    <Typography sx={{ fontSize: 13 }}>{option}</Typography>
                    {AGENT_TOOL_LABELS[option] && (
                      <Typography
                        sx={{ fontSize: 11, color: "text.secondary" }}
                      >
                        {AGENT_TOOL_LABELS[option]}
                      </Typography>
                    )}
                  </Box>
                </li>
              )}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="允许的工具"
                  placeholder="留空 = 一个工具都不许"
                  helperText="可输入 MCP 工具名（如 mcp__github__create_issue）"
                />
              )}
            />
          )}
          <Autocomplete
            multiple
            freeSolo
            size="small"
            sx={{ mt: 1 }}
            options={[...AGENT_TOOL_CATALOG]}
            getOptionLabel={(o) => String(o)}
            value={form.toolDeny ?? []}
            onChange={(_e, value) => {
              const next = value.map((v) => String(v));
              setForm({ ...form, toolDeny: next.length ? next : undefined });
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="禁止的工具（可选）"
                placeholder="优先级高于上面的白名单"
                helperText="用于在宽白名单上精确挖掉个别危险工具"
              />
            )}
          />

          <Divider sx={{ my: 1.5 }} />
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
              IM 远程控制（FR-010）
            </Typography>
            {form.imBinding && (
              <Chip
                size="small"
                color={
                  form.imBinding.status === "online" ? "secondary" : "default"
                }
                label={PLATFORM_LABEL[form.imBinding.platform]}
              />
            )}
          </Box>
          {form.imBinding ? (
            <Box sx={{ mt: 1 }}>
              <Select
                fullWidth
                value={form.imBinding.platform}
                onChange={(e) =>
                  setForm({
                    ...form,
                    imBinding: {
                      ...form.imBinding!,
                      platform: e.target.value as IMPlatform,
                    },
                  })
                }
              >
                {(Object.keys(PLATFORM_LABEL) as IMPlatform[]).map((p) => (
                  <MenuItem key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </MenuItem>
                ))}
              </Select>
              <TextField
                fullWidth
                margin="dense"
                label="账号 / 机器人标识"
                value={form.imBinding.account}
                onChange={(e) =>
                  setForm({
                    ...form,
                    imBinding: { ...form.imBinding!, account: e.target.value },
                  })
                }
              />
              <Button
                size="small"
                color="warning"
                sx={{ mt: 1 }}
                onClick={toggleImBinding}
              >
                解绑
              </Button>
            </Box>
          ) : (
            <Button
              size="small"
              variant="outlined"
              sx={{ mt: 1 }}
              onClick={toggleImBinding}
            >
              绑定 IM
            </Button>
          )}
          <Typography variant="caption" color="text.secondary">
            真实绑定推送依赖 nanobot 运行时（IM 网关）；此处先记录本地配置。
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setOpen(false)}>取消</Button>
          <Button
            variant="contained"
            onClick={save}
            disabled={!form.name?.trim()}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

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
