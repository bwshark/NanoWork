import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Avatar,
  Box,
  Divider,
  IconButton,
  InputAdornment,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  MenuList,
  Popover,
  TextField,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";
import LayersIcon from "@mui/icons-material/Layers";
import PsychologyIcon from "@mui/icons-material/Psychology";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import HubIcon from "@mui/icons-material/Hub";
import ArrowRightIcon from "@mui/icons-material/ArrowRight";
import SearchIcon from "@mui/icons-material/Search";
import NorthEastIcon from "@mui/icons-material/NorthEast";
import UploadIcon from "@mui/icons-material/Upload";
import SettingsIcon from "@mui/icons-material/Settings";
import LinkIcon from "@mui/icons-material/Link";
import { useAgentsStore } from "@/stores/agentsStore";
import { useSkillsStore } from "@/stores/skillsStore";
import { useMcpStore } from "@/stores/mcpStore";
import { ATTACHMENT_ACCEPT } from "@/lib/attachments";
import { parseSkillFromMarkdown } from "@/lib/skillParser";
import { ROUTES } from "@/lib/constants";
import { toast } from "@/components/Toast";

interface ComposerMenuProps {
  onFilesSelected?: (files: FileList) => void;
  /** 点击「引用对话中的文件」：由 Composer 插入 @ 并弹出引用浮层 */
  onQuoteFile?: () => void;
  /** 用户从技能子菜单选择了一个已启用技能 */
  onSkillSelect?: (skillId: string) => void;
  /** 用户从专家子菜单选择了一个 Agent */
  onAgentSelect?: (agentId: string) => void;
}

type SubMenuType = "agents" | "skills" | "mcp" | null;

interface MenuItemDef {
  label: string;
  icon: typeof AddIcon;
  action: string;
  hasSub?: boolean;
}

const MENU_ITEMS: MenuItemDef[] = [
  { label: "添加文件", icon: AttachFileIcon, action: "file" },
  { label: "引用对话中的文件", icon: InsertDriveFileIcon, action: "quote" },
  { label: "模式", icon: LayersIcon, action: "mode" },
  { label: "专家", icon: PsychologyIcon, action: "agents", hasSub: true },
  { label: "技能", icon: AutoFixHighIcon, action: "skills", hasSub: true },
  { label: "连接器", icon: HubIcon, action: "mcp", hasSub: true },
];

/** 鼠标离开菜单区域后，延迟收起子菜单的缓冲时间(ms)，避免斜向移动时误关 */
const SUB_CLOSE_DELAY = 150;

const PAPER_SX = {
  width: 280,
  bgcolor: "background.paper",
  border: "1px solid",
  borderColor: "divider",
  borderRadius: 2,
  boxShadow: (theme: import("@mui/material").Theme) => theme.shadows[8],
  overflow: "hidden",
};

const ROW_SX = {
  py: 1,
  px: 1.5,
  gap: 1.5,
  "&:hover": { bgcolor: "action.hover" },
};

/** 取出字符串第一个可显示字符作为头像 */
function firstChar(name: string) {
  return name.trim().charAt(0) || "?";
}

/** 给名字一个稳定色相(基于字符串 hash) */
function stringToHue(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}

