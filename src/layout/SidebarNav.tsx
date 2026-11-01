import type { ReactNode } from "react";
import { cloneElement, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddCommentIcon from "@mui/icons-material/AddComment";
import AccessAlarmIcon from "@mui/icons-material/AccessAlarm";
import PsychologyIcon from "@mui/icons-material/Psychology";
import GridViewIcon from "@mui/icons-material/GridView";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import HubIcon from "@mui/icons-material/Hub";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import WorkOutlineIcon from "@mui/icons-material/WorkOutline";
import WidgetsOutlinedIcon from "@mui/icons-material/WidgetsOutlined";
import HistoryIcon from "@mui/icons-material/History";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import FolderIcon from "@mui/icons-material/Folder";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import FolderCopyIcon from "@mui/icons-material/FolderCopy";
import ShareIcon from "@mui/icons-material/Share";
import EditIcon from "@mui/icons-material/Edit";
import {
  ROUTES,
  APP_DISPLAY_NAME,
  APP_DISPLAY_SUB,
  UNBOUND_AGENT_LABEL,
} from "@/lib/core/constants";
import { channelLabel } from "@/lib/channel/channelLabel";
import {
  CHANNEL_SESSION_ID_PREFIX,
  channelGroupKey,
  channelIconKind,
} from "@/lib/channel/channelSession";
import { conversationCount, hasConversation } from "@/lib/session/conversation";
import { CRON_SESSION_ID_PREFIX } from "@/lib/session/sessionImport";
import { filterTasks, isFilterDefault } from "@/lib/task/taskQuery";
import {
  DEFAULT_WORKSPACE_LABEL,
  isSameWorkspacePath,
  resolveWorkspaceLabel,
} from "@/lib/workspace/workspaceLabel";
import { useSessionsStore } from "@/stores/sessionsStore";
import { useChannelSessionsStore } from "@/stores/channelSessionsStore";
import { useSessionUiStore } from "@/stores/sessionUiStore";
import { useAgentsStore } from "@/stores/agentsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useDefaultWorkspacePath } from "@/stores/storageInfoStore";
import { useTaskQueryStore } from "@/stores/taskQueryStore";
import { useTasksStore } from "@/stores/tasksStore";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { LogoIcon } from "@/components/LogoIcon";
import { AccountEntry } from "@/components/AccountEntry";
import { ChannelIcon } from "@/components/im/ChannelIcon";
import { SessionQuickActions } from "@/components/session/SessionQuickActions";
import { platform } from "@/platform";
import { toast } from "@/components/Toast";
import type { NanobotChannelSessionSummary } from "@/platform/types";
import type { Session, TaskConfig } from "@/types";

/** 侧边栏行的最小形态：只要有图标和标题就能渲染 */
interface NavLinkItem {
  label: string;
  icon: ReactNode;
}

/**
 * 带路由目标的行。
 *
 * 与 `NavLinkItem` 分开，是因为「设置」这一行**没有路由**——它打开的是设置弹窗。
 * 把 `to` 设成可选再到处写 `?? 某个兜底路由`，就会让「少了目标」这种编码错误
 * 表现成一次静默跳转（跳到聊天页），比类型报错难查得多。
 */
interface NavRouteItem extends NavLinkItem {
  to: string;
}

const TOP_ACTION_ITEMS: NavRouteItem[] = [
  { label: "定时任务", icon: <AccessAlarmIcon />, to: ROUTES.tasks },
  { label: "审计", icon: <HistoryIcon />, to: ROUTES.audit },
];

/**
 * 扩展分组：装的是**能力**（专家 / 技能 / 连接器）。
 *
 * 「插件」已从这里移出到设置弹窗——插件是「把能力打包分发」的单位，装完基本不再动，
 * 留在日常操作区会让人以为它和技能 / 连接器是同一使用频率的东西。
 */
const LIBRARY_ITEMS: NavRouteItem[] = [
  { label: "专家", icon: <PsychologyIcon />, to: ROUTES.agents },
  { label: "技能", icon: <AutoFixHighIcon />, to: ROUTES.skills },
  { label: "连接器", icon: <HubIcon />, to: ROUTES.mcp },
  { label: "知识库", icon: <MenuBookIcon />, to: ROUTES.knowledge },
  { label: "项目", icon: <WorkOutlineIcon />, to: ROUTES.projects },
  { label: "扩展", icon: <WidgetsOutlinedIcon />, to: ROUTES.extensions },
];

/** 侧边栏主组件 */
export function SidebarNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const createSession = useSessionsStore((s) => s.createSession);

  const currentPath = location.pathname;

  /** 侧边栏折叠状态：由窗口标题栏最左侧图标切换，持久化在 settings */
  const sidebarCollapsed = useSettingsStore(
    (s) => s.settings.sidebarCollapsed ?? false,
  );

  /** 扩展分组折叠状态（默认收起） */
  const [expandOpen, setExpandOpen] = useState(false);
  const [expandHover, setExpandHover] = useState(false);

  /**
   * 新建任务：工作空间一律**回到「默认工作空间」**（不继承当前任务的 workdir）；
   * 权限策略（完全访问 / 逐条批准）仍继承，否则每建一个任务都要重设一遍。
   * 专家与技能**不继承**（`inheritCapabilities: false`）——新任务的输入框是一张白纸。
   *
   * 「在某个工作空间下开工」是另一条路径——侧边栏分组头的「新建任务」，
   * 它按分组带 workdir。两个入口分工明确，别再互相继承。
   */
  const handleNewSession = () => {
    const current = useSessionsStore
      .getState()
      .sessions.find((s) => s.id === useSessionsStore.getState().activeId);
    createSession(undefined, "新任务", {
      fullAccess: current?.fullAccess,
      toolApproval: current?.toolApproval,
      inheritCapabilities: false,
    });
    navigate(ROUTES.chat);
  };

  // 折叠时整块不渲染（而非 width:0 隐藏）：省掉内部列表订阅与重渲染开销，
  // AppLayout 的 flex 布局也会自然把主内容区铺满。
  // 仅在 Electron 生效——Web 端没有标题栏，收起来就没有任何入口能再展开。
  if (sidebarCollapsed && platform.env === "electron") return null;

  return (
    <Box
      sx={{
        width: 240,
        flexShrink: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
        borderRight: "1px solid",
        borderColor: "divider",
        boxSizing: "border-box",
        py: 1.5,
      }}
    >
      {/* 应用名：品牌名落在侧边栏顶部（标题栏只留操作图标） */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          pb: 2,
          color: "text.primary",
        }}
      >
        <Box
          sx={{
            width: 22,
            height: 22,
            borderRadius: 1.25,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <LogoIcon size={18} />
        </Box>
        <Box
          sx={{
            display: "flex",
            alignItems: "baseline",
            gap: 0.75,
            minWidth: 0,
          }}
        >
          <Typography
            variant="body2"
            sx={{
              fontWeight: 700,
              color: "text.primary",
              whiteSpace: "nowrap",
              lineHeight: 1.2,
            }}
          >
            {APP_DISPLAY_NAME}
          </Typography>
          <Typography
            sx={{
              fontSize: 12,
              fontWeight: 400,
              color: "text.secondary",
              whiteSpace: "nowrap",
              lineHeight: 1.2,
              letterSpacing: 0.2,
            }}
          >
            {APP_DISPLAY_SUB}
          </Typography>
        </Box>
      </Box>

      {/* 一级导航：新建任务 + 定时任务 + 扩展 */}
      <List dense disablePadding sx={{ px: 1, pb: 1 }}>
        <ListItemButton
          onClick={handleNewSession}
          sx={{
            borderRadius: 2,
            mb: 0.25,
            py: 0.75,
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <ListItemIcon
            sx={{ minWidth: 30, color: "text.secondary", fontSize: 18 }}
          >
            <AddCommentIcon fontSize="inherit" />
          </ListItemIcon>
          <ListItemText
            primary="新建任务"
            primaryTypographyProps={{
              fontSize: 12.5,
              fontWeight: 500,
              color: "text.secondary",
            }}
          />
        </ListItemButton>
        {TOP_ACTION_ITEMS.map((item) => (
          <NavRow
            key={item.label}
            item={item}
            active={currentPath === item.to}
            onClick={() => navigate(item.to)}
          />
        ))}
        <ListItemButton
          onClick={() => setExpandOpen((v) => !v)}
          onMouseEnter={() => setExpandHover(true)}
          onMouseLeave={() => setExpandHover(false)}
          sx={{
            borderRadius: 2,
            mb: 0.25,
            py: 0.75,
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <ListItemIcon
            sx={{ minWidth: 30, color: "text.secondary", fontSize: 18 }}
          >
            {expandHover ? (
              expandOpen ? (
                <ExpandMoreIcon fontSize="inherit" />
              ) : (
                <ChevronRightIcon fontSize="inherit" />
              )
            ) : (
              <GridViewIcon fontSize="inherit" />
            )}
          </ListItemIcon>
          <ListItemText
            primary="能力扩展"
            primaryTypographyProps={{
              fontSize: 12.5,
              fontWeight: 500,
              color: "text.secondary",
            }}
          />
        </ListItemButton>
        <Collapse in={expandOpen} timeout="auto" unmountOnExit>
          {/* 子项整体右移一点，形成层级缩进 */}
          <List dense disablePadding sx={{ pl: 2 }}>
            {LIBRARY_ITEMS.map((item) => (
              <NavRow
                key={item.label}
                item={item}
                active={currentPath === item.to}
                onClick={() => navigate(item.to)}
              />
            ))}
          </List>
        </Collapse>
      </List>

      {/* 任务 / 频道 切换列表 */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <TasksChannelsTabs />
      </Box>

      {/* 底部：账户入口。未登录 = 一行「登录」（去登录 / 注册页）；已登录 = 头像 +
          掩码账号名，点开菜单里有设置 / 意见反馈 / 退出登录（见 `AccountEntry`）。
          同步状态不在这里展示：「未登录」时它只是一句废话，而已登录时的同步状态
          在设置 →「账户」分区里看得到（那颗指示器仍由 `SyncStatus` 提供）。 */}
      <Box
        sx={{ px: 1, pt: 1, borderTop: "1px solid", borderColor: "divider" }}
      >
        <AccountEntry />
      </Box>
    </Box>
  );
}

/** 把 ISO 时间格式化为中文相对时间（如：刚刚 / 5分钟前 / 3小时前 / 5天前 / 9月3日） */
function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(diff / 86400000);
  if (days < 30) return `${days}天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 侧边栏工作空间分组：workdir 真实目录组 与 cron 自动任务虚拟组 的统一结构 */
interface WorkspaceGroup {
  key: string;
  label: string;
  /**
   * 未设别名时的默认显示名。重命名提交时要拿它判等
   * （「改成和默认名一样」= 清除别名，按 settingsStore.setWorkspaceAlias 的第三参回传）。
   */
  defaultLabel: string;
  fullPath: string;
  sessions: Session[];
  /** workdir=按真实目录分组；cron=按定时任务聚合的虚拟工作空间（无真实目录） */
  kind: "workdir" | "cron";
  /** cron 组：对应定时任务名（悬停 tooltip 展示） */
  taskName?: string;
}

/**
 * 分组比较器：按最近活跃排序 → 空分组集中在后半段 → 默认工作空间始终置底。
 *
 * 空分组只可能来自「会话列表为空」的组（正常情况下一个组至少带一条任务，
 * 见 `groupSessionsByWorkdir`），这里仍单独处理：空列表没有 `updatedAt` 可取，
 * `Math.max()` 是 `-Infinity`，两个空分组相减得到 `NaN`，比较器就失去意义。
 */
function compareWorkspaceGroups(a: WorkspaceGroup, b: WorkspaceGroup): number {
  if (a.key === "") return 1;
  if (b.key === "") return -1;
  const aEmpty = a.sessions.length === 0;
  const bEmpty = b.sessions.length === 0;
  if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
  if (aEmpty) return 0;
  const at = Math.max(...a.sessions.map((s) => Date.parse(s.updatedAt)));
  const bt = Math.max(...b.sessions.map((s) => Date.parse(s.updatedAt)));
  return bt - at;
}

/**
 * 按工作空间分组：置顶任务优先排在组内最前，其余按 updatedAt 倒序；分组按最近活跃排序，默认组置底。
 *
 * **一条任务都没有的工作空间不出现在结果里**（用户口径：分组下没有对话记录就不要
 * 显示这个工作空间）。分组完全由传进来的会话推导，不再参考任何「用过的目录」登记表。
 *
 * 判定「有任务」用的是 `visibleSessions` 那套（见 `SessionList`）：只有**有对话
 * 记录**（`hasConversation`）的会话才进得来。历史上一度额外补过空分组，那是为了让
 * 「工作空间还在、只是任务被切走」看得见；现在改为不显示——空分组会给用户一个
 * 点进去什么都没有的入口，比「分组消失」更容易误解成数据丢了。
 *
 * 「落在默认工作空间上」的会话与「没绑工作空间」的会话合并成**同一个组**（key `""`）：
 * 这两者本来就是同一个语义——任务的实际落点都是设置里那个默认工作空间（旧会话没写
 * `workdir`，发消息时兜底补上；新会话在建的时候就直接写进去了）。不合并的话侧边栏会
 * 并排出现两个组：一个叫「默认工作空间」、一个叫默认目录的名字（如 `NanoWork`），
 * 指向的却是同一个地方，用户无从判断该去哪个组里找自己的任务。
 */
export function groupSessionsByWorkdir(
  sessions: Session[],
  aliases: Record<string, string> | undefined,
  defaultWorkspacePath?: string,
): WorkspaceGroup[] {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = isSameWorkspacePath(s.workdir, defaultWorkspacePath)
      ? ""
      : (s.workdir ?? "");
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  }
  const groups: WorkspaceGroup[] = Array.from(map.entries()).map(
    ([key, list]) => ({
      key,
      label:
        key === ""
          ? DEFAULT_WORKSPACE_LABEL
          : resolveWorkspaceLabel(key, aliases),
      defaultLabel:
        key === ""
          ? DEFAULT_WORKSPACE_LABEL
          : resolveWorkspaceLabel(key, undefined),
      // 默认组的 `fullPath` 填它**当前的真实落点**（设置里的默认工作空间路径），
      // 悬停分组标题时就能看到任务到底存在哪儿；它同样是「更多操作 → 打开文件夹」
      // 的目标。默认组不提供「重命名」（名字由语义决定，见 `resolveWorkspaceLabel`），
      // 但可打开文件夹、可清掉组内任务——两者的动作与普通目录分组完全一致。
      fullPath: key === "" ? (defaultWorkspacePath ?? "") : key,
      kind: "workdir",
      // 组内排序：置顶任务永远在最前（按 updatedAt 倒序作为稳定次序），
      // 其余按 updatedAt 倒序，保证重复置顶/取消时视觉次序稳定
      sessions: [...list].sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      }),
    }),
  );
  groups.sort(compareWorkspaceGroups);
  return groups;
}

/**
 * 自动任务分组的 key 前缀：`__cron__:{taskId}`。
 *
 * 定义处与解析处**必须共用同一常量**——移除分组时要从中取回 taskId 去清引擎留痕，
 * 前缀一旦漂移就会「删不掉也不报错」（解析出空 taskId → 直接取消操作）。
 */
const CRON_GROUP_KEY_PREFIX = "__cron__:";

/** 从 cron 会话 id（形如 `cron:api:cron-{taskId}:{runId}`）解析对应定时任务 id，失败返回 null */
function cronSessionTaskId(id: string): string | null {
  const m = id.match(/^cron:api:cron-([^:]+):/);
  return m ? m[1] : null;
}

/** 自动任务工作空间命名用日期：YYYY-MM-DD（对齐参考截图的命名形态） */
function formatWorkspaceDate(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 定时任务执行会话按任务聚合为虚拟工作空间，命名「自动任务-{任务创建日期}」
 * （单次任务执行后 TaskConfig 会被自动移除，此时回退组内最早执行日期）。
 *
 * 分组 key 形如 `__cron__:{taskId}`，与别名表共用同一份 `workspaceAliases`
 * （该表的语义已从「路径别名」泛化为「分组显示名」），因此自动任务分组
 * 同样可以重命名。
 */
function groupCronSessions(
  sessions: Session[],
  tasks: TaskConfig[],
  aliases: Record<string, string> | undefined,
): WorkspaceGroup[] {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = cronSessionTaskId(s.id) ?? "__unknown__";
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  }
  return Array.from(map.entries()).map(([taskId, list]) => {
    const sorted = [...list].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    const task = tasks.find((t) => t.id === taskId);
    const earliest = sorted[sorted.length - 1];
    const key = `${CRON_GROUP_KEY_PREFIX}${taskId}`;
    const defaultLabel = `自动任务-${formatWorkspaceDate(
      task?.createdAt ?? earliest.createdAt,
    )}`;
    return {
      key,
      label: aliases?.[key] ?? defaultLabel,
      defaultLabel,
      fullPath: "",
      kind: "cron" as const,
      taskName: task?.name,
      sessions: sorted,
    };
  });
}

/** 任务 / 频道 切换容器：任务 Tab 复用 SessionList；频道 Tab 展示来自 IM 渠道的会话 */
function TasksChannelsTabs() {
  const [tab, setTab] = useState<"tasks" | "channels">("tasks");
  return (
    <>
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{
          px: 2,
          minHeight: 40,
          borderBottom: "1px solid",
          borderColor: "divider",
          "& .MuiTab-root": {
            minHeight: 40,
            textTransform: "none",
            fontSize: 13.5,
            fontWeight: 600,
            px: 1,
            mr: 2,
          },
        }}
      >
        <Tab value="tasks" label="任务" />
        <Tab value="channels" label="助理" />
      </Tabs>
      <Box
        sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {tab === "tasks" ? <SessionList /> : <ChannelSessionList />}
      </Box>
    </>
  );
}

/**
 * 频道列表：数据源为 nanobot 磁盘上的 IM 频道会话（gateway 实时写入）。
 * 按机器人（渠道）分组展示，组内会话按更新时间倒序；
 * 点击会话拉取完整历史并打开聊天页（与任务列表交互一致）。
 */
function ChannelSessionList() {
  const summaries = useChannelSessionsStore((s) => s.summaries);
  const activeId = useSessionsStore((s) => s.activeId);
  const openSession = useChannelSessionsStore((s) => s.openSession);
  // 筛选态在 store：Tab 切换是条件渲染，本组件会重挂载，组件内 state 会被重置
  const filter = useSessionUiStore((s) => s.channelFilter);
  const setFilter = useSessionUiStore((s) => s.setChannelFilter);
  const navigate = useNavigate();

  /** 当前悬停的频道会话行：右侧快捷入口层随之淡入 */
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  /**
   * 按渠道分组：组按最近活跃排序，组内会话按更新时间倒序。
   *
   * ⚠️ 分组键是**渠道原始首段**（`channelGroupKey`）而不是 `ChannelKind`：
   * 后者只有 5 个成员，未知渠道会被图标回退规则悄悄并进「钉钉」组。
   */
  const groups = useMemo(() => {
    const map = new Map<string, NanobotChannelSessionSummary[]>();
    for (const item of summaries) {
      const key = channelGroupKey(item.channel);
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return Array.from(map.entries())
      .map(([key, list]) => ({
        key,
        list: [...list].sort(
          (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        ),
      }))
      .sort(
        (a, b) =>
          Date.parse(b.list[0].updatedAt) - Date.parse(a.list[0].updatedAt),
      );
  }, [summaries]);

  /** 应用渠道筛选；`全部`（filter === null）时即 groups 本身 */
  const visible = useMemo(
    () => (filter === null ? groups : groups.filter((g) => g.key === filter)),
    [groups, filter],
  );

  if (summaries.length === 0) {
    return (
      <Box
        sx={{
          px: 3,
          py: 6,
          textAlign: "center",
          color: "text.secondary",
          fontSize: 12.5,
          lineHeight: 1.8,
        }}
      >
        还没有产生任何频道任务或对话，连接 IM 频道后即可开始。
      </Box>
    );
  }

  return (
    <Box
      sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      {/* 渠道筛选：只有一个渠道时不出现——没有可筛的东西，白占一行高度 */}
      {groups.length > 1 && (
        <Box
          sx={{
            display: "flex",
            gap: 0.5,
            px: 2,
            pt: 1,
            pb: 0.5,
            flexShrink: 0,
            overflowX: "auto",
            // 渠道多到横向溢出时不要撑高这一行（滚动条高度会顶到列表）
            "&::-webkit-scrollbar": { height: 0 },
          }}
        >
          <ChannelFilterChip
            label="全部"
            selected={filter === null}
            onClick={() => setFilter(null)}
          />
          {groups.map((g) => (
            <ChannelFilterChip
              key={g.key}
              label={channelLabel(g.key)}
              selected={filter === g.key}
              onClick={() => setFilter(g.key)}
            />
          ))}
        </Box>
      )}

      <Box sx={{ flex: 1, overflowY: "auto" }}>
        {/* 选中的渠道在后续刷新里消失了（会话被清空 / 渠道改名）：给一句人话
            和一条退路，而不是一片空白 */}
        {visible.length === 0 && (
          <Box sx={{ px: 3, py: 5, textAlign: "center" }}>
            <Typography
              sx={{ fontSize: 12.5, color: "text.secondary", mb: 1 }}
            >
              该渠道下暂无会话。
            </Typography>
            <Button size="small" onClick={() => setFilter(null)}>
              查看全部
            </Button>
          </Box>
        )}
        {visible.map((g) => (
          <Box key={g.key} sx={{ mb: 0.5 }}>
            {/* 机器人分组头 */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                px: 2,
                py: 0.75,
              }}
            >
              <ChannelIcon kind={channelIconKind(g.key)} />
              <Typography
                sx={{ fontSize: 12.5, fontWeight: 600, color: "text.secondary" }}
              >
                {channelLabel(g.key)}
              </Typography>
              <Typography
                sx={{ fontSize: 11, color: "text.secondary", opacity: 0.7 }}
              >
                {g.list.length}
              </Typography>
            </Box>
            {/* 组内会话 */}
            {g.list.map((item) => {
              const sessionId = CHANNEL_SESSION_ID_PREFIX + item.key;
              const hovered = hoverKey === item.key;
              return (
              <Box
                key={item.key}
                data-testid="channel-session-row"
                data-channel={channelGroupKey(item.channel)}
                onClick={() => {
                  void openSession(item);
                  navigate(ROUTES.chat);
                }}
                  onMouseEnter={() => setHoverKey(item.key)}
                  onMouseLeave={() =>
                    setHoverKey((v) => (v === item.key ? null : v))
                  }
                  sx={{
                    pl: 3,
                    pr: 2,
                    py: 0.875,
                    cursor: "pointer",
                    bgcolor:
                      activeId === sessionId ? "action.selected" : "transparent",
                    "&:hover": { bgcolor: "action.hover" },
                  }}
                >
                  {/* 标题行：右侧快捷入口（搜索 / 历史提问 / 产物面板）随悬停淡入 */}
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 0.5,
                    }}
                  >
                    <Typography
                      noWrap
                      sx={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0 }}
                    >
                      {item.title}
                    </Typography>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.25,
                        flexShrink: 0,
                        opacity: hovered ? 1 : 0,
                        pointerEvents: hovered ? "auto" : "none",
                        transition: "opacity 120ms ease",
                      }}
                    >
                      <SessionQuickActions
                        sessionId={sessionId}
                        ensureLoaded={() => openSession(item)}
                      />
                    </Box>
                  </Box>
                  <Typography
                    noWrap
                    sx={{ fontSize: 11, color: "text.secondary" }}
                  >
                    {item.preview || `${item.messageCount} 条消息`}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** 渠道筛选 chip：选中实心、未选描边（不靠颜色语义区分，避免与主题色冲突） */
function ChannelFilterChip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Chip
      size="small"
      label={label}
      variant={selected ? "filled" : "outlined"}
      color={selected ? "primary" : "default"}
      data-testid="channel-filter-chip"
      data-selected={selected ? "true" : "false"}
      onClick={onClick}
      sx={{
        flexShrink: 0,
        height: 24,
        fontSize: 12,
        "& .MuiChip-label": { px: 1 },
      }}
    />
  );
}

/** 更多操作菜单的动作类型，便于后续接入真实业务逻辑 */
type SessionAction =
  | "pin"
  | "openInExplorer"
  | "fileManage"
  | "share"
  | "rename"
  | "delete";

/** 工作空间分组「更多操作」菜单的动作类型 */
type WorkspaceAction = "open" | "rename" | "remove";

/** 任务列表：按工作空间分组（可折叠） */
function SessionList() {
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  // 流式状态映射（引用仅在流式开始/阶段变化/结束时更新，token 流不触发）
  const streams = useSessionsStore((s) => s.streams);
  // 正在运行中的会话 id 集合：用于任务名称后的运行状态指示
  const runningIds = useMemo(
    () =>
      new Set(
        Object.keys(streams).filter((id) => streams[id].status !== "idle"),
      ),
    [streams],
  );
  const selectSession = useSessionsStore((s) => s.selectSession);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  /** 分组级「从列表中移除」走批量删除：一次清掉整组会话（不做自动沉淀） */
  const deleteSessions = useSessionsStore((s) => s.deleteSessions);
  const renameSession = useSessionsStore((s) => s.renameSession);
  const togglePinSession = useSessionsStore((s) => s.togglePinSession);
  const createSession = useSessionsStore((s) => s.createSession);
  const agents = useAgentsStore((s) => s.agents);
  // 工作空间显示名表：key=workdir（或 `__cron__:{taskId}`），value=显示名；
  // 只读不写，写入由 Dialog 提交时通过 settingsStore.setWorkspaceAlias 走，
  // **绝不**回写到任何 session.workdir
  const workspaceAliases = useSettingsStore((s) => s.settings.workspaceAliases);
  // 「默认工作空间」当前的真实落点（设置 → 通用 → 存储）。分组时要靠它把落在默认
  // 路径上的会话并进默认组，否则同一个地方会出现两个组。
  const defaultWorkspacePath = useDefaultWorkspacePath();
  const setWorkspaceAlias = useSettingsStore((s) => s.setWorkspaceAlias);
  const forgetWorkspace = useSettingsStore((s) => s.forgetWorkspace);
  // 已「从列表中移除」的会话 id：只影响侧边栏展示，不删任何会话数据。
  // 注：该表自「移除即真删」后不再有新写入，仅用于兼容历史数据（旧版本隐藏过的会话）；
  // hideSessions 因此已无生产调用方，保留仅为兼容既有测试与向后回退。
  const hiddenSessions = useSettingsStore((s) => s.settings.hiddenSessions);
  /** 拉取引擎 cron 运行记录：删完执行留痕后立即刷新，避免界面停在旧数据上 */
  const fetchCronRuns = useTasksStore((s) => s.fetchCronRuns);
  const navigate = useNavigate();

  const [toDelete, setToDelete] = useState<string | null>(null);
  /** 已折叠的分组 key 集合（默认全部展开） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** 更多操作菜单：anchorEl 指向触发按钮，sessionId 记录当前会话，
   *  pendingRename 记录「点击重命名后、待菜单完全退出再执行的会话 id」 */
  const [menu, setMenu] = useState<{
    anchorEl: HTMLElement | null;
    sessionId: string | null;
    pendingRename: string | null;
  }>({ anchorEl: null, sessionId: null, pendingRename: null });
  /** 行内重命名状态 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  /** 当前悬停的会话行 id：右侧固定槽在「运行状态图标 / 三点菜单按钮」间切换 */
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** 行内输入框 ref：菜单完全退出后再聚焦，避免与 MUI 焦点回收竞争 */
  const editingInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingId && editingInputRef.current) {
      editingInputRef.current.focus();
      editingInputRef.current.select();
    }
  }, [editingId]);

  /** 当前悬停的工作空间分组 key：用于在分组头右侧展示三点菜单与新建任务图标 */
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
  /** 工作空间分组「更多操作」菜单：anchorEl 指向触发按钮，key 记录分组路径 */
  const [groupMenu, setGroupMenu] = useState<{
    anchorEl: HTMLElement | null;
    key: string | null;
  }>({ anchorEl: null, key: null });
  /**
   * 「从列表中移除」确认对话框上下文。
   * 注意语义已从「隐藏」改为**真删**：`kind === 'cron'` 时 `key` 会被拆出
   * taskId 去清引擎侧执行留痕，因此这里必须保留完整分组 key。
   */
  const [removeGroup, setRemoveGroup] = useState<{
    key: string;
    label: string;
    count: number;
    kind: "workdir" | "cron";
    /** 该分组下的会话 id：确认时直接作用于此快照，避免依赖后续可能变化的 groups */
    sessionIds: string[];
  } | null>(null);
  /**
   * 「重命名工作空间」Dialog 上下文：
   * `key` 为分组标识（真实 workdir 路径，或 `__cron__:{taskId}`），**不变**；
   * `value` 为用户在输入框中编辑的字符串；`fallback` 是该分组未设别名时的默认名，
   * 提交时回传给 settingsStore 用于「与默认名相同就清除表项」的判等。
   * 与旧版「行内编辑 workdir 路径」的关键区别——本 Dialog 只动 alias 表，
   * 永远不会写回 session.workdir。
   */
  const [renameDialog, setRenameDialog] = useState<{
    key: string;
    value: string;
    fallback: string;
  } | null>(null);

  /** 已「从列表中移除」的会话 id 集合（v8 迁移保证是数组，仍兜底空数组） */
  const hiddenSet = useMemo(
    () => new Set(hiddenSessions ?? []),
    [hiddenSessions],
  );

  /** 无对话内容的新任务、IM 频道会话、只读会话不进入任务列表
   * （频道会话在「频道」Tab 展示；只读会话经运行记录「查看对话」打开）；
   * 用户主动「从列表中移除」的会话同样不进入（数据仍在，只是不做展示）。
   *
   * 「有没有对话内容」必须用 `hasConversation`（先看水合后的消息、再看索引里的
   * 持久条数），**不能只看 `s.messages.length`**：启动时列表只读索引、消息要等点开
   * 才读盘，只看消息会把所有没点开过的任务判成空任务——侧边栏于是只剩当前那一条，
   * 其余工作空间看起来「一个任务都没有」。 */
  const visibleSessions = useMemo(
    () =>
      sessions.filter(
        (s) =>
          hasConversation(s) &&
          !s.channel &&
          !s.readonly &&
          !hiddenSet.has(s.id),
      ),
    [sessions, hiddenSet],
  );

  /** 定时任务配置：用于 cron 虚拟工作空间的命名与 tooltip */
  const tasks = useTasksStore((s) => s.tasks);

  /**
   * 窗口标题栏筛选面板下发的条件。与居中搜索窗共用同一份 `filters`，
   * 因此两处结果永远一致（先在面板收窄、再在搜索窗搜）。
   * 默认条件时短路，避免无谓的排序与遍历。
   */
  const filters = useTaskQueryStore((s) => s.filters);
  const filteredSessions = useMemo(
    () =>
      isFilterDefault(filters)
        ? visibleSessions
        : filterTasks(visibleSessions, { filters, streams, defaultWorkspacePath }),
    [visibleSessions, filters, streams, defaultWorkspacePath],
  );

  const groups = useMemo(() => {
    const cronSessions = filteredSessions.filter((s) =>
      s.id.startsWith(CRON_SESSION_ID_PREFIX),
    );
    const normalSessions = filteredSessions.filter(
      (s) => !s.id.startsWith(CRON_SESSION_ID_PREFIX),
    );
    return [
      ...groupSessionsByWorkdir(
        normalSessions,
        workspaceAliases,
        defaultWorkspacePath,
      ),
      ...groupCronSessions(cronSessions, tasks, workspaceAliases),
    ].sort(compareWorkspaceGroups);
  }, [filteredSessions, workspaceAliases, tasks, defaultWorkspacePath]);

  // 会话未绑定专家（「新建任务」的默认态）显示中性名而不是「未知 Agent」：
  // 那是正常状态，不是缺数据
  const agentName = (id: string) =>
    id === ""
      ? UNBOUND_AGENT_LABEL
      : (agents.find((a) => a.id === id)?.name ?? "未知 Agent");

  const handleSelect = (id: string) => {
    // 行内重命名期间禁止跳转，避免输入框失焦/误触
    if (editingId) return;
    selectSession(id);
    navigate(ROUTES.chat);
  };

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 打开「更多操作」菜单，阻止冒泡以免误触发会话跳转 */
  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>, id: string) => {
    e.stopPropagation();
    setMenu({ anchorEl: e.currentTarget, sessionId: id, pendingRename: null });
  };

  /** 关闭「更多操作」菜单 */
  const handleMenuClose = () =>
    setMenu((prev) => ({ ...prev, anchorEl: null }));

  /** 进入行内重命名 */
  const startRename = (id: string) => {
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    setEditingId(id);
    setEditingTitle(session.title);
  };

  /** 提交重命名 */
  const commitRename = () => {
    if (!editingId) return;
    const trimmed = editingTitle.trim();
    if (trimmed) renameSession(editingId, trimmed);
    setEditingId(null);
    setEditingTitle("");
  };

  /** 取消重命名 */
  const cancelRename = () => {
    setEditingId(null);
    setEditingTitle("");
  };

  /** 在系统文件管理器中打开会话工作空间（资源管理器 / Finder） */
  const openInExplorer = async (id: string) => {
    const session = sessions.find((s) => s.id === id);
    const workdir = session?.workdir?.trim();
    if (!workdir) {
      toast.warning("该任务未设置工作空间");
      return;
    }
    const result = await platform.openPath(workdir);
    if (!result.ok) {
      toast.error(result.error ?? "打开工作空间失败");
    }
  };

  /** 更多操作菜单项回调 */
  const handleSessionAction = (action: SessionAction, id: string | null) => {
    handleMenuClose();
    if (!id) return;
    switch (action) {
      case "pin":
        togglePinSession(id);
        toast.success("已切换置顶状态");
        break;
      case "openInExplorer":
        void openInExplorer(id);
        break;
      case "fileManage":
        console.log("[SessionList] 文件管理", id);
        break;
      case "share":
        console.log("[SessionList] 分享", id);
        break;
      case "rename":
        // 不直接进入编辑态：先标记 pending，等菜单完全退出（onExited）后再 startRename，
        // 否则菜单关闭动画会把焦点还给触发按钮，与输入框聚焦竞争致其「一闪即逝」
        setMenu((m) => ({ ...m, anchorEl: null, pendingRename: id }));
        break;
      case "delete":
        setToDelete(id);
        break;
      default:
        break;
    }
  };

  /**
   * 在指定工作空间下新建任务：workdir 跟随该分组，fullAccess 继承当前活跃会话，
   * 专家与技能与顶部入口一致**不继承**（新任务一律从白纸开始）。
   * 自动任务分组是虚拟工作空间（无真实目录），其下新建的任务归入默认工作空间——
   * 这是该按钮唯一有意义的落点，否则会造出一个挂不到任何目录上的分组。
   */
  const handleNewSessionInGroup = (group: WorkspaceGroup) => {
    const current = useSessionsStore
      .getState()
      .sessions.find((s) => s.id === useSessionsStore.getState().activeId);
    createSession(undefined, "新任务", {
      workdir:
        group.kind === "workdir" && group.fullPath ? group.fullPath : undefined,
      fullAccess: current?.fullAccess,
      toolApproval: current?.toolApproval,
      inheritCapabilities: false,
    });
    navigate(ROUTES.chat);
  };

  /**
   * 提交工作空间重命名：只改 settingsStore.workspaceAliases 表，
   * 不会写回任何 session.workdir。这是与旧版「行内编辑 workdir」的根本差别。
   * 第三参回传默认名，供 store 判定「改成默认名 = 清除别名」。
   */
  const submitGroupRename = () => {
    if (!renameDialog) return;
    setWorkspaceAlias(
      renameDialog.key,
      renameDialog.value,
      renameDialog.fallback,
    );
    setRenameDialog(null);
  };

  /** 工作空间分组「更多操作」菜单动作：打开文件夹 / 重命名 / 从列表中移除 */
  const handleGroupAction = (action: WorkspaceAction, key: string | null) => {
    setGroupMenu((prev) => ({ ...prev, anchorEl: null }));
    // 判空必须用 `=== null`：默认工作空间分组的 key 是**空字符串**，
    // `!key` 会把它当成「没传 key」直接吃掉所有动作（菜单点了没反应且不报错）。
    if (key === null) return;
    const group = groups.find((x) => x.key === key);
    if (!group) return;
    switch (action) {
      case "open": {
        // 仅真实目录分组可打开；自动任务分组是虚拟工作空间，
        // 菜单里本就不渲染该项，这里再兜一层防御
        if (!group.fullPath) {
          toast.warning("该工作空间没有关联文件夹");
          return;
        }
        void platform.openPath(group.fullPath).then((r) => {
          if (!r.ok) toast.error(r.error ?? "打开文件夹失败");
        });
        break;
      }
      case "rename": {
        // 默认工作空间分组的 key 是空串，它不参与重命名（菜单里本就不渲染该项，
        // 这里再兜一层：别名表里写一条 key="" 的记录不会有任何读取方，
        // 只会变成「改了没反应」的脏数据）。
        if (key === "") return;
        // 打开重命名 Dialog：预填当前显示名（别名优先，未设别名即默认名）。
        // 只改 settingsStore.workspaceAliases，绝不动 session.workdir。
        setRenameDialog({
          key: group.key,
          value: group.label,
          fallback: group.defaultLabel,
        });
        break;
      }
      case "remove": {
        // 正常进不来：空分组已经不再显示（见 `groupSessionsByWorkdir`），
        // 这一支是零成本兜底——万一分组规则再变，空分组的「从列表中移除」必须是
        // 摘掉登记而不是删任务（目录与文件一概不动，也不需要确认框：
        // 「确认-取消」反而会让人以为自己在删工作空间）。
        if (group.sessions.length === 0) {
          if (group.kind === "workdir") forgetWorkspace(group.key);
          toast.success(`已将「${group.label}」移出列表（文件夹未改动）`);
          return;
        }
        setRemoveGroup({
          key: group.key,
          label: group.label,
          count: group.sessions.length,
          kind: group.kind,
          sessionIds: group.sessions.map((s) => s.id),
        });
        break;
      }
      default:
        break;
    }
  };

  /**
   * 当前打开菜单的分组：用于按类型裁剪菜单项（自动任务分组没有关联文件夹）。
   * 同样不能用 `groupMenu.key ? … : …` 判——默认工作空间分组的 key 是空字符串，
   * 那样会让它的菜单直接查不到分组，只剩一个空菜单。
   */
  const menuGroup =
    groupMenu.key === null
      ? undefined
      : groups.find((g) => g.key === groupMenu.key);

  /**
   * 「从列表中移除」确认：**真删**，不是隐藏。
   *
   * 两类分组删的东西不同，但都必须删到「数据源」才算数：
   * - 自动任务分组：执行记录的唯一数据源在引擎磁盘（`cron/runs/*.json` +
   *   `api:cron-{taskId}` 会话 JSONL），渲染层每 15s 据此重建 → 先让主进程
   *   清盘，再删本地会话并立即刷新，否则下一次轮询/重启就把记录原样拉回来；
   *   任务本身保留，仍按计划执行。
   * - 目录分组：删掉该分组下的任务会话，并撤销该工作空间的登记
   *   （登记表已不参与侧边栏展示，撤销只是保持留痕与用户操作一致）。
   *
   * 删除为不可撤销操作，两个分支都走 `danger` 确认框。
   */
  const confirmRemoveGroup = async () => {
    const target = removeGroup;
    setRemoveGroup(null);
    if (!target) return;

    if (target.kind === "cron") {
      // 分组 key 形如 `__cron__:{taskId}`；taskId 同时是引擎侧的 job_id
      const taskId = target.key.startsWith(CRON_GROUP_KEY_PREFIX)
        ? target.key.slice(CRON_GROUP_KEY_PREFIX.length)
        : "";
      if (!taskId) {
        toast.error("无法解析该自动任务分组，已取消操作");
        return;
      }
      const res = await platform.deleteNanobotCronHistory(taskId);
      // 引擎侧部分文件删不掉时不再停顿在错误上：本地会话照样清掉，
      // 并把残留情况说清楚（下次轮询可能带回来一部分）
      deleteSessions(target.sessionIds);
      await fetchCronRuns();
      if (res.ok) {
        toast.success(`已删除「${target.label}」的 ${target.count} 条执行记录`);
      } else {
        toast.error(`部分执行记录未能删除：${res.error ?? "未知原因"}`);
      }
      return;
    }

    // 真实目录分组：任务会话真删。
    // 顺带撤销工作空间登记（那张表现在没有读取方，见 `settings.knownWorkspaces`；
    // 撤销是为了让「用过的目录」留痕与用户的显式操作保持一致）。
    deleteSessions(target.sessionIds);
    forgetWorkspace(target.key);
    toast.success(`已删除「${target.label}」下的 ${target.count} 个任务`);
  };

  return (
    <>
      <Box sx={{ flex: 1, overflowY: "auto" }}>
        {/* 一个分组都没有（全新用户 / 清空过 / 从没聊过）：给一句话兜底。
            分组现在完全由「有对话记录的任务」推导，没有分组就等于没有任务 */}
        {groups.length === 0 && (
          <Box sx={{ px: 2, py: 1, color: "text.secondary", fontSize: 12 }}>
            还没有任务，点击顶部「新建任务」开始。
          </Box>
        )}
        {/* 有任务但被筛选条件全部排除：给出可操作的提示而非一片空白。
            判据看「有没有任何一个分组还带着任务」而不是 `groups.length`——
            自动任务分组是另一条来源（虚拟工作空间，不进 `groupSessionsByWorkdir`），
            用长度判断会让这条提示在筛选时消失 */}
        {visibleSessions.length > 0 &&
          !groups.some((g) => g.sessions.length > 0) && (
            <Box sx={{ px: 2, py: 1, color: "text.secondary", fontSize: 12 }}>
              没有符合筛选条件的任务，可在标题栏调整或重置筛选。
            </Box>
          )}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          return (
            <Box key={g.key === "" ? "__default__" : g.key} sx={{ mb: 0.5 }}>
              {/* 分组头：工作空间名 + 紧贴标题的折叠箭头；hover 时行尾追加三点菜单与新建任务 */}
              <ListItemButton
                onClick={() => toggleCollapse(g.key)}
                onMouseEnter={() => setHoveredGroup(g.key)}
                onMouseLeave={() =>
                  setHoveredGroup((v) => (v === g.key ? null : v))
                }
                sx={{ px: 1.5, py: 0.5, borderRadius: 1.5 }}
              >
                <ListItemIcon sx={{ minWidth: 26, color: "text.secondary" }}>
                  <FolderIcon sx={{ fontSize: 16 }} />
                </ListItemIcon>
                <Tooltip
                  title={
                    g.kind === "cron"
                      ? (g.taskName ?? g.label)
                      : g.fullPath || DEFAULT_WORKSPACE_LABEL
                  }
                  placement="top-start"
                >
                  {/* `flex: 0 1 auto` 让标题**按内容收缩**而不是吃满整行：
                      箭头才能紧跟在标题末尾（标题过长时才 ellipsis 并让箭头跟着后退）。
                      默认的 `flex: 1 1 auto` 会把箭头一路顶到行尾，正是要改掉的那版。 */}
                  <ListItemText
                    primary={g.label}
                    sx={{ flex: "0 1 auto", minWidth: 0 }}
                    primaryTypographyProps={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: "text.secondary",
                      noWrap: true,
                    }}
                  />
                </Tooltip>
                {/* 折叠箭头紧贴标题右侧（常驻，不随 hover 变化） */}
                {isCollapsed ? (
                  <ExpandMoreIcon
                    sx={{
                      fontSize: 16,
                      color: "text.secondary",
                      flexShrink: 0,
                      ml: 0.75,
                    }}
                  />
                ) : (
                  <ExpandLessIcon
                    sx={{
                      fontSize: 16,
                      color: "text.secondary",
                      flexShrink: 0,
                      ml: 0.75,
                    }}
                  />
                )}
                {/* 弹性垫片：标题与箭头靠左成组，行尾留给 hover 才出现的操作图标 */}
                <Box sx={{ flex: 1, minWidth: 8 }} />
                {/* 行尾槽：hover 时追加三点菜单与新建任务，**所有分组一致**。
                    默认工作空间（key=""）也展示：它的 `fullPath` 就是设置里那个默认
                    工作空间路径，是一个**真实可打开的目录**（早期版本不显示，是因为
                    当时它被当成「没有可操作目录」的虚拟分组）——「打开文件夹」能打开
                    它，「新建任务」会以它为 workdir 开工。
                    与其它目录分组唯一的差别是菜单里没有「重命名」：默认分组的名字由
                    它的语义决定（改设置后名字依然成立），别名会让名字漂移，见
                    `resolveWorkspaceLabel` 与 `tests/lib/workspace/workspaceLabel.test.ts`。
                    自动任务分组同样展示——它可重命名、可从列表移除，
                    仅「打开文件夹」因无真实目录而不进菜单。 */}
                {hoveredGroup === g.key && (
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 0.25,
                      flexShrink: 0,
                    }}
                  >
                    <Tooltip title="更多操作" placement="top">
                      <IconButton
                        size="small"
                        aria-label="更多操作"
                        sx={{ p: 0.25 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          // 菜单锚到整行 ListItemButton（而非 ⋮ 按钮本身），
                          // 配合下方的 bottom/top + left/left，菜单会从工作空间行
                          // 的左下角向下展开，正好落在「空间名称」下方。
                          // 锚行而非锚按钮还有个好处：hover 图标层消失后
                          // 该节点依然在 DOM 中，菜单不会被拽到屏幕角落。
                          const listItemButton = e.currentTarget.closest(
                            ".MuiListItemButton-root",
                          ) as HTMLElement | null;
                          setGroupMenu({
                            anchorEl: listItemButton ?? e.currentTarget,
                            key: g.key,
                          });
                        }}
                      >
                        <MoreVertIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="新建任务" placement="top">
                      <IconButton
                        size="small"
                        aria-label="新建任务"
                        sx={{ p: 0.25 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleNewSessionInGroup(g);
                        }}
                      >
                        <AddCommentIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                )}
              </ListItemButton>

              {/* 分组内任务（折叠时隐藏）。组里至少有一条任务——空分组不再显示
                  （见 `groupSessionsByWorkdir`），所以这里没有「暂无任务」占位 */}
              {!isCollapsed &&
                g.sessions.map((s) => (
                  <Box
                    key={s.id}
                    onClick={() => handleSelect(s.id)}
                    onMouseEnter={() => setHoverId(s.id)}
                    onMouseLeave={() =>
                      setHoverId((v) => (v === s.id ? null : v))
                    }
                    sx={{
                      pl: 3,
                      pr: 1,
                      py: 0.875,
                      cursor: "pointer",
                      borderColor: "primary.main",
                      bgcolor:
                        activeId === s.id ? "action.selected" : "transparent",
                      "&:hover": { bgcolor: "action.hover" },
                    }}
                  >
                    <Box
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      {editingId === s.id ? (
                        <TextField
                          inputRef={editingInputRef}
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelRename();
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          size="small"
                          fullWidth
                          sx={{
                            mr: 1,
                            "& .MuiInputBase-root": {
                              height: 24,
                              fontSize: 13,
                              py: 0,
                            },
                            "& .MuiInputBase-input": {
                              py: 0,
                              px: 1,
                            },
                          }}
                        />
                      ) : (
                        <>
                          {s.pinned && (
                            <PushPinOutlinedIcon
                              sx={{
                                fontSize: 12,
                                color: "primary.main",
                                mr: 0.5,
                                flexShrink: 0,
                              }}
                            />
                          )}
                          <Typography
                            noWrap
                            sx={{
                              fontSize: 13,
                              fontWeight: 500,
                              flex: 1,
                              minWidth: 0,
                            }}
                          >
                            {s.title}
                          </Typography>
                        </>
                      )}
                      {/* 右侧槽：常态显示相对时间；悬停（或菜单打开）显示快捷入口与操作图标；
                          运行中任务显示加载转圈。宽度自适应，文字不截断 */}
                      <Box
                        sx={{
                          minWidth: 26,
                          height: 26,
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "flex-end",
                          gap: 0.25,
                          ml: 1,
                        }}
                      >
                        {editingId !== s.id &&
                          (hoverId === s.id ||
                          (menu.anchorEl !== null &&
                            menu.sessionId === s.id) ? (
                            <>
                              {/* <SessionQuickActions sessionId={s.id} /> */}
                              {/* <Tooltip title="重命名" placement="top">
                                <IconButton
                                  size="small"
                                  sx={{ p: 0.25, width: 22, height: 22 }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    startRename(s.id);
                                  }}
                                >
                                  <EditIcon sx={{ fontSize: 14 }} />
                                </IconButton>
                              </Tooltip> */}
                              <Tooltip title="更多操作" placement="top">
                                <IconButton
                                  size="small"
                                  sx={{ p: 0.25, width: 22, height: 22 }}
                                  onClick={(e) => handleMenuOpen(e, s.id)}
                                >
                                  <MoreVertIcon sx={{ fontSize: 14 }} />
                                </IconButton>
                              </Tooltip>
                            </>
                          ) : runningIds.has(s.id) ? (
                            <CircularProgress
                              size={12}
                              thickness={5}
                              sx={{ color: "text.secondary" }}
                            />
                          ) : (
                            <Tooltip
                              title={new Date(s.updatedAt).toLocaleString()}
                              placement="top"
                            >
                              <Typography
                                noWrap
                                sx={{
                                  fontSize: 11,
                                  color: "text.secondary",
                                  opacity: 0.85,
                                }}
                              >
                                {formatRelativeTime(s.updatedAt)}
                              </Typography>
                            </Tooltip>
                          ))}
                      </Box>
                    </Box>
                    <Typography
                      noWrap
                      sx={{ fontSize: 11, color: "text.secondary" }}
                    >
                      {/* 条数走 `conversationCount`：未点开过的任务还没水合，
                          只有索引里的持久条数可显示（直接读 messages.length 会
                          让「有 14 条记录的任务」显示成「0 条」） */}
                      {agentName(s.agentId)} · {conversationCount(s)} 条
                    </Typography>
                  </Box>
                ))}
            </Box>
          );
        })}
      </Box>

      {/* 「更多操作」菜单：悬停会话项右侧的三点按钮触发 */}
      <Menu
        anchorEl={menu.anchorEl}
        open={!!menu.anchorEl}
        onClose={handleMenuClose}
        // 菜单完全退出动画结束后再进入行内编辑，规避焦点竞争导致输入框一闪即逝
        TransitionProps={{
          onExited: () => {
            if (menu.pendingRename) {
              const id = menu.pendingRename;
              setMenu((m) => ({ ...m, pendingRename: null }));
              startRename(id);
            }
          },
        }}
        // 侧边栏仅 240px 宽、按钮贴右边缘：菜单以按钮右下角为基准向左下展开，
        // 保证 168px 宽的菜单完整落在侧边栏内，不侵入右侧主内容区
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        PaperProps={{ sx: { minWidth: 168 } }}
      >
        <MenuItem onClick={() => handleSessionAction("pin", menu.sessionId)}>
          <ListItemIcon>
            <PushPinOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>置顶任务</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => handleSessionAction("openInExplorer", menu.sessionId)}
        >
          <ListItemIcon>
            <FolderOpenIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>在资源管理器打开</Typography>
        </MenuItem>
        {/* <MenuItem
          onClick={() => handleSessionAction("fileManage", menu.sessionId)}
        >
          <ListItemIcon>
            <FolderCopyIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>文件管理</Typography>
        </MenuItem> */}
        {/* <MenuItem onClick={() => handleSessionAction("share", menu.sessionId)}>
          <ListItemIcon>
            <ShareIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>分享</Typography>
        </MenuItem> */}
        <MenuItem onClick={() => handleSessionAction("rename", menu.sessionId)}>
          <ListItemIcon>
            <EditIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>重命名</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => handleSessionAction("delete", menu.sessionId)}
          sx={{ color: "error.main" }}
        >
          <ListItemIcon sx={{ color: "error.main" }}>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>删除任务</Typography>
        </MenuItem>
      </Menu>

      {/* 工作空间分组「更多操作」菜单：打开文件夹 / 重命名 / 从列表中移除 */}
      <Menu
        anchorEl={groupMenu.anchorEl}
        open={!!groupMenu.anchorEl}
        onClose={() => setGroupMenu((prev) => ({ ...prev, anchorEl: null }))}
        // 锚到 ListItemButton 左下角：菜单左上对齐工作空间行底部左侧，
        // 自然落在「空间名称」正下方
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        PaperProps={{ sx: { minWidth: 168 } }}
      >
        {/* 「打开文件夹」只对**有真实目录**的分组有意义：自动任务分组是虚拟工作空间，
            默认工作空间在存储信息尚未就绪时 `fullPath` 也为空——这两种情况直接不渲染
            该项，而不是留一个点了报错的死按钮 */}
        {menuGroup?.kind === "workdir" && !!menuGroup.fullPath && (
          <MenuItem onClick={() => handleGroupAction("open", groupMenu.key)}>
            <ListItemIcon>
              <FolderOpenIcon fontSize="small" />
            </ListItemIcon>
            <Typography sx={{ fontSize: 13 }}>打开文件夹</Typography>
          </MenuItem>
        )}
        {/* 默认工作空间（key=""）不提供「重命名」：分组的名字由它的语义决定——
            组内就是设置里那个默认路径下的任务，用户改了设置之后这个名字依然成立。
            `resolveWorkspaceLabel` 也是刻意让默认名压过别名的，真给了入口只会变成
            一条「改了没反应」的脏数据（见 `tests/lib/workspace/workspaceLabel.test.ts`）。
            其余分组（含自动任务虚拟分组）都可以重命名。 */}
        {menuGroup && menuGroup.key !== "" && (
          <MenuItem onClick={() => handleGroupAction("rename", groupMenu.key)}>
            <ListItemIcon>
              <EditIcon fontSize="small" />
            </ListItemIcon>
            <Typography sx={{ fontSize: 13 }}>重命名</Typography>
          </MenuItem>
        )}
        <MenuItem
          onClick={() => handleGroupAction("remove", groupMenu.key)}
          sx={{ color: "error.main" }}
        >
          <ListItemIcon sx={{ color: "error.main" }}>
            <DeleteOutlineIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>从列表中移除</Typography>
        </MenuItem>
      </Menu>

      {/*
       * 工作空间重命名 Dialog：
       * - 标题与副标题文案按截图固定，强调「仅改显示名称，不改实际文件夹路径」，
       *   防止用户误以为可以重命名桌面上的文件夹。
       * - 「确认」按钮始终可点：空 value 在 settingsStore 内会被识别为「清除别名」，
       *   即恢复 dirBasename 的默认显示名。
       * - 与原行内编辑相比：完全绕开会话行的焦点竞争与 ListItemButton 折叠冲突，
       *   也避免了之前「onBlur 立即提交」导致用户还在打字就被吞掉的 BUG。
       */}
      <Dialog
        open={!!renameDialog}
        onClose={() => setRenameDialog(null)}
        maxWidth="xs"
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 2.5,
            bgcolor: "background.paper",
          },
        }}
      >
        <DialogTitle sx={{ fontSize: 16, fontWeight: 700, pt: 2.5 }}>
          重命名工作空间
        </DialogTitle>
        <DialogContent sx={{ pb: 1.5 }}>
          <DialogContentText sx={{ fontSize: 13, color: "text.secondary" }}>
            仅修改显示名称，不会改变实际文件夹路径。
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            value={renameDialog?.value ?? ""}
            onChange={(e) =>
              setRenameDialog((prev) =>
                prev ? { ...prev, value: e.target.value } : prev,
              )
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitGroupRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenameDialog(null);
              }
            }}
            sx={{
              mt: 1.5,
              "& .MuiInputBase-input": { fontSize: 14 },
            }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            onClick={() => setRenameDialog(null)}
            sx={{ textTransform: "none", fontSize: 13 }}
          >
            取消
          </Button>
          <Button
            variant="contained"
            onClick={submitGroupRename}
            sx={{ textTransform: "none", fontSize: 13 }}
          >
            确认
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!removeGroup}
        title="从列表中移除"
        message={
          removeGroup
            ? removeGroup.kind === "cron"
              ? `确认删除「${removeGroup.label}」的 ${removeGroup.count} 条执行记录？记录将被永久删除且不可恢复；该定时任务仍会按计划执行，下次执行会产生新的记录。`
              : `确认删除「${removeGroup.label}」下的 ${removeGroup.count} 个任务？任务及其对话将被永久删除且不可恢复。`
            : ""
        }
        danger
        confirmText="删除"
        onCancel={() => setRemoveGroup(null)}
        onConfirm={() => {
          void confirmRemoveGroup();
        }}
      />

      <ConfirmDialog
        open={!!toDelete}
        title="删除任务"
        message="确认删除该任务？此操作不可撤销。"
        danger
        confirmText="删除"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) deleteSession(toDelete);
          setToDelete(null);
        }}
      />
    </>
  );
}

