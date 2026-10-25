import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import ExtensionOutlinedIcon from "@mui/icons-material/ExtensionOutlined";
import StorefrontOutlinedIcon from "@mui/icons-material/StorefrontOutlined";
import { usePluginsStore } from "@/stores/pluginsStore";
import { platform } from "@/platform";
import { toast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { marketVersionState } from "@/lib/agent/pluginIntent";
import { cardChipOutlinedSx, cardStatusChipSx, clampLines, hoverCardSx } from "@/lib/ui/cardSx";
import type {
  MarketIndex,
  MarketPackage,
  MarketplaceEntry,
  MarketplaceType,
} from "@/types/plugin";

/**
 * 插件市场区（FR-3.7 / FR-3.8）。
 *
 * ## 为什么「同步」和「安装」是两件事
 *
 * 同步只做**归档**：把市场源侧（本地目录）里合规的包按版本复制进
 * `marketplaces/<m>/<n>/<v>/`，源侧**只增不改**——升级不该动到已经归档的那一版，
 * 否则「回退到旧版」就再也找不回。安装才是把某一版 materialize 成 `cache/` 下的
 * 生效副本并拨动 `current` 指针。两件事混在一起，界面就只能回答「有没有新版」
 * 而答不了「现在跑的是哪一版」。
 *
 * ## 为什么切版本后不自动启用
 *
 * 引擎的激活标记是**包内容指纹**绑定的：换一版内容就变了，旧标记立刻失效。
 * 若安装顺手把启用也做了，「装了却没生效」会变成一次无痕的自我治愈，从此查不出原因。
 * 所以安装完一律停在「生效、待启用」，卡片上的引擎状态如实显示「未激活」。
 *
 * ## 目录型不联网
 *
 * `directory` 市场的源侧就是本机一个目录，同步不产生任何网络行为；`remote` 需要拉
 * zip，本轮服务端尚不支持，同步按钮**如实禁用**——禁用但给出原因，比点了报错、
 * 或者干脆不显示这个市场都诚实。
 */

/** 远程市场的同步禁用原因（能力缺口一次性说清，界面不再重复判定） */
const REMOTE_SYNC_DISABLED = "远程市场同步需要服务端支持，本轮不可用";

/** 市场 id 同时是 `marketplaces/` 下的目录名，先在这层挡掉明显非法的输入 */
const MARKET_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const EMPTY_FORM = { id: "", name: "", type: "directory" as MarketplaceType, location: "" };

/** 缓存回收的默认保留天数（主进程 keepDays=0 只看引用集，这里给个 sane 值） */
const GC_KEEP_DAYS = 30;

type SyncSeverity = "success" | "warning" | "neutral";

/** 市场的同步状态文案（上一次成功 / 上一次失败 / 从未同步） */
function marketSyncLabel(market: MarketplaceEntry): { text: string; severity: SyncSeverity } {
  if (market.lastError) return { text: `上次同步失败：${market.lastError}`, severity: "warning" };
  if (market.lastSyncAt === null) return { text: "尚未同步", severity: "neutral" };
  return {
    text: `上次同步 ${market.lastSyncAt.slice(0, 16).replace("T", " ")}`,
    severity: "success",
  };
}

/** 按包名归拢市场索引里的版本（保持索引里出现的顺序） */
function groupByPackage(packages: MarketPackage[]): { name: string; versions: MarketPackage[] }[] {
  const groups: { name: string; versions: MarketPackage[] }[] = [];
  for (const pkg of packages) {
    const found = groups.find((g) => g.name === pkg.name);
    if (found) found.versions.push(pkg);
    else groups.push({ name: pkg.name, versions: [pkg] });
  }
  return groups;
}

/** 当前生效版本按市场归拢：市场索引里的版本据此标「生效中 / 可更新 / 更旧」 */
function currentVersionByMarket(
  installed: { source: { market: string | null; version: string | null } }[],
): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const view of installed) {
    if (view.source.market === null) continue;
    map[view.source.market] = view.source.version;
  }
  return map;
}

/**
 * 展开市场时拉一次索引。
 *
 * 索引是磁盘上 `marketplaces/<id>/` 的目录清单（读一次盘），放在渲染期读会
 * 每次渲染都发一次 IPC，所以只在「展开」这个动作发生时拉。
 */
function useMarketIndex(id: string | null): { index: MarketIndex | undefined; loading: boolean } {
  const load = usePluginsStore((s) => s.loadMarketPackages);
  const index = usePluginsStore((s) => (id === null ? undefined : s.marketIndexes[id]));
  const loading = usePluginsStore((s) => (id === null ? false : s.loadingIndexes[id] === true));

  useEffect(() => {
    if (id === null) return;
    void load(id);
  }, [id, load]);

  return { index, loading };
}

