import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Box,
  IconButton,
  Button,
  Menu,
  MenuItem,
  Typography,
  Dialog,
  DialogActions,
  Divider,
  Tooltip,
} from "@mui/material";
import {
  HorizontalRule,
  CropSquare,
  FilterNone,
  Close,
  Info,
  ViewSidebar,
  Search,
  FilterAltOutlined,
  AddCommentOutlined,
} from "@mui/icons-material";
import { useNavigate } from "react-router-dom";
import { platform } from "@/platform";
import { APP_NAME, ROUTES } from "@/lib/constants";
import { activeFilterCount } from "@/lib/taskQuery";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSessionsStore } from "@/stores/sessionsStore";
import { useTaskQueryStore } from "@/stores/taskQueryStore";
import { TaskSearchDialog } from "@/components/tasks/TaskSearchDialog";
import { TaskFilterPanel } from "@/components/tasks/TaskFilterPanel";
import { getComposerEdit } from "@/lib/composerEditBridge";
import type { AppInfo } from "@/platform/types";

/** 自绘菜单的可用键 */
type MenuKey = "edit" | "help" | null;

/** Electron 专有 -webkit-app-region 属性不在 React CSSProperties 中，用交叉类型补齐 */
type RegionStyle = CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" };

/** 编辑菜单项：execCommand 命令 + 显示用的快捷键 + 助记字母 + 所属分组 */
const EDIT_COMMANDS: Array<{
  label: string;
  letter: string;
  command: string;
  shortcut: string;
  group: number;
}> = [
  { label: "撤销", letter: "U", command: "undo", shortcut: "Ctrl+Z", group: 1 },
  { label: "重做", letter: "R", command: "redo", shortcut: "Ctrl+Y", group: 1 },
  { label: "剪切", letter: "T", command: "cut", shortcut: "Ctrl+X", group: 2 },
  { label: "复制", letter: "C", command: "copy", shortcut: "Ctrl+C", group: 2 },
  {
    label: "粘贴",
    letter: "P",
    command: "paste",
    shortcut: "Ctrl+V",
    group: 2,
  },
  {
    label: "全选",
    letter: "A",
    command: "selectAll",
    shortcut: "Ctrl+A",
    group: 3,
  },
];

/** 关于弹窗里每条信息的渲染单元：label + value，等宽字体对齐 */
function InfoRow({ label, value }: { label: string; value: string }) {
  const mono = {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  } as const;
  return (
    <Box sx={{ display: "flex", gap: 1.5, alignItems: "baseline" }}>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          minWidth: 84,
          flexShrink: 0,
          ...mono,
        }}
      >
        {label}:
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.primary",
          wordBreak: "break-all",
          ...mono,
        }}
      >
        {value || "—"}
      </Typography>
    </Box>
  );
}

/**
 * 自绘标题栏 + 自绘菜单 + 自绘窗口控件（仅 Electron 桌面端渲染）。
 * 通过 window.electronAPI 调用主进程窗口控制 IPC；macOS 使用系统红绿灯，
 * win/linux 显示自绘的最小化/最大化/关闭按钮。
 */
