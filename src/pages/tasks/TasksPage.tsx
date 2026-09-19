import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  ListItemIcon,
  Menu,
  MenuItem,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";
import LibraryAddIcon from "@mui/icons-material/LibraryAdd";
import ChecklistIcon from "@mui/icons-material/Checklist";
import EditIcon from "@mui/icons-material/Edit";
import CloseIcon from "@mui/icons-material/Close";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import PauseIcon from "@mui/icons-material/Pause";
import PlayCircleOutlinedIcon from "@mui/icons-material/PlayCircleOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { useTasksStore } from "@/stores/tasksStore";
import { useAgentsStore } from "@/stores/agentsStore";
import { useSessionsStore } from "@/stores/sessionsStore";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TaskFormDialog } from "@/components/tasks/TaskFormDialog";
import { MarkdownView } from "@/components/MarkdownView";
import { platform } from "@/platform";
import { describeSchedule, nextCronRunMs } from "@/lib/cron";
import { toast } from "@/components/Toast";
import { ROUTES } from "@/lib/constants";
import type { TaskConfig, TaskRunRecord } from "@/types";
import type { TaskDraft } from "@/lib/taskDraft";

interface AutomationTemplate {
  name: string;
  description: string;
  draft: TaskDraft;
}

const TEMPLATES: AutomationTemplate[] = [
  {
    name: "每日 AI 新闻推送",
    description: "每天早上 9 点让 Agent 汇总并推送 AI 新闻",
    draft: {
      name: "每日 AI 新闻推送",
      prompt: "帮我搜索并总结今天最重要的 AI 行业新闻，用中文输出简报。",
      agentId: "",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      status: "enabled",
    },
  },
  {
    name: "定时备份提醒",
    description: "每小时提醒一次检查关键数据备份",
    draft: {
      name: "定时备份提醒",
      prompt: "提醒我今天的重要备份是否已完成，如果没有请给出检查清单。",
      agentId: "",
      schedule: { kind: "interval", minutes: 60 },
      status: "enabled",
    },
  },
  {
    name: "市场开盘监控",
    description: "工作日早上 9:30 让 Agent 扫描市场动态",
    draft: {
      name: "市场开盘监控",
      prompt: "总结今日 A 股/美股开盘前的关键消息面与盘前数据。",
      agentId: "",
      schedule: { kind: "cron", expr: "30 9 * * 1-5" },
      status: "enabled",
    },
  },
];

