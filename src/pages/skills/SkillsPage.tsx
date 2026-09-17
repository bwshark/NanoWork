import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { useSkillsStore } from "@/stores/skillsStore";
import { useSessionsStore } from "@/stores/sessionsStore";
import { toast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { parseSkillFromMarkdown } from "@/lib/skillParser";
import { platform } from "@/platform";
import { SkillMarketCard } from "@/components/skills/SkillMarketCard";
import { SkillInstalledCard } from "@/components/skills/SkillInstalledCard";
import { SkillDetailDialog } from "@/components/skills/SkillDetailDialog";
import {
  skillCategorySx,
  skillCountBadgeSx,
  skillGridSx,
  skillSearchSx,
  skillTopBarButtonSx,
} from "@/components/skills/skillCardSx";
import { SKILL_OVERRIDE_OFF, SKILL_OVERRIDE_ON } from "@/lib/skillOverrides";
import type { Skill, SkillOverride } from "@/types";

/** 安装反馈时长：给「点了有反应」留一个可见的节奏，不做假进度条 */
const INSTALL_FEEDBACK_MS = 800;

/**
 * 技能市场页（FR-003 / FR-3.1）：搜索、分类筛选、三态启停、本地安装。
 *
 * 两个视图的分工（参考样式把它们的差别做得很明确）：
 * - 「全部技能」是一张**目录**：整卡可点开详情，hover 展开描述，右上角是安装；
 * - 「我安装的」是一份**开关面板**：卡片常驻，右侧开关直接控制自动触发，
 *   hover 才露出 ⋯ 菜单与「仅手动调用」，停用后卡片压暗但不消失。
 *
 * 后者的关键差别是「停用不等于卸载」：技能还在磁盘上，用户必须能原地再打开它。
 * 因此「我安装的」列表直接取 store 全量，而不是按 `enabled` 过滤 ——
 * 一关开关就从列表里消失，会让「停用」看起来像「卸载」。
 */
export function SkillsPage() {
  const skills = useSkillsStore((s) => s.skills);
  const setSkillOverride = useSkillsStore((s) => s.setSkillOverride);
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
   * 用户可能在本会话中新增/删除本地 .md 文件，重入页面时需要把最新目录反映上来。
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
  /** 视图模式：「all」走全量市场；「installed」是已安装的开关面板 */
  const [view, setView] = useState<"all" | "installed">("all");
  /** 「我安装的」视图内的检索关键字（与 AllView 的 q 独立，互不影响） */
  const [installedQuery, setInstalledQuery] = useState("");
  const [toDelete, setToDelete] = useState<Skill | null>(null);
  /** 详情弹窗只记 id：技能状态在弹窗打开期间会被安装/停用改动，直接存对象会显示旧状态 */
  const [detailId, setDetailId] = useState<string | null>(null);
  /** 安装反馈中的技能 id（由页面统一调度，卡片不持有定时器） */
  const [installingIds, setInstallingIds] = useState<ReadonlySet<string>>(() => new Set());
  /** 批量管理模式：整卡改为勾选 */
  const [bulk, setBulk] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const installTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // 卸载时清掉未完成的安装定时器，避免对已卸载组件 setState
  useEffect(() => {
    const timers = installTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  /**
   * 本次会话刚安装的技能 id 集合：安装完成后市场页保留展示（⋯ ✓ 态），
   * 离开市场页后组件卸载、state 丢失，再次进入即不再展示已安装技能。
   */
  const [freshInstalledIds, setFreshInstalledIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  /**
   * 安装 = 把这个技能从 `off` 提到 `on`。
   *
   * 市场里的技能**本来就在 store 里**（扫描/内置的结果，只是被停用），
   * 所以这里不需要往列表里插一条新记录——那会制造出同一技能的两条数据。
   * 走 `setSkillOverride` 而不是直接改本地 state：引擎侧的覆盖表要一起更新，
   * 否则界面显示"已安装"而模型仍然看不到它。
   */
  const handleInstall = (skill: Skill) => {
    if (installTimers.current.has(skill.id)) return;
    setInstallingIds((prev) => new Set(prev).add(skill.id));
    const timer = setTimeout(() => {
      installTimers.current.delete(skill.id);
      setInstallingIds((prev) => {
        const next = new Set(prev);
        next.delete(skill.id);
        return next;
      });
      setSkillOverride(skill.id, SKILL_OVERRIDE_ON);
      setFreshInstalledIds((prev) => new Set(prev).add(skill.id));
      toast.success(`已安装技能：${skill.name}`);
    }, INSTALL_FEEDBACK_MS);
    installTimers.current.set(skill.id, timer);
  };

  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const applyBulk = (override: SkillOverride) => {
    if (selectedIds.size === 0) return;
    selectedIds.forEach((id) => setSkillOverride(id, override));
    toast.success(
      `已${override === SKILL_OVERRIDE_OFF ? "停用" : "启用"} ${selectedIds.size} 个技能`,
    );
    setSelectedIds(new Set());
    setBulk(false);
  };

  /**
   * 市场视图列表池：全部未启用技能 + 本次会话刚安装的技能（保留 ✓⋯ 态）。
   * 已启用的技能不再往市场里塞一份，避免同一技能两个入口并存。
   */
  const marketPool = useMemo(
    () => skills.filter((s) => !s.enabled || freshInstalledIds.has(s.id)),
    [skills, freshInstalledIds],
  );

  const categories = useMemo(() => {
    const set = new Set(marketPool.map((s) => s.category));
    return ["全部", ...Array.from(set)];
  }, [marketPool]);

  /**
   * 「我安装的」列表池就是 **store 里的全部技能**。
   *
   * 它是一份开关面板，不是结果列表 —— 开关管的是「要不要自动触发」，
   * 不是「在不在本地」。所以停用后卡片留在原地（整体压暗、开关变灰），
   * 用户能直接把它再打开；一关开关就蒸发掉会让「停用」看起来像「卸载」。
   */
  const installedCount = skills.length;

  /** AllView 过滤：市场池 + 分类筛选 + 关键字检索（q） */
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

  /** InstalledView 过滤：全部技能 + installedQuery 关键字检索 */
  const filteredInstalled = useMemo(() => {
    let list = skills;
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
   * 避免分类胶囊收到不在选项中的值（不高亮任何一项，看起来像坏了）。
   */
  useEffect(() => {
    if (category !== "全部" && !categories.includes(category)) {
      setCategory("全部");
    }
  }, [categories, category]);

  /** 详情弹窗取 store 里的实时对象：安装/停用后弹窗里的按钮与状态要立刻跟上 */
  const detailSkill = useMemo(() => {
    if (!detailId) return null;
    return skills.find((s) => s.id === detailId) ?? null;
  }, [detailId, skills]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    try {
      const text = await file.text();
      const skill = parseSkillFromMarkdown(text, file.name);
      useSkillsStore.getState().installSkill(skill);
      toast.success(`已安装技能：${skill.name}`);
    } catch (err) {
      toast.error(
        `安装失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    e.target.value = "";
  };

  const enterInstalled = () => {
    setView("installed");
    setBulk(false);
    setSelectedIds(new Set());
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
           * 「我安装的」视图：面包屑返回 + 大标题 + 工具栏 + 卡片网格。
           * 与「全部技能」共用图标与描述排版，差别在右侧是开关而不是安装按钮。
           */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5 }}>
            <IconButton onClick={() => setView("all")} size="small" aria-label="返回全部技能">
              <ArrowBackIcon fontSize="small" />
            </IconButton>
            <Typography variant="body2" color="text.secondary">
              全部技能
            </Typography>
          </Box>

          <Stack
            direction="row"
            alignItems="center"
            spacing={2}
            sx={{ mb: 2.5, flexWrap: "wrap" }}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="h6" fontWeight={700}>
                我安装的
              </Typography>
              <Box sx={skillCountBadgeSx}>{installedCount}</Box>
            </Stack>
            <Box sx={{ flex: 1 }} />
            <Button
              size="small"
              endIcon={<SettingsOutlinedIcon sx={{ fontSize: 17 }} />}
              onClick={() => {
                setBulk((b) => !b);
                setSelectedIds(new Set());
              }}
              sx={skillTopBarButtonSx}
            >
              {bulk ? "退出批量" : "批量管理"}
            </Button>
            <TextField
              size="small"
              placeholder="搜索已安装的技能"
              value={installedQuery}
              onChange={(e) => setInstalledQuery(e.target.value)}
              sx={skillSearchSx}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 18 }} />
                  </InputAdornment>
                ),
              }}
            />
          </Stack>

          {bulk && (
            <Stack
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{
                mb: 2,
                px: 1.5,
                py: 1,
                borderRadius: "10px",
                bgcolor: "action.hover",
              }}
            >
              <Typography variant="body2" color="text.secondary">
                已选 {selectedIds.size} 项
              </Typography>
              <Box sx={{ flex: 1 }} />
              <Button
                size="small"
                disabled={selectedIds.size === 0}
                onClick={() => applyBulk(SKILL_OVERRIDE_ON)}
                sx={{ textTransform: "none" }}
              >
                启用所选
              </Button>
              <Button
                size="small"
                disabled={selectedIds.size === 0}
                onClick={() => applyBulk(SKILL_OVERRIDE_OFF)}
                sx={{ textTransform: "none" }}
              >
                停用所选
              </Button>
            </Stack>
          )}

          <Box sx={skillGridSx}>
            {filteredInstalled.map((s) => (
              <SkillInstalledCard
                key={s.id}
                skill={s}
                selectable={bulk}
                selected={selectedIds.has(s.id)}
                onSelect={toggleSelected}
                onSetOverride={setSkillOverride}
                onUninstall={setToDelete}
                onOpenDetail={(sk) => setDetailId(sk.id)}
              />
            ))}
          </Box>

          {filteredInstalled.length === 0 && (
            <Box sx={{ textAlign: "center", py: 8, color: "text.secondary" }}>
              <Typography>
                {installedQuery.trim()
                  ? `未找到匹配「${installedQuery.trim()}」的已安装技能`
                  : "还没有安装任何技能"}
              </Typography>
            </Box>
          )}
        </>
      ) : (
        <>
          {/*
           * 标题行：技能市场 + spacer + 搜索 / 我安装的 / 添加技能。
           * flexWrap 在窄屏（< ~700px）下优雅换行，避免挤压。
           */}
          <Stack
            direction="row"
            alignItems="center"
            spacing={2}
            sx={{ mb: 2, flexWrap: "wrap" }}
          >
            <Typography variant="h6" fontWeight={700}>
              技能市场
            </Typography>
            <Box sx={{ flex: 1 }} />
            <TextField
              size="small"
              placeholder="搜索技能"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              sx={skillSearchSx}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 18 }} />
                  </InputAdornment>
                ),
              }}
            />
            <Button
              size="small"
              startIcon={<Inventory2OutlinedIcon sx={{ fontSize: 18 }} />}
              onClick={enterInstalled}
              sx={skillTopBarButtonSx}
            >
              我安装的 {installedCount}
            </Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<AddCircleOutlineIcon sx={{ fontSize: 18 }} />}
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
          </Stack>

          {/* 分类胶囊：换行平铺而不是横向滚动 —— 分类数量不大，滚动会把末几项藏起来 */}
          <Stack
            direction="row"
            spacing={0.5}
            sx={{ mb: 2, flexWrap: "wrap", rowGap: 0.5 }}
          >
            {categories.map((c) => (
              <Button key={c} onClick={() => setCategory(c)} sx={skillCategorySx(c === category)}>
                {c}
              </Button>
            ))}
          </Stack>

          <Box sx={skillGridSx}>
            {filteredAll.map((s) => (
              <SkillMarketCard
                key={s.id}
                skill={s}
                installing={installingIds.has(s.id)}
                onInstall={() => handleInstall(s)}
                onOpenDetail={(sk) => setDetailId(sk.id)}
                onSetOverride={setSkillOverride}
                onUninstall={setToDelete}
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

      <SkillDetailDialog
        skill={detailSkill}
        open={!!detailSkill}
        installing={!!detailSkill && installingIds.has(detailSkill.id)}
        onClose={() => setDetailId(null)}
        onInstall={handleInstall}
      />

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