function NavRow({
  item,
  active,
  onClick,
}: {
  item: NavLinkItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <ListItemButton
      onClick={onClick}
      selected={active}
      sx={{
        borderRadius: 2,
        mb: 0.25,
        py: 0.75,
        // 选中态：深色主题用深灰底+白字，浅色主题用中灰底+深灰字，彻底移除紫色
        bgcolor: (theme) =>
          active
            ? theme.palette.mode === "dark"
              ? "#2a2d35"
              : "#e2e8f0"
            : "transparent",
        "&:hover": {
          bgcolor: (theme) =>
            active
              ? theme.palette.mode === "dark"
                ? "#333842"
                : "#cbd5e1"
              : theme.palette.action.hover,
        },
      }}
    >
      <ListItemIcon
        sx={{
          minWidth: 30,
          // 统一使用次文字色图标；选中态跟随文字反色
          color: (theme) =>
            active
              ? theme.palette.mode === "dark"
                ? "#ffffff"
                : "#1f2430"
              : "text.secondary",
          fontSize: 18,
        }}
      >
        {/* 统一注入 fontSize="inherit"，让 icon 从 ListItemIcon 继承 18px，
            不必在每个 NavLinkItem 数据上手动设置 */}
        {cloneElement(item.icon as React.ReactElement, {
          fontSize: "inherit",
        })}
      </ListItemIcon>
      <ListItemText
        primary={item.label}
        primaryTypographyProps={{
          fontSize: 12.5,
          fontWeight: active ? 600 : 500,
          color: (theme) =>
            active
              ? theme.palette.mode === "dark"
                ? "#ffffff"
                : "#1f2430"
              : "text.secondary",
        }}
      />
    </ListItemButton>
  );
}
