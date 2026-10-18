import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import ExtensionOutlinedIcon from "@mui/icons-material/ExtensionOutlined";
import { usePluginsStore } from "@/stores/pluginsStore";
import { useSessionsStore } from "@/stores/sessionsStore";
import { useAgentsStore } from "@/stores/agentsStore";
import { collectMissingSessionPluginRefs } from "@/lib/sessionPluginRefs";
import { SessionPluginRefNotice } from "./SessionPluginRefNotice";
import { computePluginToolGaps } from "@/lib/pluginToolGaps";
import { platform } from "@/platform";
import { toast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PLUGIN_DRIFT_NOTICE, describePluginSource } from "@/lib/pluginIntent";
import {
  cardChipOutlinedSx,
  cardStatusChipSx,
  clampLines,
  hoverCardSx,
  iconTileSx,
} from "@/lib/cardSx";
import { PluginMarketSection } from "./PluginMarketSection";
import type { PluginView } from "@/types/plugin";

/**
 * 插件页（FR-3.4）。
 *
 * ## 界面要表达的三件事，刻意不合并成一个开关
 *
 * 一张卡片上同时显示**装了什么**（包）、**引擎激活没有**（事实）、
 * **本地想不想启用**（意图）。三者不一致时（`PluginDrift !== 'in-sync'`）
 * 卡片上出现一条说明——这正是本页存在的理由：插件激活标记与包内容
 * **指纹绑定**，改了包内容引擎就会拒绝沿用旧标记，于是「明明启用了却没用」
 * 是最常见的状态，而不是异常。把它显示出来，比事后猜要省事得多。
 *
 * ## 引擎问不到不算错误
 *
 * 网关没起是常态（用户可以不跑引擎只看包装了什么）。此时卡片的状态显示为
 * 「未知」并在页头给一条说明，而不是弹一排错误。
 */

/** 引擎激活状态 → 芯片文案与配色（未知刻意用灰色，不写成「未启用」——那是两件事） */
const ACTIVATION_CHIP: Record<
  PluginView["activation"],
  { label: string; color: "success" | "default" | "warning" }
> = {
  active: { label: "引擎已激活", color: "success" },
  inactive: { label: "引擎未激活", color: "default" },
  unknown: { label: "状态未知", color: "warning" },
};

/**
 * @param embedded 嵌入设置弹窗时传 true：去掉外层页面内边距、`maxWidth` 与大标题。
 *   页头的统计数字与「重新扫描 / 安装插件」按钮**两种宿主下都保留**——它们是这一块
 *   的操作入口，不是页面装饰。
 */