/** 自动化管理页（FR-005）：Tab 分「定时任务 / 运行记录」，含搜索、批量、模板、新增 */
export function TasksPage() {
  const tasks = useTasksStore((s) => s.tasks);
  const runs = useTasksStore((s) => s.runs);
  const addTask = useTasksStore((s) => s.addTask);
  const updateTask = useTasksStore((s) => s.updateTask);
  const removeTask = useTasksStore((s) => s.removeTask);
  const runTask = useTasksStore((s) => s.runTask);
  const toggleTask = useTasksStore((s) => s.toggleTask);
  const openCronSession = useTasksStore((s) => s.openCronSession);
  const navigate = useNavigate();
  const agents = useAgentsStore((s) => s.agents);
  const agentMap = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.id, a.name])),
    [agents],
  );

  const [tab, setTab] = useState<"scheduled" | "runs">("scheduled");
  const [query, setQuery] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TaskConfig | null>(null);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  /** 顶部提示条可见性（会话内可关闭） */
  const [tipVisible, setTipVisible] = useState(true);
  /** 正在测试运行的任务 id（按钮转圈） */
  const [runningId, setRunningId] = useState<string | null>(null);
  /** 当前悬停的任务 id：用于切换右槽「下次执行时间文字」↔「运行/更多图标」 */
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** 行内「更多操作」菜单：anchorEl 指向触发按钮，taskId 记录当前任务 */
  const [taskMenu, setTaskMenu] = useState<{
    anchorEl: HTMLElement | null;
    taskId: string | null;
  }>({ anchorEl: null, taskId: null });

  /** 派生「正在执行」的任务 id 集合：以运行记录为准，对话未结束期间保持运行中 */
  const runningTaskIds = useMemo(
    () =>
      new Set(runs.filter((r) => r.status === "running").map((r) => r.taskId)),
    [runs],
  );

  /**
   * 按 taskId 索引「最近一次 startedAt」（含 manual 与 scheduled 触发），
   * 用于下次执行时间估算：interval 任务用「上次 + 间隔」基准，once 任务则直接看预定时间。
   * runs 已按开始时间倒序，第一个匹配就是最近。
   */
  const lastRunByTask = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of runs) {
      if (m.has(r.taskId)) continue;
      m.set(r.taskId, r.startedAt);
    }
    return m;
  }, [runs]);

  /** 测试运行：真实执行并跳转会话查看过程 */
  const handleRun = async (t: TaskConfig) => {
    if (runningId) {
      toast.error("已有任务正在执行，请稍后再试");
      return;
    }
    setRunningId(t.id);
    navigate(ROUTES.chat);
    try {
      await runTask(t.id);
    } finally {
      setRunningId(null);
    }
  };

  /** 「更多操作」菜单项回调：暂停↔启动 与 删除 */
  const handleTaskAction = (
    action: "toggle" | "delete",
    taskId: string | null,
  ) => {
    setTaskMenu((prev) => ({ ...prev, anchorEl: null }));
    if (!taskId) return;
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    if (action === "toggle") {
      const willEnable = t.status === "disabled";
      toggleTask(taskId);
      toast.success(willEnable ? "已启动" : "已暂停");
    } else if (action === "delete") {
      setToDelete(taskId);
    }
  };

  const filteredTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) => {
      const agentName = agentMap[t.agentId] ?? "";
      return (
        t.name.toLowerCase().includes(q) ||
        t.prompt.toLowerCase().includes(q) ||
        agentName.toLowerCase().includes(q) ||
        describeSchedule(t.schedule).toLowerCase().includes(q)
      );
    });
  }, [tasks, query, agentMap]);

  const openNew = () => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (t: TaskConfig) => {
    setEditing(t);
    setOpen(true);
  };
  const handleSubmit = (data: TaskDraft) => {
    if (editing) updateTask(editing.id, data);
    else addTask(data);
    setOpen(false);
    setEditing(null);
  };

  const handleTemplateCreate = (tpl: AutomationTemplate) => {
    const draft: TaskDraft = {
      ...tpl.draft,
      agentId: agents[0]?.id ?? "",
    };
    addTask(draft);
    setTemplateOpen(false);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const handleBatchDelete = () => {
    selected.forEach((id) => removeTask(id));
    setSelected(new Set());
    setBatchMode(false);
  };

  const allSelected =
    filteredTasks.length > 0 && filteredTasks.every((t) => selected.has(t.id));
  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        filteredTasks.forEach((t) => next.delete(t.id));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        filteredTasks.forEach((t) => next.add(t.id));
        return next;
      });
    }
  };

  return (
    <Box sx={{ p: 3, maxWidth: "100%", margin: "0 auto" }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>
        自动化
      </Typography>

      {/* 顶部提示条：执行依赖客户端在线，可关闭 */}
      <Collapse in={tipVisible}>
        <Alert
          severity="info"
          sx={{ mb: 2, borderRadius: 2 }}
          action={
            <IconButton size="small" onClick={() => setTipVisible(false)}>
              <CloseIcon fontSize="small" />
            </IconButton>
          }
        >
          自动化任务执行时，请勿关闭电脑或退出客户端，否则任务将无法正常执行
        </Alert>
      </Collapse>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        textColor="primary"
        indicatorColor="primary"
        sx={{ mb: 2, minHeight: 36 }}
      >
        <Tab
          value="scheduled"
          label="定时任务"
          sx={{ textTransform: "none", minHeight: 36 }}
        />
        <Tab
          value="runs"
          label="运行记录"
          sx={{ textTransform: "none", minHeight: 36 }}
        />
      </Tabs>

      {tab === "scheduled" && (
        <>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.5,
              mb: 2,
              flexWrap: "wrap",
            }}
          >
            <TextField
              size="small"
              placeholder="搜索自动化/记录"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon
                      sx={{ fontSize: 18, color: "text.secondary" }}
                    />
                  </InputAdornment>
                ),
                sx: {
                  bgcolor: "background.paper",
                  borderRadius: 2,
                  minWidth: 260,
                  "& fieldset": { borderColor: "divider" },
                },
              }}
            />
            <Box sx={{ flex: 1 }} />
            {batchMode && selected.size > 0 && (
              <Button
                size="small"
                variant="outlined"
                color="error"
                onClick={handleBatchDelete}
              >
                删除选中 ({selected.size})
              </Button>
            )}
            <Button
              size="small"
              variant={batchMode ? "contained" : "outlined"}
              startIcon={<ChecklistIcon />}
              onClick={() => {
                setBatchMode((v) => !v);
                setSelected(new Set());
              }}
            >
              {batchMode ? "退出批量" : "批量管理"}
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<LibraryAddIcon />}
              onClick={() => setTemplateOpen(true)}
            >
              从模板添加
            </Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<AddIcon />}
              onClick={openNew}
            >
              添加自动化
            </Button>
          </Box>

          {tasks.length === 0 && (
            <Box
              sx={{
                p: 6,
                textAlign: "center",
                bgcolor: "background.paper",
                borderRadius: 3,
                border: "1px solid",
                borderColor: "divider",
              }}
            >
              <Typography color="text.secondary">暂无自动化任务</Typography>
              <Typography color="text.secondary" sx={{ fontSize: 13, mt: 0.5 }}>
                点击右上角「添加自动化」或「从模板添加」创建第一条定时任务。
              </Typography>
            </Box>
          )}

          {tasks.length > 0 && filteredTasks.length === 0 && (
            <Typography color="text.secondary" sx={{ mt: 2 }}>
              没有匹配「{query}」的自动化任务
            </Typography>
          )}

          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {batchMode && filteredTasks.length > 0 && (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  px: 2,
                  py: 1,
                  bgcolor: "background.paper",
                  borderRadius: 2,
                  border: "1px solid",
                  borderColor: "divider",
                }}
              >
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                    />
                  }
                  label="全选"
                />
                <Box sx={{ flex: 1 }} />
                <Typography color="text.secondary" sx={{ fontSize: 13 }}>
                  已选 {selected.size} 项
                </Typography>
              </Box>
            )}

            {filteredTasks.map((t) => {
              const isRunning = runningTaskIds.has(t.id);
              const status = taskStatusView(t, isRunning);
              // 一次性预算本行的「下次执行时间」，保证 hover/非 hover 切换时值稳定，
              // 避免每渲染走一次 `now` 抖动导致数字跳动
              const nowMs = Date.now();
              const targetMs = nextRunAtMs(t, lastRunByTask.get(t.id), nowMs);
              const isHovered = hoverId === t.id;
              return (
                <Box
                  key={t.id}
                  onMouseEnter={() => setHoverId(t.id)}
                  onMouseLeave={() =>
                    setHoverId((v) => (v === t.id ? null : v))
                  }
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    px: 2,
                    py: 1.5,
                    bgcolor: "background.paper",
                    borderRadius: 2,
                    border: "1px solid",
                    borderColor: "divider",
                    "&:hover": { borderColor: "var(--hover-border)" },
                  }}
                >
                  {batchMode && (
                    <Switch
                      size="small"
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelect(t.id)}
                      sx={{ mr: 1.5 }}
                    />
                  )}
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography fontWeight={600} noWrap>
                      {t.name}
                    </Typography>
                    <Typography
                      sx={{
                        fontSize: 13,
                        color: "text.secondary",
                        mt: 0.25,
                      }}
                      noWrap
                    >
                      自动化任务 · {describeSchedule(t.schedule)} · 目标：
                      {agentMap[t.agentId] ?? "未指定"}
                      {t.prompt ? ` · ${t.prompt}` : ""}
                    </Typography>
                  </Box>
                  {/*
                   * 右槽布局：固定 minWidth 保证 hover/非 hover 切换时容器尺寸稳定。
                   * 文字层与图标层均**绝对定位叠在同一容器内**，并通过 opacity 切换可见性，
                   * 而非条件渲染——后者会导致 hover 层的 IconButton 在点击瞬间才挂载到 DOM，
                   * MUI Menu 拿到 `e.currentTarget` 后定位失败、fallback 到 body 左上角。
                   * 文字层 hover 时 `opacity: 0` 淡出，避免「时间 + 图标」叠在同一个像素上。
                   */}
                  {!batchMode && (
                    <Box
                      sx={{
                        position: "relative",
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        ml: 2,
                        minWidth: 160,
                        height: 32,
                        justifyContent: "flex-end",
                      }}
                    >
                      {status && (
                        <Chip
                          size="small"
                          label={status.label}
                          color={status.color}
                          sx={{ fontWeight: 500 }}
                        />
                      )}
                      <Box
                        sx={{
                          position: "relative",
                          minWidth: 110,
                          height: 32,
                        }}
                      >
                        {/* 默认层：下次执行时间文字，仅当「启用 + 未运行」且可估算时渲染；
                          hover 时通过 opacity 让位给图标层，避免视觉重叠 */}
                        {!isRunning &&
                          t.status === "enabled" &&
                          targetMs !== null && (
                            <Typography
                              sx={{
                                position: "absolute",
                                right: 0,
                                top: "50%",
                                transform: "translateY(-50%)",
                                fontSize: 13,
                                color: "text.secondary",
                                whiteSpace: "nowrap",
                                // hover 时淡出，避免与下方的图标叠在同一像素上
                                opacity: isHovered ? 0 : 1,
                                transition: "opacity .12s",
                              }}
                            >
                              {formatNextRun(targetMs, nowMs)}
                            </Typography>
                          )}
                        {/* 已暂停时右侧用文字「已暂停」替代下次执行时间；同样 hover 时淡出 */}
                        {!isRunning && t.status === "disabled" && (
                          <Typography
                            sx={{
                              position: "absolute",
                              right: 0,
                              top: "50%",
                              transform: "translateY(-50%)",
                              fontSize: 13,
                              color: "text.secondary",
                              whiteSpace: "nowrap",
                              opacity: isHovered ? 0 : 1,
                              transition: "opacity .12s",
                            }}
                          >
                            已暂停
                          </Typography>
                        )}
                        {/*
                         * hover 图标层：**始终存在于 DOM**，仅靠 opacity + pointerEvents 切换可见性。
                         * 这样 ⋮ IconButton 的 DOM 节点在点击瞬间是稳定的，MUI Menu 拿到
                         * 的 `e.currentTarget` / `getBoundingClientRect` 都是有效值，
                         * 菜单位置会稳定锚到 ⋮ 按钮的右下角，不再漂到 body 左上角。
                         */}
                        <Box
                          sx={{
                            position: "absolute",
                            right: -8,
                            top: 0,
                            display: "flex",
                            alignItems: "center",
                            gap: 0.5,
                            opacity: isHovered ? 1 : 0,
                            pointerEvents: isHovered ? "auto" : "none",
                            transition: "opacity .12s",
                          }}
                        >
                          <Tooltip title="测试运行">
                            <span>
                              <IconButton
                                size="small"
                                sx={{ p: 0.5 }}
                                disabled={runningId !== null}
                                onClick={() => handleRun(t)}
                              >
                                {runningId === t.id ? (
                                  <CircularProgress size={16} />
                                ) : (
                                  <PlayArrowIcon sx={{ fontSize: 18 }} />
                                )}
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="更多操作" placement="top">
                            <IconButton
                              size="small"
                              sx={{ p: 0.5 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setTaskMenu({
                                  anchorEl: e.currentTarget,
                                  taskId: t.id,
                                });
                              }}
                            >
                              <MoreVertIcon sx={{ fontSize: 18 }} />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      </Box>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        </>
      )}

      {tab === "runs" && (
        <RunRecordList
          runs={runs}
          query={query}
          onOpenSession={(sid) => {
            useSessionsStore.getState().selectSession(sid);
            navigate(ROUTES.chat);
          }}
          onOpenCronSession={async (taskId, title) => {
            const opened = await openCronSession(taskId, title);
            if (!opened) {
              toast.error("该任务暂无执行会话（可能尚未实际执行）");
              return;
            }
            navigate(ROUTES.chat);
          }}
        />
      )}

      <TaskFormDialog
        key={editing?.id ?? "new"}
        open={open}
        title={editing ? "编辑自动化" : "添加自动化"}
        initial={editing ?? { agentId: agents[0]?.id }}
        onSubmit={handleSubmit}
        onClose={() => setOpen(false)}
      />

      <ConfirmDialog
        open={!!toDelete}
        title="删除自动化"
        message="确认删除该自动化任务？"
        danger
        confirmText="删除"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) removeTask(toDelete);
          setToDelete(null);
        }}
      />

      {/*
       * 「更多操作」菜单：hover 时 ⋮ 触发。
       * 三个动作：
       * - 编辑：保留 hover 槽外的编辑入口（之前固定显示的 ✎ 改到这里，避免 hover 槽拥挤）
       * - 暂停/启动：根据当前 status 反向展示
       * - 删除：红色，与其他危险操作一致
       */}
      <Menu
        anchorEl={taskMenu.anchorEl}
        open={!!taskMenu.anchorEl}
        onClose={() => setTaskMenu((prev) => ({ ...prev, anchorEl: null }))}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        PaperProps={{ sx: { minWidth: 140 } }}
      >
        <MenuItem
          onClick={() => {
            const id = taskMenu.taskId;
            const t = tasks.find((x) => x.id === id);
            setTaskMenu((prev) => ({ ...prev, anchorEl: null }));
            if (t) openEdit(t);
          }}
        >
          <ListItemIcon>
            <EditIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>编辑</Typography>
        </MenuItem>
        <MenuItem onClick={() => handleTaskAction("toggle", taskMenu.taskId)}>
          <ListItemIcon>
            {tasks.find((x) => x.id === taskMenu.taskId)?.status ===
            "disabled" ? (
              <PlayCircleOutlinedIcon fontSize="small" />
            ) : (
              <PauseIcon fontSize="small" />
            )}
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>
            {tasks.find((x) => x.id === taskMenu.taskId)?.status === "disabled"
              ? "启动"
              : "暂停"}
          </Typography>
        </MenuItem>
        <MenuItem
          onClick={() => handleTaskAction("delete", taskMenu.taskId)}
          sx={{ color: "error.main" }}
        >
          <ListItemIcon sx={{ color: "error.main" }}>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>删除</Typography>
        </MenuItem>
      </Menu>

      <Dialog
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>从模板添加自动化</DialogTitle>
        <DialogContent>
          <Box
            sx={{ display: "flex", flexDirection: "column", gap: 1.5, pt: 0.5 }}
          >
            {TEMPLATES.map((tpl) => (
              <Box
                key={tpl.name}
                onClick={() => handleTemplateCreate(tpl)}
                sx={{
                  p: 2,
                  borderRadius: 2,
                  border: "1px solid",
                  borderColor: "divider",
                  bgcolor: "background.paper",
                  cursor: "pointer",
                  "&:hover": {
                    borderColor: "primary.main",
                    bgcolor: "action.hover",
                  },
                }}
              >
                <Typography fontWeight={600}>{tpl.name}</Typography>
                <Typography
                  sx={{ fontSize: 13, color: "text.secondary", mt: 0.5 }}
                >
                  {tpl.description}
                </Typography>
                <Typography
                  sx={{ fontSize: 12, color: "text.secondary", mt: 0.5 }}
                >
                  {describeSchedule(tpl.draft.schedule)}
                </Typography>
              </Box>
            ))}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setTemplateOpen(false)}>取消</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