export function TitleBar() {
  // 双保险：非 Electron 环境不渲染（AppLayout 也会做 env 判断）
  if (platform.env !== "electron") return null;

  const navigate = useNavigate();
  const api = window.electronAPI;
  const isMac = api?.getPlatform() === "darwin";
  // 开启「关闭到托盘」后关闭按钮不再结束进程，据此调整提示文案并补一个显式退出入口
  const closeToTray = useSettingsStore((s) => s.settings.desktop?.closeToTray ?? true);

  // 侧边栏折叠状态：持久化到 settings，重开应用保持上次状态
  const sidebarCollapsed = useSettingsStore(
    (s) => s.settings.sidebarCollapsed ?? false,
  );
  const setSettings = useSettingsStore((s) => s.setSettings);
  const createSession = useSessionsStore((s) => s.createSession);
  const openTaskSearch = useTaskQueryStore((s) => s.openSearch);
  /** 生效的筛选维度个数：>0 时漏斗图标高亮，提示"当前列表已被收窄" */
  const filterCount = useTaskQueryStore((s) => activeFilterCount(s.filters));

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [openMenu, setOpenMenu] = useState<MenuKey>(null);
  /** 筛选图标的锚点：筛选面板据此在其正下方展开 */
  const [filterAnchorEl, setFilterAnchorEl] = useState<HTMLElement | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  /** 菜单按钮 DOM 引用：键盘快捷键（Alt+E / Alt+H）触发时用于定位 Menu 弹层 */
  const editBtnRef = useRef<HTMLButtonElement | null>(null);
  const helpBtnRef = useRef<HTMLButtonElement | null>(null);

  // 挂载时查询当前最大化状态，并订阅主进程推送的状态变化
  useEffect(() => {
    if (!api) return;
    void api.windowIsMaximized().then(setMaximized);
    api.onWindowMaximizeChange(setMaximized);
  }, [api]);

  // 关于弹窗打开时加载应用元信息（首次 + 每次打开都刷新，保证版本号最新）
  useEffect(() => {
    if (!aboutOpen || !api) return;
    void api.appGetInfo().then(setAppInfo);
  }, [aboutOpen, api]);

  // 托盘菜单「关于」→ 打开本弹窗（托盘在主进程，无法直接操作渲染层状态，走 IPC 下发）
  useEffect(() => {
    return window.electronAPI?.onAppOpenAbout(() => setAboutOpen(true));
  }, []);

  // 全局快捷键：Alt+E 打开编辑菜单、Alt+H 打开帮助菜单。
  // 排除输入控件聚焦场景，避免在输入时误触发
  useEffect(() => {
    const isEditable = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")
        return true;
      return el.isContentEditable;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isEditable(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "e" && editBtnRef.current) {
        e.preventDefault();
        setAnchorEl(editBtnRef.current);
        setOpenMenu("edit");
      } else if (key === "h" && helpBtnRef.current) {
        e.preventDefault();
        setAnchorEl(helpBtnRef.current);
        setOpenMenu("help");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openMenuWith =
    (key: Exclude<MenuKey, null>) => (e: React.MouseEvent<HTMLElement>) => {
      setAnchorEl(e.currentTarget);
      setOpenMenu(key);
    };
  const closeMenu = () => setOpenMenu(null);

  /**
   * 新建任务。与侧边栏的「新建任务」保持同一语义：
   * 继承当前活跃任务的工作空间与权限策略，保持上下文连贯。
   * （侧边栏收起时该入口移到这里，否则收起后就没法新建任务了）
   */
  const handleNewTask = () => {
    const st = useSessionsStore.getState();
    const current = st.sessions.find((s) => s.id === st.activeId);
    createSession(undefined, "新任务", {
      workdir: current?.workdir,
      fullAccess: current?.fullAccess,
      toolApproval: current?.toolApproval,
    });
    navigate(ROUTES.chat);
  };

  const handleEdit = (command: string) => {
    closeMenu();
    const api = getComposerEdit();
    // 撤销 / 重做 / 全选：走 Composer 自管逻辑（撤销需还原手动插入的附件徽章，
    // 浏览器原生 execCommand 对它们无效；全选需先聚焦输入框）。
    if (command === "undo") {
      api?.undo();
      return;
    }
    if (command === "redo") {
      api?.redo();
      return;
    }
    if (command === "selectAll") {
      api?.selectAll();
      return;
    }
    // 复制 / 剪切 / 粘贴：沿用浏览器原生 execCommand。输入框聚焦且有选区时，
    // copy/cut 会派发对应事件、由 Composer 的 onCopy/onCut 富路径接管；
    // paste 受浏览器安全限制可能无效。无焦点时与原先行为一致。
    try {
      document.execCommand(command);
    } catch {
      /* 部分环境不支持，忽略 */
    }
  };

  /** 关于弹窗的"复制"：把所有信息拼成多行文本写入剪贴板 */
  const handleCopyInfo = async () => {
    if (!appInfo) return;
    const text = [
      `${APP_NAME}`,
      `版本: ${appInfo.version}`,
      `Electron: ${appInfo.electron}`,
      `Node.js: ${appInfo.node}`,
      `Chromium: ${appInfo.chrome}`,
      `OS: ${appInfo.osVersion} ${appInfo.arch}`,
      `设备ID: ${appInfo.deviceId}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 兜底：极少数环境 clipboard API 不可用时用 execCommand
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  // 单个菜单项的统一 no-drag 包裹 + 样式
  const menuButtonSx = {
    color: "text.secondary",
    textTransform: "none",
    fontSize: 12.5,
    fontWeight: 400,
    minWidth: 0,
    px: 1.25,
    py: 0.5,
    lineHeight: 1.4,
  } as const;

  /** 窗口控制按钮统一样式：固定尺寸、无内边距、图标绝对居中 */
  const windowControlBtnSx = {
    width: 34,
    height: 30,
    borderRadius: 1,
    color: "text.secondary",
    p: 0,
    "&:hover": { bgcolor: "action.hover", color: "text.primary" },
  } as const;

  /** 标题栏左侧图标组（收起侧栏 / 搜索 / 筛选）统一样式：比窗口控件略小 */
  const titleIconBtnSx = {
    width: 30,
    height: 30,
    borderRadius: 1,
    color: "text.secondary",
    p: 0,
    "&:hover": { bgcolor: "action.hover", color: "text.primary" },
  } as const;

  const noDragBox = (children: ReactNode) => (
    <Box style={{ WebkitAppRegion: "no-drag" } as RegionStyle}>{children}</Box>
  );

  return (
    <Box
      sx={{
        height: 38,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        px: isMac ? 0 : 1.5,
        pl: isMac ? 76 : undefined,
        bgcolor: "background.paper",
        borderBottom: 1,
        borderColor: "divider",
        userSelect: "none",
      }}
      style={{ WebkitAppRegion: "drag" } as RegionStyle}
    >
      {/* 左侧：窗口级操作图标组 + 菜单栏。整体 no-drag，紧邻左侧。
          品牌名「nanowork」已移到侧边栏顶部，此处只留操作入口 */}
      <Box
        style={{ WebkitAppRegion: "no-drag" } as RegionStyle}
        sx={{ display: "flex", alignItems: "center", gap: 0.25 }}
      >
        {/* 收起 / 展开侧边栏 */}
        <Tooltip
          title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
          placement="bottom"
        >
          <IconButton
            size="small"
            sx={titleIconBtnSx}
            aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            onClick={() => {
              // 收起时漏斗图标会被卸载，若面板还开着就会锚定到已脱离 DOM 的节点
              setFilterAnchorEl(null);
              setSettings({ sidebarCollapsed: !sidebarCollapsed });
            }}
          >
            <ViewSidebar sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>

        {/* 侧边栏收起后，原本在侧边栏里的「搜索任务 / 筛选任务」无处安放，
            改为在这里换成「新建任务」——收起状态下最需要的正是不依赖侧栏的操作 */}
        {sidebarCollapsed ? (
          <Tooltip title="新建任务" placement="bottom">
            <IconButton
              size="small"
              sx={titleIconBtnSx}
              aria-label="新建任务"
              onClick={handleNewTask}
            >
              <AddCommentOutlined sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        ) : (
          <>
            <Tooltip title="搜索任务" placement="bottom">
              <IconButton
                size="small"
                sx={titleIconBtnSx}
                aria-label="搜索任务"
                onClick={openTaskSearch}
              >
                <Search sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="筛选任务" placement="bottom">
              <IconButton
                size="small"
                color={filterCount > 0 ? "primary" : "default"}
                sx={titleIconBtnSx}
                aria-label="筛选任务"
                onClick={(e) => setFilterAnchorEl(e.currentTarget)}
              >
                <FilterAltOutlined sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          </>
        )}

        {/* 菜单栏：编辑(E) / 帮助(H)；字母外加下划线提示助记符 */}
        <Box sx={{ display: "flex", alignItems: "center", ml: 1 }}>
          <Button
            ref={editBtnRef}
            sx={menuButtonSx}
            onClick={openMenuWith("edit")}
            title="Alt+E"
          >
            编辑(<u>E</u>)
          </Button>
          <Button
            ref={helpBtnRef}
            sx={menuButtonSx}
            onClick={openMenuWith("help")}
            title="Alt+H"
          >
            帮助(<u>H</u>)
          </Button>
        </Box>
      </Box>

      {/* Menu 弹层（通过 anchorEl 定位，作为 portal 渲染到 body，与布局解耦） */}
      <Menu
        open={openMenu === "edit"}
        anchorEl={anchorEl}
        onClose={closeMenu}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{
          paper: {
            sx: { minWidth: 200 },
          },
        }}
      >
        {EDIT_COMMANDS.map((item, i) => {
          // 跨组时插入细分割线（撤销/重做 | 剪切/复制/粘贴 | 全选）
          const showDivider =
            i > 0 && item.group !== EDIT_COMMANDS[i - 1].group;
          return (
            <Box key={item.command}>
              {showDivider && (
                <Divider sx={{ my: 0.25, borderColor: "divider" }} />
              )}
              <MenuItem
                onClick={() => handleEdit(item.command)}
                sx={{ fontSize: 12.5, py: 0.5 }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    gap: 3,
                  }}
                >
                  <Typography
                    component="span"
                    sx={{ fontSize: 12.5, color: "text.primary" }}
                  >
                    {item.label}(<u>{item.letter}</u>)
                  </Typography>
                  <Typography
                    component="span"
                    sx={{
                      fontSize: 11.5,
                      color: "text.secondary",
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, monospace",
                    }}
                  >
                    {item.shortcut}
                  </Typography>
                </Box>
              </MenuItem>
            </Box>
          );
        })}
      </Menu>
      <Menu
        open={openMenu === "help"}
        anchorEl={anchorEl}
        onClose={closeMenu}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <MenuItem
          onClick={() => {
            closeMenu();
            setAboutOpen(true);
          }}
          sx={{ fontSize: 12.5, py: 0.5 }}
        >
          关于
        </MenuItem>
        {/* 开启「关闭到托盘」后关闭按钮只隐藏窗口，这里补一个显式退出入口，
            避免用户以为程序退不掉（托盘右键菜单也有同样的「退出」项） */}
        {closeToTray && (
          <>
            <Divider sx={{ my: 0.25, borderColor: "divider" }} />
            <MenuItem
              onClick={() => {
                closeMenu();
                window.electronAPI?.appQuit();
              }}
              sx={{ fontSize: 12.5, py: 0.5 }}
            >
              退出
            </MenuItem>
          </>
        )}
      </Menu>

      {/* 中间弹性占位（可拖拽区） */}
      <Box sx={{ flex: 1 }} />

      {/* 窗口控件（仅 win/linux；macOS 使用系统红绿灯） */}
      {!isMac &&
        noDragBox(
          <Box sx={{ display: "flex", alignItems: "center", ml: 0.5 }}>
            <IconButton
              size="small"
              sx={windowControlBtnSx}
              onClick={() => api?.windowMinimize()}
              title="最小化"
            >
              <HorizontalRule sx={{ fontSize: 16 }} />
            </IconButton>
            <IconButton
              size="small"
              sx={windowControlBtnSx}
              onClick={() => api?.windowToggleMaximize()}
              title="最大化/还原"
            >
              {maximized ? (
                <FilterNone sx={{ fontSize: 16 }} />
              ) : (
                <CropSquare sx={{ fontSize: 16 }} />
              )}
            </IconButton>
            <IconButton
              size="small"
              sx={windowControlBtnSx}
              onClick={() => api?.windowClose()}
              title={closeToTray ? "关闭（最小化到托盘）" : "关闭"}
            >
              <Close sx={{ fontSize: 16 }} />
            </IconButton>
          </Box>,
        )}

      {/* 关于对话框 */}
      <Dialog
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <Box sx={{ px: 3, pt: 3, pb: 1 }}>
          {/* Header：圆形信息图标 + 应用名 */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 2 }}>
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                bgcolor: "primary.main",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Info sx={{ color: "primary.contrastText", fontSize: 22 }} />
            </Box>
            <Typography
              variant="h6"
              sx={{
                color: "primary.main",
                fontWeight: 600,
                lineHeight: 1.2,
              }}
            >
              {APP_NAME}
            </Typography>
          </Box>

          {/* 信息列表：等宽字体、左对齐 label+冒号、值右贴 */}
          {appInfo ? (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
              <InfoRow label="版本" value={appInfo.version} />
              <InfoRow label="Electron" value={appInfo.electron} />
              <InfoRow label="Node.js" value={appInfo.node} />
              <InfoRow label="Chromium" value={appInfo.chrome} />
              <InfoRow
                label="操作系统"
                value={`${appInfo.osVersion} (${appInfo.arch})`}
              />
              <InfoRow label="设备ID" value={appInfo.deviceId} />
            </Box>
          ) : (
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", display: "block" }}
            >
              正在加载…
            </Typography>
          )}
        </Box>
        <DialogActions sx={{ px: 3, pb: 2.5, pt: 1, gap: 1 }}>
          <Button
            onClick={handleCopyInfo}
            variant="outlined"
            disabled={!appInfo}
          >
            复制
          </Button>
          <Button
            onClick={() => setAboutOpen(false)}
            variant="contained"
            autoFocus
          >
            确定
          </Button>
        </DialogActions>
      </Dialog>

      {/* 搜索任务：居中弹窗（portal 渲染，与标题栏布局无关） */}
      <TaskSearchDialog />
      {/* 筛选面板：锚定漏斗图标，在其正下方展开 */}
      <TaskFilterPanel
        anchorEl={filterAnchorEl}
        open={filterAnchorEl !== null}
        onClose={() => setFilterAnchorEl(null)}
      />
    </Box>
  );
}