export function PluginMarketSection() {
  const markets = usePluginsStore((s) => s.markets);
  const loadingMarkets = usePluginsStore((s) => s.loadingMarkets);
  const marketError = usePluginsStore((s) => s.marketError);
  const syncingMarket = usePluginsStore((s) => s.syncingMarket);
  const installingKey = usePluginsStore((s) => s.installingKey);
  const installed = usePluginsStore((s) => s.installed);
  const loadMarkets = usePluginsStore((s) => s.loadMarkets);
  const addMarket = usePluginsStore((s) => s.addMarket);
  const removeMarket = usePluginsStore((s) => s.removeMarket);
  const syncMarket = usePluginsStore((s) => s.syncMarket);
  const installFromMarket = usePluginsStore((s) => s.installFromMarket);
  const collectCache = usePluginsStore((s) => s.collectCache);

  /** 同一时刻只展开一个市场：两个并列会把卡片撑得读不清 */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<MarketplaceEntry | null>(null);
  const [gcBusy, setGcBusy] = useState(false);

  // 进市场区读一次注册表：注册表就是磁盘上的 registry.json，没有需要持久化的东西
  useEffect(() => {
    void loadMarkets();
  }, [loadMarkets]);

  const { index, loading } = useMarketIndex(expanded);
  const groups = useMemo(() => groupByPackage(index?.packages ?? []), [index]);
  const currentByMarket = useMemo(() => currentVersionByMarket(installed), [installed]);

  /** Web 端没有本地文件系统，市场写操作一律禁用（点了才报错更糟） */
  const unavailable = platform.env !== "electron";

  const handleAdd = async () => {
    const id = form.id.trim();
    if (!MARKET_ID_PATTERN.test(id)) {
      setFormError("市场 id 只能用字母、数字、点、下划线和短横");
      return;
    }
    if (form.location.trim() === "") {
      setFormError(form.type === "remote" ? "请填写下载地址" : "请填写本地目录");
      return;
    }
    setFormError(null);
    const ok = await addMarket({
      id,
      name: form.name.trim() || id,
      type: form.type,
      location: form.location.trim(),
      isBuiltIn: false,
      autoUpdate: false,
    });
    if (!ok) return;
    setAddOpen(false);
    setForm({ ...EMPTY_FORM });
  };

  const handleRemove = async () => {
    if (!pendingRemove) return;
    const id = pendingRemove.id;
    setPendingRemove(null);
    await removeMarket(id);
    if (expanded === id) setExpanded(null);
  };

  return (
    <Box sx={{ mt: 4 }}>
      <Divider sx={{ mb: 2 }} />
      <Box sx={{ display: "flex", alignItems: "center", mb: 1, gap: 2, flexWrap: "wrap" }}>
        <StorefrontOutlinedIcon sx={{ color: "text.secondary" }} />
        <Typography variant="h6" fontWeight={600}>
          插件市场
        </Typography>
        <Typography variant="body2" color="text.secondary">
          归档多个版本、按需切换生效版本；目录型市场不联网
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={`回收 ${GC_KEEP_DAYS} 天未使用且无会话在跑的旧副本（保留当前生效的那一份）`}>
          <span>
            <Button
              variant="outlined"
              disabled={gcBusy || unavailable}
              onClick={async () => {
                setGcBusy(true);
                try {
                  const result = await collectCache(GC_KEEP_DAYS);
                  toast.info(
                    result.removed.length > 0
                      ? `已回收 ${result.removed.length} 个旧副本，保留 ${result.kept.length} 个`
                      : `没有可回收的旧副本（保留 ${result.kept.length} 个）`,
                  );
                } finally {
                  setGcBusy(false);
                }
              }}
            >
              {gcBusy ? "回收中…" : "回收旧副本"}
            </Button>
          </span>
        </Tooltip>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          disabled={unavailable}
          onClick={() => setAddOpen(true)}
        >
          添加市场
        </Button>
      </Box>

      {unavailable && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Web 端没有本地文件系统，市场与版本切换请使用桌面端。
        </Alert>
      )}

      {marketError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          市场读写失败：{marketError}
        </Alert>
      )}

      {loadingMarkets && markets.length === 0 && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
          <CircularProgress size={22} />
        </Box>
      )}

      {!loadingMarkets && markets.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          还没有登记市场。可以指向本机一个插件目录，把里面的包按版本归档起来。
        </Typography>
      )}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))",
          gap: 2,
          alignItems: "stretch",
        }}
      >
        {markets.map((market) => {
          const sync = marketSyncLabel(market);
          const busy = syncingMarket === market.id;
          const open = expanded === market.id;

          return (
            <Box
              key={market.id}
              // 稳定的定位锚点：卡片按 CSS grid 排布，测试里按序号点按钮会点错卡
              data-market={market.id}
              sx={{ ...hoverCardSx, p: 2, display: "flex", flexDirection: "column", gap: 1.25 }}
            >
              <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography fontWeight={600} sx={{ ...clampLines(1), wordBreak: "break-all" }}>
                    {market.name}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ...clampLines(2), wordBreak: "break-all" }}
                  >
                    {market.location}
                  </Typography>
                </Box>
                <Tooltip
                  title={
                    market.isBuiltIn
                      ? "随应用分发，不可删除"
                      : "从这个注册表移除（已归档的副本与已安装的插件不受影响）"
                  }
                >
                  <span>
                    <IconButton
                      size="small"
                      aria-label={`删除市场 ${market.name}`}
                      disabled={market.isBuiltIn || unavailable}
                      onClick={() => setPendingRemove(market)}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>

              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                <Chip
                  size="small"
                  label={market.type === "directory" ? "目录型" : "远程"}
                  sx={cardChipOutlinedSx}
                />
                {market.isBuiltIn && <Chip size="small" label="内置" sx={cardChipOutlinedSx} />}
                <Chip
                  size="small"
                  variant="outlined"
                  color={
                    sync.severity === "warning" ? "warning" : sync.severity === "success" ? "success" : "default"
                  }
                  label={sync.text}
                  sx={cardStatusChipSx}
                />
              </Stack>

              <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                <Tooltip
                  title={
                    market.type === "remote"
                      ? REMOTE_SYNC_DISABLED
                      : "扫描并归档该市场里的包（不改动源目录）"
                  }
                >
                  <span>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={busy ? <CircularProgress size={14} /> : <RefreshIcon />}
                      disabled={busy || market.type === "remote" || unavailable}
                      onClick={async () => {
                        const outcome = await syncMarket(market.id);
                        if (outcome !== null && !outcome.ok) {
                          toast.error(outcome.error ?? `同步「${market.name}」失败`);
                        }
                      }}
                    >
                      {busy ? "同步中…" : "同步"}
                    </Button>
                  </span>
                </Tooltip>
                <Button
                  size="small"
                  variant={open ? "contained" : "outlined"}
                  startIcon={<ExtensionOutlinedIcon />}
                  onClick={() => setExpanded(open ? null : market.id)}
                >
                  {open ? "收起" : "浏览包"}
                </Button>
              </Box>

              {open && (
                <Box sx={{ borderTop: 1, borderColor: "divider", pt: 1.25 }}>
                  {loading ? (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
                      <CircularProgress size={20} />
                    </Box>
                  ) : groups.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      这个市场里还没有归档任何包，先点「同步」。
                    </Typography>
                  ) : (
                    <Stack spacing={1.5} sx={{ maxHeight: 320, overflowY: "auto" }}>
                      {groups.map((group) => {
                        const key = `${market.id}:${group.name}`;
                        const current = currentByMarket[market.id] ?? null;
                        return (
                          <Box key={group.name}>
                            <Typography variant="body2" fontWeight={600}>
                              {group.name}
                            </Typography>
                            {group.versions[0]?.description && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={clampLines(2)}
                              >
                                {group.versions[0].description}
                              </Typography>
                            )}
                            <Stack
                              direction="row"
                              spacing={0.75}
                              flexWrap="wrap"
                              useFlexGap
                              sx={{ mt: 0.5 }}
                            >
                              {group.versions.map((pkg) => {
                                const state = marketVersionState(pkg.version, current);
                                return (
                                  <Button
                                    key={pkg.version}
                                    size="small"
                                    variant={state === "current" ? "contained" : "outlined"}
                                    disabled={
                                      state === "current" ||
                                      busy ||
                                      unavailable ||
                                      (installingKey !== null && installingKey !== key)
                                    }
                                    onClick={() => {
                                      void installFromMarket(market.id, group.name, pkg.version);
                                    }}
                                  >
                                    v{pkg.version}
                                    {state === "current" ? "（生效中）" : state === "update" ? " 更新" : ""}
                                  </Button>
                                );
                              })}
                            </Stack>
                          </Box>
                        );
                      })}
                    </Stack>
                  )}
                  {index && index.skipped.length > 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
                      已跳过 {index.skipped.length} 个不合规目录：{index.skipped.join("、")}
                    </Typography>
                  )}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>添加市场</DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
          <TextField
            label="市场 id"
            value={form.id}
            onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
            helperText="同时是 marketplaces/ 下的目录名"
            fullWidth
          />
          <TextField
            label="显示名"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            helperText="留空则用 id"
            fullWidth
          />
          <TextField
            select
            label="类型"
            value={form.type}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                type: e.target.value === "remote" ? "remote" : "directory",
              }))
            }
            helperText="目录型指向本机目录、不联网；远程型本轮暂不支持同步"
            fullWidth
          >
            <MenuItem value="directory">目录型（本地目录）</MenuItem>
            <MenuItem value="remote">远程（下载地址）</MenuItem>
          </TextField>
          <TextField
            label={form.type === "remote" ? "下载地址" : "本地目录"}
            value={form.location}
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
            fullWidth
          />
          {formError && <Alert severity="error">{formError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>取消</Button>
          <Button variant="contained" onClick={() => void handleAdd()}>
            添加
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={pendingRemove !== null}
        title="删除市场"
        message={
          pendingRemove
            ? `将从注册表中移除「${pendingRemove.name}」，已归档的副本与已安装的插件不会被删除。`
            : ""
        }
        confirmText="删除"
        danger
        onConfirm={() => void handleRemove()}
        onCancel={() => setPendingRemove(null)}
      />
    </Box>
  );
}