export function PluginsPage({ embedded = false }: { embedded?: boolean }) {
  const installed = usePluginsStore((s) => s.installed);
  const skipped = usePluginsStore((s) => s.skipped);
  const pluginsRoot = usePluginsStore((s) => s.pluginsRoot);
  const engine = usePluginsStore((s) => s.engine);
  const loaded = usePluginsStore((s) => s.loaded);
  const refreshing = usePluginsStore((s) => s.refreshing);
  const error = usePluginsStore((s) => s.error);
  const notice = usePluginsStore((s) => s.notice);
  const refresh = usePluginsStore((s) => s.refresh);
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  const installPlugin = usePluginsStore((s) => s.install);
  const uninstallPlugin = usePluginsStore((s) => s.uninstall);
  const clearFeedback = usePluginsStore((s) => s.clearFeedback);
  // 会话引用集（FR-3.9 ①）。直接订阅 sessions 本体：选择器里做 `.map` 会每次
  // 返回新数组，订阅反而更频繁；把投影放进 useMemo 才是这里要的。
  const sessions = useSessionsStore((s) => s.sessions);

  /** 「会话当初用的那一版，本机没有」——缺了才提示，纯对账、无副作用。 */
  const missingSessionRefs = useMemo(
    () =>
      collectMissingSessionPluginRefs(
        sessions.map((x) => ({
          id: x.id,
          title: x.title,
          pluginVersions: x.pluginVersions,
        })),
        installed,
      ),
    [sessions, installed],
  );

  // 当前 Agent（决定「声明工具是否被收窄」的基线）：优先用全局激活的 Agent，
  // 回落到内置通用助手。插件列表是全局配置页，没有会话上下文，所以用
  // 「用户当前选中的 Agent」作为基线——与引擎每轮按会话 Agent 算 policy_gaps 同源。
  const agents = useAgentsStore((s) => s.agents);
  const activeAgentId = useAgentsStore((s) => s.activeAgentId);
  const activeAgent = useMemo(() => {
    if (activeAgentId) {
      const hit = agents.find((a) => a.id === activeAgentId);
      if (hit) return hit;
    }
    return (
      agents.find((a) => a.id === "builtin:general") ?? agents[0] ?? null
    );
  }, [agents, activeAgentId]);

  const [busyName, setBusyName] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  /** 待卸载的插件（非空即打开确认框） */
  const [pendingRemoval, setPendingRemoval] = useState<PluginView | null>(null);

  // 进页面才扫：扫描要读盘、查引擎要发 HTTP，绝大多数会话根本不看这一页
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (notice) {
      toast.success(notice);
      clearFeedback();
    }
  }, [notice, clearFeedback]);

  useEffect(() => {
    if (error) {
      toast.error(error);
      clearFeedback();
    }
  }, [error, clearFeedback]);

  const counts = useMemo(() => {
    const active = installed.filter((v) => v.activation === "active").length;
    const drifted = installed.filter(
      (v) => v.drift === "intent-only" || v.drift === "engine-only",
    ).length;
    return { total: installed.length, active, drifted };
  }, [installed]);

  /** 从本地目录安装：先选目录，再把整包复制进插件根 */
  const handleInstall = async () => {
    const sourceDir = await platform.pickDirectory();
    if (!sourceDir) return;
    setInstalling(true);
    const result = await installPlugin(sourceDir);
    setInstalling(false);
    // 失败原因由 store 的 error 位统一 toast，这里只处理「已装过」的分支
    if (!result.ok && result.errorKind === "already-installed") {
      toast.error(result.error ?? "该插件已安装");
    }
  };

  const handleToggle = async (view: PluginView, next: boolean) => {
    const name = view.plugin.manifest.name;
    setBusyName(name);
    await setEnabled(name, next);
    setBusyName(null);
  };

  const confirmRemoval = async () => {
    if (!pendingRemoval) return;
    const name = pendingRemoval.plugin.manifest.name;
    setPendingRemoval(null);
    setBusyName(name);
    await uninstallPlugin(name);
    setBusyName(null);
  };

  return (
    <Box sx={embedded ? undefined : { p: 3, maxWidth: 1000, margin: "0 auto" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          mb: 2,
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        {!embedded && (
          <Typography variant="h5" fontWeight={700}>
            插件
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary">
          已安装 {counts.total} · 引擎已激活 {counts.active}
          {counts.drifted > 0 ? ` · ${counts.drifted} 项状态不一致` : ""}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="重新扫描插件目录，并再问一次引擎的激活状态">
          <span>
            <Button
              variant="outlined"
              startIcon={
                refreshing ? <CircularProgress size={16} /> : <RefreshIcon />
              }
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              重新扫描
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="选择一个插件包目录（含 plugin.json），整包含装进插件目录">
          <span>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => void handleInstall()}
              disabled={installing || platform.env !== "electron"}
            >
              {installing ? "安装中…" : "安装插件"}
            </Button>
          </span>
        </Tooltip>
      </Box>

      {platform.env !== "electron" && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Web 端没有本地插件目录，只能查看；安装 / 卸载 / 启停请使用桌面端。
        </Alert>
      )}

      {!engine.available && loaded && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          读不到引擎的激活状态（{engine.error ?? "原因未知"}）。 下面显示的是
          <strong>磁盘上的包</strong>，激活状态一律标为「未知」。
        </Alert>
      )}

      {skipped.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          插件目录下有 {skipped.length} 个目录无法解析（缺少或不合规的
          `plugin.json`），已跳过：{skipped.join("、")}
        </Alert>
      )}

      {/* 会话引用了本机没有的插件版本（FR-3.9 ①）。 */}
      <SessionPluginRefNotice rows={missingSessionRefs} />

      {loaded && installed.length === 0 && (
        <Box
          sx={{
            ...hoverCardSx,
            p: 4,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 1,
            textAlign: "center",
          }}
        >
          <ExtensionOutlinedIcon
            sx={{ fontSize: 36, color: "text.disabled" }}
          />
          <Typography color="text.secondary">还没有安装任何插件包。</Typography>
          {pluginsRoot && (
            <Typography variant="caption" color="text.disabled">
              插件目录：{pluginsRoot}
            </Typography>
          )}
        </Box>
      )}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
          gap: 2,
          alignItems: "stretch",
        }}
      >
        {installed.map((view) => {
          const { manifest } = view.plugin;
          const driftNotice = PLUGIN_DRIFT_NOTICE[view.drift];
          const activation = ACTIVATION_CHIP[view.activation];
          const busy = busyName === manifest.name;
          // 声明工具被当前 Agent 白名单收窄的落差（FR-3.12 纪律③ 的前端镜像）。
          // activeAgent 为 null（agents 还没加载）时退化为「不算落差」，不误报。
          const toolGaps = activeAgent
            ? computePluginToolGaps(
                manifest.permissions.tools,
                activeAgent.toolAllow,
                activeAgent.toolDeny,
              )
            : [];
          const totalResources = view.plugin.resources.filter(
            (g) => g.count > 0,
          );

          return (
            <Box
              key={manifest.name}
              sx={{
                ...hoverCardSx,
                p: 2,
                display: "flex",
                flexDirection: "column",
                gap: 1.25,
              }}
            >
              <Box
                sx={{ display: "flex", alignItems: "flex-start", gap: 1.25 }}
              >
                {manifest.logo ? (
                  <Box
                    component="img"
                    src={manifest.logo}
                    alt=""
                    sx={{
                      width: 36,
                      height: 36,
                      flexShrink: 0,
                      borderRadius: "10px",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  <Box sx={iconTileSx(manifest.name)}>
                    <ExtensionOutlinedIcon sx={{ fontSize: 20 }} />
                  </Box>
                )}

                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography
                    fontWeight={600}
                    sx={{ ...clampLines(1), wordBreak: "break-all" }}
                  >
                    {manifest.displayName}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ...clampLines(1), wordBreak: "break-all" }}
                  >
                    {manifest.name}
                    {manifest.versionDeclared
                      ? ` · v${manifest.version}`
                      : " · 未声明版本"}
                  </Typography>
                </Box>

                <Tooltip
                  title={
                    view.intended
                      ? "停用（关闭引擎侧激活）"
                      : "启用（写入引擎激活标记）"
                  }
                >
                  <span>
                    <Switch
                      size="small"
                      checked={view.intended}
                      disabled={busy || platform.env !== "electron"}
                      onChange={(e) =>
                        void handleToggle(view, e.target.checked)
                      }
                      inputProps={{
                        "aria-label": `启用 ${manifest.displayName}`,
                      }}
                    />
                  </span>
                </Tooltip>
              </Box>

              {manifest.description && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={clampLines(2)}
                >
                  {manifest.description}
                </Typography>
              )}

              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                <Chip
                  size="small"
                  label={manifest.category}
                  sx={cardChipOutlinedSx}
                />
                {/* 来源与生效版本：市场版插件换版本后「谁在跑哪一版」全靠它解释 */}
                <Chip
                  size="small"
                  variant="outlined"
                  label={describePluginSource(view.source)}
                  sx={cardChipOutlinedSx}
                />
                <Chip
                  size="small"
                  color={activation.color}
                  variant={view.activation === "active" ? "filled" : "outlined"}
                  label={activation.label}
                  sx={cardStatusChipSx}
                />
                {manifest.engineRange && (
                  <Chip
                    size="small"
                    color={view.engineIncompatible ? "error" : "default"}
                    variant="outlined"
                    label={
                      view.engineIncompatible
                        ? `要求 nanowork ${manifest.engineRange}`
                        : `兼容 ${manifest.engineRange}`
                    }
                    sx={cardStatusChipSx}
                  />
                )}
                {toolGaps.length > 0 && (
                  <Tooltip
                    title={
                      <Box sx={{ maxWidth: 320 }}>
                        <Typography variant="caption" fontWeight={600}>
                          以下声明工具被
                          {activeAgent ? `「${activeAgent.name}」` : "当前 Agent"}
                          的工具白名单收窄（不会生效）：
                        </Typography>
                        <Box
                          component="ul"
                          sx={{ m: 0.5, pl: 2, fontSize: 12 }}
                        >
                          {toolGaps.map((g) => (
                            <li key={g.tool}>
                              {g.tool}
                              {g.reason === "denied"
                                ? "（命中工具黑名单）"
                                : "（不在白名单内）"}
                            </li>
                          ))}
                        </Box>
                        <Typography variant="caption" color="text.secondary">
                          声明只收窄能力、不提权；如需生效，放宽该 Agent 的工具白名单。
                        </Typography>
                      </Box>
                    }
                  >
                    <Chip
                      size="small"
                      color="warning"
                      variant="outlined"
                      label={`${toolGaps.length} 项工具被收窄`}
                      sx={cardStatusChipSx}
                    />
                  </Tooltip>
                )}
              </Stack>

              {driftNotice && (
                <Alert
                  severity="info"
                  sx={{ py: 0.25, "& .MuiAlert-message": { fontSize: 12.5 } }}
                >
                  {driftNotice}
                </Alert>
              )}

              {view.engineIncompatible && (
                <Alert
                  severity="warning"
                  sx={{ py: 0.25, "& .MuiAlert-message": { fontSize: 12.5 } }}
                >
                  当前版本不满足该包声明的引擎区间，可能无法正常工作。
                </Alert>
              )}

              {totalResources.length > 0 && (
                <Stack
                  direction="row"
                  spacing={0.75}
                  flexWrap="wrap"
                  useFlexGap
                >
                  {totalResources.map((group) => (
                    <Chip
                      key={group.id}
                      size="small"
                      variant="outlined"
                      label={`${group.label} ${group.count}`}
                      sx={cardChipOutlinedSx}
                    />
                  ))}
                </Stack>
              )}

              {(manifest.permissions.tools.length > 0 ||
                manifest.permissions.network.length > 0) && (
                <Typography variant="caption" color="text.secondary">
                  声明权限：
                  {manifest.permissions.tools.length > 0 &&
                    `工具 ${manifest.permissions.tools.join(" / ")}`}
                  {manifest.permissions.tools.length > 0 &&
                    manifest.permissions.network.length > 0 &&
                    " · "}
                  {manifest.permissions.network.length > 0 &&
                    `网络 ${manifest.permissions.network.join(" / ")}`}
                </Typography>
              )}

              <Box sx={{ flex: 1 }} />
              <Divider flexItem />

              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Typography
                  variant="caption"
                  color="text.disabled"
                  sx={{ flex: 1, ...clampLines(1), wordBreak: "break-all" }}
                >
                  {view.plugin.root}
                </Typography>
                <Tooltip title="在文件管理器中打开插件目录">
                  <IconButton
                    size="small"
                    aria-label={`打开 ${manifest.name} 目录`}
                    onClick={() => void platform.openPath(view.plugin.root)}
                  >
                    <FolderOpenIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="卸载（删除包目录，不可撤销）">
                  <span>
                    <IconButton
                      size="small"
                      aria-label={`卸载 ${manifest.name}`}
                      disabled={busy || platform.env !== "electron"}
                      onClick={() => setPendingRemoval(view)}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            </Box>
          );
        })}
      </Box>

      <PluginMarketSection />

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="卸载插件"
        message={
          pendingRemoval
            ? `将删除插件包「${pendingRemoval.plugin.manifest.displayName}」的整个目录（${
                pendingRemoval.plugin.root
              }），该操作不可撤销。${
                pendingRemoval.intended ? "本地启用记录也会一并清除。" : ""
              }`
            : ""
        }
        confirmText="卸载"
        danger
        onConfirm={() => void confirmRemoval()}
        onCancel={() => setPendingRemoval(null)}
      />
    </Box>
  );
}