/**
 * 任务卡片状态 Chip 的展示配置。
 * 默认状态（启用 + 未运行）不显示 chip；只有「正在运行」「已暂停」才提示。
 * @returns Chip props；null 表示不渲染 chip
 */
function taskStatusView(
  t: TaskConfig,
  isRunning: boolean,
): {
  label: string;
  color: "success" | "default";
} | null {
  if (t.status === "disabled") return { label: "已暂停", color: "default" };
  if (isRunning) return { label: "运行中", color: "success" };
  // enabled + 未运行：默认不显示 chip（避免「未运行」噪音）
  return null;
}

/**
 * 估算任务的下次触发时间戳。
 * - interval：取「上次执行 + interval」若仍未来，否则取 now + interval（表示错过了再延一个周期）；
 * - cron：复用 nanobot 引擎同语义的 nextCronRunMs，基准 = 上次执行时间（无则 now）；
 * - once：单次任务的预定时间；可能已过（用于「即将执行」/已结束的渲染）。
 */
function nextRunAtMs(
  task: TaskConfig,
  lastStartedAt: string | undefined,
  now: number,
): number | null {
  const s = task.schedule;
  if (s.kind === "interval") {
    const ms = s.minutes * 60_000;
    const fromLast = lastStartedAt ? Date.parse(lastStartedAt) + ms : null;
    if (fromLast !== null && fromLast > now) return fromLast;
    return now + ms;
  }
  if (s.kind === "cron") {
    return nextCronRunMs(
      s.expr,
      lastStartedAt ? Date.parse(lastStartedAt) : now,
    );
  }
  if (s.kind === "once") {
    const ms = Date.parse(s.at);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** 把下次执行时间渲染为中文相对时间：「X 分钟后执行 / X 小时后执行 / X 天后执行 / 即将执行」 */
function formatNextRun(targetMs: number, now: number): string {
  const diff = targetMs - now;
  if (diff <= 0) return "即将执行";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "即将执行";
  if (min < 60) return `${min}分钟后执行`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时后执行`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天后执行`;
  const d = new Date(targetMs);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 运行记录状态 → 展示文案/颜色 */
function runStatusView(r: TaskRunRecord): { text: string; color?: string } {
  switch (r.status) {
    case "running":
      return { text: "运行中", color: "primary.main" };
    case "success":
      return {
        text: r.trigger === "manual" ? "测试运行完成" : "已完成",
        color: "success.main",
      };
    case "error":
      return {
        text: r.error === "已中断" ? "已中断" : "执行失败",
        color: "error.main",
      };
    default:
      return { text: r.status };
  }
}

/** 耗时格式化：<1s 显示 ms，否则 s（保留 1 位） */
function formatDuration(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 日期分组标签：今天 / 昨天 / YYYY-MM-DD */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(d, today)) return "今天";
  if (same(d, yest)) return "昨天";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 时间 HH:mm */
function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface RunRecordListProps {
  runs: TaskRunRecord[];
  query: string;
  onOpenSession: (sessionId: string) => void;
  /** 定时触发记录：跳转聊天页查看引擎执行会话（只读） */
  onOpenCronSession: (taskId: string, title: string) => void;
}

/**
 * 运行记录列表：按日期分组（今天/昨天/日期），条目可展开查看
 * 触发方式、耗时、失败原因，并可跳转关联会话查看完整执行过程。
 */
function RunRecordList({
  runs,
  query,
  onOpenSession,
  onOpenCronSession,
}: RunRecordListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((r) => r.taskName.toLowerCase().includes(q));
  }, [runs, query]);

  const groups = useMemo(() => {
    const map = new Map<string, TaskRunRecord[]>();
    for (const r of filtered) {
      const key = dayLabel(r.startedAt);
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [filtered]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (runs.length === 0) {
    return (
      <Box
        sx={{
          p: 6,
          textAlign: "center",
          bgcolor: "background.paper",
          borderRadius: 3,
          border: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography color="text.secondary">暂无运行记录</Typography>
        <Typography color="text.secondary" sx={{ fontSize: 13, mt: 0.5 }}>
          定时任务的自动执行与测试运行记录将显示在这里。
        </Typography>
      </Box>
    );
  }

  if (filtered.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ mt: 2 }}>
        没有匹配「{query}」的运行记录
      </Typography>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {groups.map(([day, list]) => (
        <Box key={day}>
          <Typography color="text.secondary" sx={{ fontSize: 13, mb: 1 }}>
            {day}
          </Typography>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {list.map((r) => {
              const st = runStatusView(r);
              const isOpen = expanded.has(r.id);
              return (
                <Box
                  key={r.id}
                  sx={{
                    bgcolor: "background.paper",
                    borderRadius: 2,
                    border: "1px solid",
                    borderColor: "divider",
                    overflow: "hidden",
                  }}
                >
                  <Box
                    onClick={() => toggle(r.id)}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1.5,
                      px: 2,
                      py: 1.25,
                      cursor: "pointer",
                      "&:hover": { bgcolor: "action.hover" },
                    }}
                  >
                    <Typography fontWeight={600} noWrap sx={{ maxWidth: 260 }}>
                      {r.taskName}
                    </Typography>
                    <Typography
                      sx={{ fontSize: 13, color: st.color ?? "text.secondary" }}
                    >
                      {st.text}
                    </Typography>
                    {r.status === "running" && <CircularProgress size={14} />}
                    <Box sx={{ flex: 1 }} />
                    <Typography color="text.secondary" sx={{ fontSize: 13 }}>
                      {hhmm(r.startedAt)}
                    </Typography>
                    <ExpandMoreIcon
                      sx={{
                        fontSize: 18,
                        color: "text.secondary",
                        transition: "transform .15s",
                        transform: isOpen ? "rotate(180deg)" : "none",
                      }}
                    />
                  </Box>
                  <Collapse in={isOpen} unmountOnExit>
                    <Box
                      sx={{
                        px: 2,
                        py: 1.5,
                        borderTop: "1px solid",
                        borderColor: "divider",
                        display: "flex",
                        flexDirection: "column",
                        gap: 0.75,
                      }}
                    >
                      <Typography
                        sx={{ fontSize: 13, color: "text.secondary" }}
                      >
                        触发方式：
                        {r.trigger === "manual" ? "测试运行" : "定时触发"}
                        {r.durationMs != null
                          ? ` · 耗时 ${formatDuration(r.durationMs)}`
                          : ""}
                        {r.finishedAt ? ` · 结束 ${hhmm(r.finishedAt)}` : ""}
                      </Typography>
                      {r.error && (
                        <Typography sx={{ fontSize: 13, color: "error.main" }}>
                          失败原因：{r.error}
                        </Typography>
                      )}
                      {r.trigger === "scheduled" && r.sessionKey && (
                        <>
                          <Button
                            size="small"
                            variant="outlined"
                            sx={{ alignSelf: "flex-start" }}
                            onClick={() =>
                              onOpenCronSession(r.taskId, r.taskName)
                            }
                          >
                            查看对话
                          </Button>
                          <CronSessionView taskId={r.taskId} />
                        </>
                      )}
                      {r.sessionId && (
                        <Button
                          size="small"
                          variant="outlined"
                          sx={{ alignSelf: "flex-start" }}
                          onClick={() => onOpenSession(r.sessionId!)}
                        >
                          查看会话
                        </Button>
                      )}
                    </Box>
                  </Collapse>
                </Box>
              );
            })}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** 引擎会话消息行（JSONL 原始记录的宽松视图） */
interface CronMessageRow {
  role?: string;
  content?: string;
  tool_calls?: Array<{ function?: { name?: string } }>;
}

/** 去掉引擎注入的触发前缀，仅保留任务提示词正文 */
function stripCronPrefix(content: string): string {
  return content.replace(/^Scheduled cron job triggered:[^\n]*\n+/, "");
}

/**
 * 定时任务执行会话视图：展开运行记录时经主进程只读拉取
 * `api:cron-{taskId}` 会话（引擎执行留痕），按角色渲染：
 * 用户（触发提示词）/ 助手（工具调用 + Markdown 回复）/ 工具结果。
 */
function CronSessionView({ taskId }: { taskId: string }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<CronMessageRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    platform
      .getCronSession(taskId)
      .then((detail) => {
        if (cancelled) return;
        setRows(detail ? (detail.messages as CronMessageRow[]) : null);
      })
      .catch(() => {
        if (!cancelled) setRows(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (loading) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <CircularProgress size={14} />
        <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
          正在加载执行过程…
        </Typography>
      </Box>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
        暂无执行会话内容（任务可能尚未实际执行）。
      </Typography>
    );
  }

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        maxHeight: 420,
        overflowY: "auto",
        pr: 0.5,
      }}
    >
      {rows.map((m, i) => {
        const toolNames = (m.tool_calls ?? [])
          .map((tc) => tc?.function?.name)
          .filter((n): n is string => Boolean(n));
        if (m.role === "user") {
          return (
            <Box key={i}>
              <Typography
                sx={{ fontSize: 12, color: "text.secondary", mb: 0.25 }}
              >
                任务触发
              </Typography>
              <Typography sx={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                {stripCronPrefix(m.content ?? "")}
              </Typography>
            </Box>
          );
        }
        if (m.role === "assistant") {
          return (
            <Box key={i}>
              {toolNames.length > 0 && (
                <Box
                  sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mb: 0.5 }}
                >
                  {toolNames.map((n, j) => (
                    <Chip
                      key={j}
                      size="small"
                      label={`调用 ${n}`}
                      sx={{ height: 20, fontSize: 12 }}
                    />
                  ))}
                </Box>
              )}
              {m.content ? (
                <MarkdownView content={m.content} />
              ) : (
                !toolNames.length && (
                  <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
                    （空回复）
                  </Typography>
                )
              )}
            </Box>
          );
        }
        if (m.role === "tool") {
          return (
            <Box
              key={i}
              sx={{
                fontSize: 12,
                color: "text.secondary",
                bgcolor: "action.hover",
                borderRadius: 1,
                px: 1,
                py: 0.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 140,
                overflowY: "auto",
              }}
            >
              {m.content ?? ""}
            </Box>
          );
        }
        return null;
      })}
    </Box>
  );
}