/** Composer 左侧加号菜单：文件 / 引用 / 模式 / 专家 / 技能 / 连接器 */
export function ComposerMenu({
  onFilesSelected,
  onQuoteFile,
  onSkillSelect,
  onAgentSelect,
}: ComposerMenuProps) {
  const navigate = useNavigate();

  const agents = useAgentsStore((s) => s.agents.filter((a) => a.enabled));
  const skills = useSkillsStore((s) => s.skills.filter((sk) => sk.enabled));
  const { configs: mcpConfigs, testConfig } = useMcpStore();
  const installSkill = useSkillsStore((s) => s.installSkill);

  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [subAnchor, setSubAnchor] = useState<null | HTMLElement>(null);
  const [activeSub, setActiveSub] = useState<SubMenuType>(null);

  const [agentQ, setAgentQ] = useState("");
  const [skillQ, setSkillQ] = useState("");
  const [mcpQ, setMcpQ] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillInputRef = useRef<HTMLInputElement>(null);
  /** 子菜单延时收起任务句柄，用于 hover 意图判断 */
  const closeTimerRef = useRef<number | null>(null);
  /** 子菜单 paper 元素引用，用于判断焦点是否仍在子菜单内（如正在搜索框输入） */
  const subPaperRef = useRef<HTMLDivElement | null>(null);

  const open = Boolean(anchor);
  const subOpen = Boolean(subAnchor) && activeSub !== null;

  const handleToggle = (e: React.MouseEvent<HTMLElement>) => {
    if (open) {
      handleClose();
    } else {
      setAnchor(e.currentTarget);
    }
  };

  /** 清除待执行的子菜单延时收起任务 */
  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  /** 立即收起子菜单 */
  const closeSub = () => {
    clearCloseTimer();
    setSubAnchor(null);
    setActiveSub(null);
  };

  /**
   * 延迟收起子菜单：
   * 鼠标在「主菜单 ↔ 子菜单」间斜向移动时会短暂离开两者，用缓冲避免误关；
   * 若焦点仍在子菜单内（如在搜索框输入），则跳过收起。
   */
  const scheduleCloseSub = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (subPaperRef.current?.contains(document.activeElement)) return;
      setSubAnchor(null);
      setActiveSub(null);
    }, SUB_CLOSE_DELAY);
  };

  // 组件卸载时清理定时器
  useEffect(() => clearCloseTimer, []);

  const handleClose = () => {
    clearCloseTimer();
    setAnchor(null);
    setSubAnchor(null);
    setActiveSub(null);
    setAgentQ("");
    setSkillQ("");
    setMcpQ("");
  };

  const openSub = (e: React.MouseEvent<HTMLElement>, type: SubMenuType) => {
    if (!type) return;
    clearCloseTimer();
    // 必须同步读取 currentTarget：React 事件对象进入异步更新器后
    // currentTarget 会失效为 null，导致锚点丢失、子菜单无法弹出
    const el = e.currentTarget;
    // 只在真正切换时才 setState，避免同个目标反复渲染冲掉 hover 样式
    setSubAnchor((prev) => (prev === el ? prev : el));
    setActiveSub((prev) => (prev === type ? prev : type));
  };

  const handleMainAction = (
    e: React.MouseEvent<HTMLElement>,
    action: string,
  ) => {
    if (action === "agents" || action === "skills" || action === "mcp") {
      // 带子菜单的项：悬浮即展开；点击兜底确保展开（触屏场景），不关闭主菜单
      openSub(e, action as SubMenuType);
      return;
    }
    handleClose();
    switch (action) {
      case "file":
        fileInputRef.current?.click();
        break;
      case "quote":
        // 引用对话中的文件：在输入框光标处插入 @ 触发引用浮层
        onQuoteFile?.();
        break;
      default:
        break;
    }
  };

  const handleSkillSelect = (skillId: string) => {
    onSkillSelect?.(skillId);
    handleClose();
  };

  const handleAgentSelect = (agentId: string) => {
    onAgentSelect?.(agentId);
    handleClose();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      onFilesSelected?.(files);
    }
    e.target.value = "";
  };

  const handleSkillFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const skill = parseSkillFromMarkdown(text, file.name, "local");
      installSkill(skill);
      toast.success(`已添加技能「${skill.name}」`);
    } catch (err) {
      toast.error(
        `技能文件解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleMcpConnect = async (id: string, name: string) => {
    try {
      await testConfig(id);
      toast.success(`「${name}」连接成功`);
    } catch (err) {
      toast.error(`「${name}」连接失败`);
    }
  };

  const filteredAgents = useMemo(
    () =>
      agents.filter((a) =>
        a.name.toLowerCase().includes(agentQ.trim().toLowerCase()),
      ),
    [agents, agentQ],
  );

  const filteredSkills = useMemo(
    () =>
      skills.filter(
        (s) =>
          s.name.toLowerCase().includes(skillQ.trim().toLowerCase()) ||
          s.description.toLowerCase().includes(skillQ.trim().toLowerCase()),
      ),
    [skills, skillQ],
  );

  const filteredMcp = useMemo(
    () =>
      mcpConfigs.filter(
        (c) =>
          c.enabled !== false &&
          c.name.toLowerCase().includes(mcpQ.trim().toLowerCase()),
      ),
    [mcpConfigs, mcpQ],
  );

  const renderSubMenu = () => {
    if (!activeSub) return null;

    if (activeSub === "agents") {
      return (
        <>
          <Box
            sx={{
              px: 1.5,
              py: 1.25,
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <TextField
              fullWidth
              size="small"
              placeholder="搜索专家"
              value={agentQ}
              onChange={(e) => setAgentQ(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon
                      fontSize="small"
                      sx={{ color: "text.secondary" }}
                    />
                  </InputAdornment>
                ),
                sx: {
                  bgcolor: (theme) =>
                    theme.palette.mode === "dark"
                      ? "rgba(255,255,255,0.05)"
                      : "rgba(0,0,0,0.04)",
                  borderRadius: 1.5,
                  "& fieldset": { border: "none" },
                  "& .MuiInputBase-input": { fontSize: 13, py: 0.75 },
                },
              }}
            />
          </Box>
          <MenuList sx={{ py: 0.5, maxHeight: 360, overflow: "auto" }}>
            {filteredAgents.length === 0 && (
              <MenuItem disabled>
                <Typography variant="body2" color="text.secondary">
                  暂无可用专家
                </Typography>
              </MenuItem>
            )}
            {filteredAgents.map((a) => {
              const hue = stringToHue(a.name);
              return (
                <MenuItem
                  key={a.id}
                  onClick={() => handleAgentSelect(a.id)}
                  sx={ROW_SX}
                >
                  <Avatar
                    sx={{
                      width: 28,
                      height: 28,
                      fontSize: 13,
                      bgcolor: `hsl(${hue}, 70%, 45%)`,
                    }}
                  >
                    {firstChar(a.name)}
                  </Avatar>
                  <ListItemText
                    primary={a.name}
                    secondary={
                      a.skillIds.length > 0
                        ? `已绑定 ${a.skillIds.length} 项技能`
                        : "未绑定技能"
                    }
                    primaryTypographyProps={{ fontSize: 14 }}
                    secondaryTypographyProps={{ fontSize: 12 }}
                  />
                </MenuItem>
              );
            })}
            <Divider />
            <MenuItem
              onClick={() => {
                handleClose();
                // 召唤更多专家直接进专家管理页——hover 任意卡片点"召唤"即可，
                // 合并前这里带 ?select=true 跳到独立的"选择专家"页，合并后统一入口
                navigate(ROUTES.agents);
              }}
              sx={ROW_SX}
            >
              <ListItemIcon sx={{ minWidth: 28, color: "text.secondary" }}>
                <NorthEastIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary="召唤更多专家"
                primaryTypographyProps={{ fontSize: 14 }}
              />
            </MenuItem>
          </MenuList>
        </>
      );
    }

    if (activeSub === "skills") {
      return (
        <>
          <Box
            sx={{
              px: 1.5,
              py: 1.25,
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <TextField
              fullWidth
              size="small"
              placeholder="搜索技能"
              value={skillQ}
              onChange={(e) => setSkillQ(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon
                      fontSize="small"
                      sx={{ color: "text.secondary" }}
                    />
                  </InputAdornment>
                ),
                sx: {
                  bgcolor: (theme) =>
                    theme.palette.mode === "dark"
                      ? "rgba(255,255,255,0.05)"
                      : "rgba(0,0,0,0.04)",
                  borderRadius: 1.5,
                  "& fieldset": { border: "none" },
                  "& .MuiInputBase-input": { fontSize: 13, py: 0.75 },
                },
              }}
            />
          </Box>
          <MenuList sx={{ py: 0.5, maxHeight: 360, overflow: "auto" }}>
            {filteredSkills.length === 0 && (
              <MenuItem disabled>
                <Typography variant="body2" color="text.secondary">
                  暂无已启用技能
                </Typography>
              </MenuItem>
            )}
            {filteredSkills.map((s) => (
              <MenuItem
                key={s.id}
                onClick={() => handleSkillSelect(s.id)}
                sx={{ ...ROW_SX, alignItems: "flex-start" }}
              >
                <ListItemIcon
                  sx={{ minWidth: 28, color: "text.secondary", mt: 0.2 }}
                >
                  <Typography sx={{ fontSize: 18 }}>
                    {s.icon ?? "📦"}
                  </Typography>
                </ListItemIcon>
                <ListItemText
                  primary={s.name}
                  secondary={s.description}
                  primaryTypographyProps={{ fontSize: 14 }}
                  secondaryTypographyProps={{ fontSize: 12, noWrap: true }}
                />
              </MenuItem>
            ))}
            <Divider />
            <MenuItem
              onClick={() => skillInputRef.current?.click()}
              sx={ROW_SX}
            >
              <ListItemIcon sx={{ minWidth: 28, color: "text.secondary" }}>
                <UploadIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary="从本地添加技能"
                primaryTypographyProps={{ fontSize: 14 }}
              />
            </MenuItem>
            <MenuItem
              onClick={() => {
                handleClose();
                navigate(ROUTES.skills);
              }}
              sx={ROW_SX}
            >
              <ListItemIcon sx={{ minWidth: 28, color: "text.secondary" }}>
                <SettingsIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary="管理技能"
                primaryTypographyProps={{ fontSize: 14 }}
              />
            </MenuItem>
          </MenuList>
        </>
      );
    }

    // mcp
    return (
      <>
        <Box
          sx={{
            px: 1.5,
            py: 1.25,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <TextField
            fullWidth
            size="small"
            placeholder="搜索连接器"
            value={mcpQ}
            onChange={(e) => setMcpQ(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon
                    fontSize="small"
                    sx={{ color: "text.secondary" }}
                  />
                </InputAdornment>
              ),
              sx: {
                bgcolor: (theme) =>
                  theme.palette.mode === "dark"
                    ? "rgba(255,255,255,0.05)"
                    : "rgba(0,0,0,0.04)",
                borderRadius: 1.5,
                "& fieldset": { border: "none" },
                "& .MuiInputBase-input": { fontSize: 13, py: 0.75 },
              },
            }}
          />
        </Box>
        <MenuList sx={{ py: 0.5, maxHeight: 360, overflow: "auto" }}>
          {filteredMcp.length === 0 && (
            <MenuItem disabled>
              <Typography variant="body2" color="text.secondary">
                暂无连接器
              </Typography>
            </MenuItem>
          )}
          {filteredMcp.map((c) => (
            <MenuItem
              key={c.id}
              sx={{ ...ROW_SX, justifyContent: "space-between" }}
            >
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1.5,
                  overflow: "hidden",
                }}
              >
                <ListItemIcon sx={{ minWidth: 28, color: "text.secondary" }}>
                  <HubIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText
                  primary={c.name}
                  primaryTypographyProps={{ fontSize: 14, noWrap: true }}
                />
              </Box>
              <Box
                onClick={() => handleMcpConnect(c.id, c.name)}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.5,
                  color: "text.secondary",
                  fontSize: 13,
                  cursor: "pointer",
                  "&:hover": { color: "primary.main" },
                }}
              >
                <LinkIcon fontSize="small" />
                <span>连接</span>
              </Box>
            </MenuItem>
          ))}
          <Divider />
          <MenuItem
            onClick={() => {
              handleClose();
              navigate(ROUTES.mcp);
            }}
            sx={ROW_SX}
          >
            <ListItemIcon sx={{ minWidth: 28, color: "text.secondary" }}>
              <SettingsIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary="管理连接器"
              primaryTypographyProps={{ fontSize: 14 }}
            />
          </MenuItem>
        </MenuList>
      </>
    );
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        // 可选类型由附件映射表派生，保证「能选的都能传」
        accept={ATTACHMENT_ACCEPT}
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
      <input
        ref={skillInputRef}
        type="file"
        accept=".md"
        style={{ display: "none" }}
        onChange={handleSkillFileChange}
      />

      <IconButton
        size="small"
        onClick={handleToggle}
        sx={{
          color: "text.secondary",
          "&:hover": { color: "text.primary", bgcolor: "action.hover" },
        }}
      >
        {open ? <CloseIcon fontSize="small" /> : <AddIcon fontSize="small" />}
      </IconButton>

      <Menu
        anchorEl={anchor}
        open={open}
        onClose={handleClose}
        disableAutoFocusItem
        anchorOrigin={{ vertical: "top", horizontal: "left" }}
        transformOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{
          paper: {
            sx: {
              ...PAPER_SX,
              py: 0.5,
            },
            // 鼠标离开主菜单面板时延时收起子菜单（子菜单自身会取消该任务）
            onMouseLeave: scheduleCloseSub,
          },
        }}
      >
        {MENU_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeSub === item.action;
          return (
            <MenuItem
              key={item.action}
              selected={isActive}
              onClick={(e) => handleMainAction(e, item.action)}
              onMouseEnter={(e) => {
                if (item.hasSub) {
                  openSub(e, item.action as SubMenuType);
                } else {
                  // 悬停普通项时立即收起子菜单，避免旧子菜单悬挂
                  closeSub();
                }
              }}
              sx={{
                ...ROW_SX,
                justifyContent: "space-between",
                "&.Mui-selected": { bgcolor: "action.selected" },
                "&.Mui-selected:hover": { bgcolor: "action.selected" },
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                <Box
                  sx={{
                    color: isActive ? "primary.main" : "text.secondary",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <Icon fontSize="small" />
                </Box>
                <Typography variant="body2" sx={{ fontSize: 14 }}>
                  {item.label}
                </Typography>
              </Box>
              {item.hasSub && (
                <ArrowRightIcon
                  fontSize="small"
                  sx={{
                    ml: "auto",
                    color: isActive ? "primary.main" : "text.secondary",
                  }}
                />
              )}
            </MenuItem>
          );
        })}
      </Menu>

      <Popover
        open={subOpen}
        anchorEl={subAnchor}
        onClose={() => {
          setSubAnchor(null);
          setActiveSub(null);
        }}
        // 子菜单是「悬浮跟随」面板：
        // 1. hideBackdrop 去掉透明遮罩；根节点 pointer-events: none 让全屏 fixed 层
        //    不再拦截主菜单的鼠标事件（否则子菜单一旦打开，主菜单 hover 全部失效）
        // 2. 禁用焦点接管，避免悬浮展开时抢走输入框焦点
        hideBackdrop
        disableAutoFocus
        disableEnforceFocus
        disableRestoreFocus
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{
          root: { sx: { pointerEvents: "none" } },
          paper: {
            ref: subPaperRef,
            onMouseEnter: clearCloseTimer,
            onMouseLeave: scheduleCloseSub,
            sx: {
              ...PAPER_SX,
              pointerEvents: "auto",
            },
          },
        }}
      >
        {renderSubMenu()}
      </Popover>
    </>
  );
}
