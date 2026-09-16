import { useRef, useState, useMemo, useEffect } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  InputAdornment,
  Menu,
  MenuItem,
  Select,
  Tab,
  Tabs,
  TextField,
  Tooltip,
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
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { useSkillsStore } from "@/stores/skillsStore";
import { useSessionsStore } from "@/stores/sessionsStore";
import { toast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { parseSkillFromMarkdown } from "@/lib/skillParser";
import {
  SKILL_OVERRIDE_META,
  SKILL_OVERRIDES,
  resolveSkillOverride,
} from "@/lib/skillOverrides";
import { platform } from "@/platform";
import { clampLines, hoverCardSx, iconTileSx } from "@/lib/cardSx";
import type { Skill, SkillOverride, SkillScope } from "@/types";

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

/** 来源层级徽标文案（PRD §12.4 的发现顺序） */
const SCOPE_LABEL: Record<SkillScope, string> = {
  builtin: '内置',
  user: '用户级',
  project: '项目级',
};

/**
 * 能否从列表里删掉这个技能。
 *
 * 内置技能随应用发布，删了下次启动就回来；项目级技能来自
 * `<workspace>/skills` 目录、每进一次页面就重扫一遍，从列表里抹掉同样会「复活」。
 * 两者的真实删除动作都不在界面上（前者改代码，后者删文件），
 * 所以不给删除入口 —— 与 `skillsStore.isUserOwnedSkill` 的判据保持一致。
 */
function canDelete(skill: Skill): boolean {
  return skill.source !== 'builtin' && skill.scope !== 'project';
}

/**
 * 三态覆盖控件（FR-3.1）。
 *
 * 用 Select 而不是 Switch：这三档不是「开 / 关」的二元关系，
 * `user-invocable-only`（用户能唤起、模型看不见）用开关表达不出来，
 * 硬塞成开关会让用户以为只有两种状态。
 */
function SkillStateControl({
  skill,
  disabled,
  onSetOverride,
}: {
  skill: Skill;
  disabled?: boolean;
  onSetOverride: (id: string, override: SkillOverride) => void;
}) {
  const override = resolveSkillOverride(skill);
  const meta = SKILL_OVERRIDE_META[override];
  return (
    <Tooltip title={meta.description}>
      <Select
        size="small"
        variant="outlined"
        value={override}
        disabled={disabled}
        onChange={(e) => onSetOverride(skill.id, e.target.value as SkillOverride)}
        aria-label={`${skill.name} 生效方式`}
        sx={{
          minWidth: 104,
          fontSize: 12.5,
          '& .MuiSelect-select': { py: 0.5 },
        }}
      >
        {SKILL_OVERRIDES.map((value) => (
          <MenuItem key={value} value={value} sx={{ fontSize: 13 }}>
            {SKILL_OVERRIDE_META[value].label}
          </MenuItem>
        ))}
      </Select>
    </Tooltip>
  );
}

/**
 * 技能卡片：「全部技能」与「我安装的」两个视图共用，右上角操作按视图区分：
 * - market（全部技能）三态：未安装「+」→ 安装中 loading → 已安装「✓ + ⋯ 菜单」；
 *   停用后恢复「+」外观，点击可重新启用。
 * - installed（我安装的）：始终为三态选择器，直接改生效档（停用后移出该视图）。
 */
function SkillCard({
  skill,
  view,
  onToggle,
  onDelete,
  onSetOverride,
  onInstalled,
}: {
  skill: Skill;
  /** 所处视图：market = 全部技能市场；installed = 我安装的列表 */
  view: "market" | "installed";
  onToggle: (id: string) => void;
  onDelete: (skill: Skill) => void;
  /** 三态覆盖入口（FR-3.1） */
  onSetOverride: (id: string, override: SkillOverride) => void;
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

  /** 右上角操作区：installed 视图为三态选择器；market 视图为三态按钮 */
  const renderAction = () => {
    if (view === "installed") {
      return (
        <>
          <SkillStateControl skill={skill} onSetOverride={onSetOverride} />
          {/*
           * 可删除的技能才给 ⋯ 菜单。内置技能删了下次启动就回来，
           * 项目级技能来自仓库目录、重进页面就重扫回来 —— 给入口只会误导。
           */}
          {canDelete(skill) && (
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
        {/*
         * 能力元信息行：来源层级 + SKILL.md 里声明的真实约束。
         * 全部取自已解析字段，不展示"推测出来的"能力 ——
         * 技能卡片上写一个它其实没有的权限，比不写更糟。
         */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 1.5, flexWrap: "wrap" }}>
          {skill.scope && (
            <Chip
              size="small"
              variant="outlined"
              label={SCOPE_LABEL[skill.scope]}
              sx={{ height: 20, fontSize: 11 }}
            />
          )}
          {skill.allowedTools && skill.allowedTools.length > 0 && (
            <Tooltip title={`工具白名单：${skill.allowedTools.join('、')}`}>
              <Chip
                size="small"
                variant="outlined"
                icon={<LockOutlinedIcon sx={{ fontSize: 13 }} />}
                label={`${skill.allowedTools.length} 个工具`}
                aria-label={`工具白名单：${skill.allowedTools.join('、')}`}
                sx={{ height: 20, fontSize: 11 }}
              />
            </Tooltip>
          )}
          {skill.userInvocable === false && (
            <Tooltip title="SKILL.md 声明 user-invocable: false，不会出现在用户的直接调用入口">
              <Chip
                size="small"
                variant="outlined"
                label="不可手动调用"
                sx={{ height: 20, fontSize: 11 }}
              />
            </Tooltip>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}

/** 技能市场页（FR-003 / FR-3.1）：搜索、分类筛选、三态启停、本地安装 */
export function SkillsPage() {
  const skills = useSkillsStore((s) => s.skills);
  const toggleSkill = useSkillsStore((s) => s.toggleSkill);
  const setSkillOverride = useSkillsStore((s) => s.setSkillOverride);
  const installSkill = useSkillsStore((s) => s.installSkill);
  const removeSkill = useSkillsStore((s) => s.removeSkill);
  const refresh = useSkillsStore((s) => s.refresh);
  const syncError = useSkillsStore((s) => s.syncError);

  /**
   * 当前工作区：项目级技能要从 `<workspace>/skills` 扫。
   * 取当前活跃会话的 workdir —— 技能页没有自己的"当前目录"概念，
   * 用户是从某个会话点进来的，那个会话的目录就是他要管理的项目。
   */
  const workspace = useSessionsStore(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.workdir,
  );

  /**
   * 每次进入技能市场页面都重新扫描本地目录并合并。
   * 不再依赖 `loaded` 守卫——手动「刷新本地」按钮已移除，
   * 但用户仍可能在本会话中新增/删除本地 .md 文件，
   * 重入页面时需要把最新目录反映上来。
   */
  useEffect(() => {
    void refresh(workspace);
  }, [refresh, workspace]);

  /**
   * 热加载（FR-3.1）：主进程对技能目录挂了 fs.watch，目录有变动就推事件过来。
   * 没有这条通道，「用外部编辑器改完 SKILL.md」必须手动切走再切回页面才能看到。
   */
  useEffect(() => {
    return platform.onSkillsChanged(() => {
      void refresh(workspace);
    });
  }, [refresh, workspace]);

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
      {/*
       * 覆盖同步失败必须显式可见：界面显示「已停用」而引擎照旧把它列给模型，
       * 是那种用户永远不会自己发现的不一致（PRD §12.4 的运行时启用状态只有在
       * 写进引擎配置后才是真的）。
       */}
      {syncError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          技能生效方式未能同步到引擎：{syncError}
          <br />
          当前界面上的选择已保存在本地；引擎侧仍按上一次成功同步的配置运行。
        </Alert>
      )}
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
            onSetOverride={setSkillOverride}
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
            onSetOverride={setSkillOverride}
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
