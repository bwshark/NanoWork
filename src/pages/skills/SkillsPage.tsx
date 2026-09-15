import { useRef, useState, useMemo, useEffect } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  IconButton,
  InputAdornment,
  Menu,
  MenuItem,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import AddIcon from "@mui/icons-material/Add";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import CheckIcon from "@mui/icons-material/Check";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import CircularProgress from "@mui/material/CircularProgress";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChecklistIcon from "@mui/icons-material/Checklist";
import { useSkillsStore } from "@/stores/skillsStore";
import { toast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { parseSkillFromMarkdown } from "@/lib/skillParser";
import { clampLines, hoverCardSx, iconTileSx } from "@/lib/cardSx";
import type { Skill } from "@/types";

/** 右上角「⋯」菜单按钮：低对比常驻，hover 提亮。 */
const menuIconButtonSx = {
  p: 0.5,
  color: "text.secondary",
  transition: "color .18s ease, background-color .18s ease",
  "&:hover": { color: "text.primary", bgcolor: "action.hover" },
};

/** 右上角圆角方形图标按钮（安装「+」）：与卡片描边同族，hover 时提亮。 */
const squareIconButtonSx = {
  p: 0.5,
  width: 30,
  height: 30,
  border: "1px solid",
  borderColor: "divider",
  borderRadius: "9px",
  color: "text.secondary",
  transition: "border-color .18s ease, color .18s ease, background-color .18s ease",
  "&:hover": {
    borderColor: "var(--hover-border)",
    color: "text.primary",
    bgcolor: "action.hover",
  },
};

/**
 * 技能卡片：「全部技能」与「我安装的」两个视图共用，右上角操作按视图区分：
 * - market（全部技能）三态：未安装「+」→ 安装中 loading → 已安装「✓ + ⋯ 菜单」；
 *   停用后恢复「+」外观，点击可重新启用。
 * - installed（我安装的）：始终为 Switch 开关，直接启用/停用（停用后移出该视图）。
 */
function SkillCard({
  skill,
  view,
  onToggle,
  onDelete,
  onInstalled,
}: {
  skill: Skill;
  /** 所处视图：market = 全部技能市场；installed = 我安装的列表 */
  view: "market" | "installed";
  onToggle: (id: string) => void;
  onDelete: (skill: Skill) => void;
  /** 安装流程完成时回调（仅 market 视图的「+」流程会触发） */
  onInstalled?: (id: string) => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const installTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清理未完成的安装定时器，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (installTimer.current) clearTimeout(installTimer.current);
    };
  }, []);

  const handleInstall = () => {
    setInstalling(true);
    installTimer.current = setTimeout(() => {
      onToggle(skill.id);
      setInstalling(false);
      onInstalled?.(skill.id);
    }, 800);
  };

  /** 右上角操作区：installed 视图为 Switch；market 视图为三态按钮 */
  const renderAction = () => {
    if (view === "installed") {
      return (
        <>
          <Switch
            size="small"
            checked={skill.enabled}
            onChange={() => onToggle(skill.id)}
            aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.name}`}
          />
          {/*
           * 本地技能在「我安装的」里保留 ⋯ 菜单：
           * 市场视图不再展示已安装技能，删除入口必须留在这一侧。
           */}
          {skill.source === "local" && (
            <>
              <IconButton
                size="small"
                aria-label={`${skill.name} 操作菜单`}
                onClick={(e) => setMenuAnchor(e.currentTarget)}
                sx={menuIconButtonSx}
              >
                <MoreHorizIcon sx={{ fontSize: 18 }} />
              </IconButton>
              <Menu
                anchorEl={menuAnchor}
                open={!!menuAnchor}
                onClose={() => setMenuAnchor(null)}
                transformOrigin={{ horizontal: "right", vertical: "top" }}
                anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
              >
                <MenuItem
                  onClick={() => {
                    setMenuAnchor(null);
                    onDelete(skill);
                  }}
                >
                  删除
                </MenuItem>
              </Menu>
            </>
          )}
        </>
      );
    }
    if (skill.enabled) {
      return (
        <>
          <IconButton
            size="small"
            aria-label={`${skill.name} 操作菜单`}
            onClick={(e) => setMenuAnchor(e.currentTarget)}
            sx={menuIconButtonSx}
          >
            <MoreHorizIcon sx={{ fontSize: 18 }} />
          </IconButton>
          <CheckIcon
            sx={{ fontSize: 18, color: "text.secondary" }}
            aria-label="已安装"
          />
          <Menu
            anchorEl={menuAnchor}
            open={!!menuAnchor}
            onClose={() => setMenuAnchor(null)}
            transformOrigin={{ horizontal: "right", vertical: "top" }}
            anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
          >
            <MenuItem
              onClick={() => {
                onToggle(skill.id);
                setMenuAnchor(null);
              }}
            >
              停用
            </MenuItem>
            {skill.source === "local" && (
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  onDelete(skill);
                }}
              >
                删除
              </MenuItem>
            )}
          </Menu>
        </>
      );
    }
    if (installing) {
      return (
        <Box
          sx={{
            width: 30,
            height: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CircularProgress size={18} aria-label="安装中" />
        </Box>
      );
    }
    return (
      <IconButton
        size="small"
        aria-label={`安装 ${skill.name}`}
        onClick={handleInstall}
        sx={squareIconButtonSx}
      >
        <AddIcon sx={{ fontSize: 18 }} />
      </IconButton>
    );
  };

  return (
    <Card
      variant="outlined"
      sx={[
        hoverCardSx,
        {
          opacity: skill.enabled ? 1 : 0.72,
          transition:
            "opacity .2s ease, background-color .18s ease, border-color .18s ease, box-shadow .18s ease",
        },
      ]}
    >
      <CardContent sx={{ p: 2.5, "&:last-child": { pb: 2.5 } }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <Box sx={iconTileSx(skill.name)} aria-hidden>
            {skill.icon ?? "📦"}
          </Box>
          <Typography
            fontWeight={600}
            sx={{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 1.4 }}
            noWrap
          >
            {skill.name}
          </Typography>
          {renderAction()}
        </Box>
        <Typography
          title={skill.description}
          sx={{
            mt: 1.5,
            fontSize: 12.5,
            color: "text.secondary",
            lineHeight: 1.6,
            minHeight: 40,
            ...clampLines(2),
          }}
        >
          {skill.description}
        </Typography>
      </CardContent>
    </Card>
  );
}

/** 技能市场页（FR-003）：搜索、分类筛选、启用/停用、本地安装 */
export function SkillsPage() {
  const skills = useSkillsStore((s) => s.skills);
  const toggleSkill = useSkillsStore((s) => s.toggleSkill);
  const installSkill = useSkillsStore((s) => s.installSkill);
  const removeSkill = useSkillsStore((s) => s.removeSkill);
  const refresh = useSkillsStore((s) => s.refresh);

  /**
   * 每次进入技能市场页面都重新扫描本地目录并合并。
   * 不再依赖 `loaded` 守卫——手动「刷新本地」按钮已移除，
   * 但用户仍可能在本会话中新增/删除本地 .md 文件，
   * 重入页面时需要把最新目录反映上来。
   */
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [q, setQ] = useState("");
  const [category, setCategory] = useState("全部");
  /** 视图模式：「全部」走全量市场；「已安装」独立二级页面布局 */
  const [view, setView] = useState<"all" | "installed">("all");
  /** 「我安装的」视图内的检索关键字（与 AllView 的 q 独立，互不影响） */
  const [installedQuery, setInstalledQuery] = useState("");
  const [toDelete, setToDelete] = useState<Skill | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * 本次会话刚安装的技能 id 集合：安装完成后市场页保留展示（⋯ ✓ 态），
   * 离开市场页后组件卸载、state 丢失，再次进入即不再展示已安装技能。
   */
  const [freshInstalledIds, setFreshInstalledIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const handleInstalled = (id: string) =>
    setFreshInstalledIds((prev) => new Set(prev).add(id));

  /**
   * 市场视图列表池：全部未安装技能 + 本次会话刚安装的技能（保留 ✓⋯ 态）。
   * 已安装技能只出现在「我安装的」视图，避免同一技能两个入口并存。
   */
  const marketPool = useMemo(
    () => skills.filter((s) => !s.enabled || freshInstalledIds.has(s.id)),
    [skills, freshInstalledIds],
  );

  const categories = useMemo(() => {
    const set = new Set(marketPool.map((s) => s.category));
    return ["全部", ...Array.from(set)];
  }, [marketPool]);

  const installedCount = skills.filter((s) => s.enabled).length;

  /** AllView 过滤：市场池（未安装 + 本次新安装）+ 分类筛选 + 关键字检索（q） */
  const filteredAll = useMemo(() => {
    let list = marketPool;
    if (category !== "全部") {
      list = list.filter((s) => s.category === category);
    }
    if (q.trim()) {
      const lower = q.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(lower) ||
          s.description.toLowerCase().includes(lower) ||
          s.category.toLowerCase().includes(lower),
      );
    }
    return list;
  }, [marketPool, category, q]);

  /** InstalledView 过滤：仅启用 + installedQuery 关键字检索 */
  const filteredInstalled = useMemo(() => {
    let list = skills.filter((s) => s.enabled);
    if (installedQuery.trim()) {
      const lower = installedQuery.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(lower) ||
          s.description.toLowerCase().includes(lower),
      );
    }
    return list;
  }, [skills, installedQuery]);

  /**
   * 当前分类下已无可安装技能时回退到「全部」，
   * 避免 Tabs 收到不在选项中的 value（MUI 会告警且不高亮任何 Tab）。
   */
  useEffect(() => {
    if (category !== "全部" && !categories.includes(category)) {
      setCategory("全部");
    }
  }, [categories, category]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    try {
      const text = await file.text();
      const skill = parseSkillFromMarkdown(text, file.name);
      installSkill(skill);
      toast.success(`已安装技能：${skill.name}`);
    } catch (err) {
      toast.error(
        `安装失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    e.target.value = "";
  };

  return (
    <Box sx={{ p: 3, maxWidth: 1100, margin: "0 auto" }}>
      {view === "installed" ? (
        <>
      {/*
       * 「我安装的」视图：面包屑返回 + 大标题 + 工具栏 + 卡片网格
       * 与「全部技能」共用 SkillCard 组件，仅过滤条件不同（仅 enabled + installedQuery）。
       */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
        <IconButton onClick={() => setView("all")} size="small" aria-label="返回全部技能">
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Typography variant="body2" color="text.secondary">
          全部技能
        </Typography>
      </Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          mb: 3,
          flexWrap: "wrap",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography variant="h5" fontWeight={700}>
            我安装的
          </Typography>
          <Box
            sx={{
              px: 1,
              py: 0.25,
              borderRadius: 999,
              bgcolor: "action.hover",
              color: "text.secondary",
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.5,
            }}
          >
            {installedCount}
          </Box>
        </Box>
        <Box sx={{ flex: 1 }} />
        <Button
          variant="outlined"
          size="small"
          startIcon={<ChecklistIcon />}
          sx={{ textTransform: "none" }}
        >
          批量管理
        </Button>
        <TextField
          size="small"
          placeholder="搜索已安装的技能"
          value={installedQuery}
          onChange={(e) => setInstalledQuery(e.target.value)}
          sx={{ width: 220 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
      </Box>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: 2,
          alignItems: "flex-start",
        }}
      >
        {filteredInstalled.map((s) => (
          <SkillCard
            key={s.id}
            skill={s}
            view="installed"
            onToggle={toggleSkill}
            onDelete={setToDelete}
          />
        ))}
      </Box>
      {filteredInstalled.length === 0 && (
        <Box sx={{ textAlign: "center", py: 8, color: "text.secondary" }}>
          <Typography>
            {installedQuery.trim()
              ? "未找到匹配「" + installedQuery.trim() + "」的已安装技能"
              : "暂无启用的技能"}
          </Typography>
        </Box>
      )}
      </>
      ) : (
        <>
      {/*
       * 标题行：技能市场 + spacer + 搜索 / 我安装的 / 添加技能
       * 三个工具按钮内联到同一行最右侧，省去独立工具栏 Box；
       * flexWrap 在窄屏（< ~700px）下优雅换行，避免挤压。
       */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          mb: 2,
          flexWrap: "wrap",
        }}
      >
        <Typography variant="h5" fontWeight={700}>
          技能市场
        </Typography>
        <Box sx={{ flex: 1 }} />
        <TextField
          size="small"
          placeholder="搜索技能"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          sx={{ width: 180 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <Button
          variant="outlined"
          size="small"
          startIcon={<Inventory2OutlinedIcon />}
          onClick={() => setView("installed")}
          sx={{ textTransform: "none" }}
        >
          我安装的 {installedCount}
        </Button>
        <Button
          variant="contained"
          size="small"
          startIcon={<AddCircleOutlineIcon />}
          onClick={() => fileInputRef.current?.click()}
          sx={{ textTransform: "none" }}
        >
          添加技能
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md"
          style={{ display: "none" }}
          onChange={handleFileSelect}
        />
      </Box>

      {/* 分类标签 */}
      <Tabs
        value={category}
        onChange={(_, v) => setCategory(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 2, minHeight: 36 }}
      >
        {categories.map((c) => (
          <Tab
            key={c}
            value={c}
            label={c}
            sx={{ textTransform: "none", minHeight: 36, fontSize: 13 }}
          />
        ))}
      </Tabs>

      {/* 技能网格 */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 2,
          alignItems: "flex-start",
        }}
      >
        {filteredAll.map((s) => (
          <SkillCard
            key={s.id}
            skill={s}
            view="market"
            onToggle={toggleSkill}
            onDelete={setToDelete}
            onInstalled={handleInstalled}
          />
        ))}
      </Box>

      {filteredAll.length === 0 && (
        <Box sx={{ textAlign: "center", py: 8, color: "text.secondary" }}>
          <Typography>
            {q.trim()
              ? "未找到匹配的技能"
              : category !== "全部"
                ? `「${category}」分类下暂无可安装的技能`
                : "已安装全部技能，暂无可安装的技能"}
          </Typography>
        </Box>
      )}

      </>
      )}
      <ConfirmDialog
        open={!!toDelete}
        title="删除技能"
        message={`确认删除本地技能「${toDelete?.name}」？此操作不可撤销。`}
        danger
        confirmText="删除"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) removeSkill(toDelete.id);
          setToDelete(null);
        }}
      />
    </Box>
  );
}
