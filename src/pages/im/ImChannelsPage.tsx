import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import ReplayIcon from "@mui/icons-material/Replay";
import PersonIcon from "@mui/icons-material/Person";
import cowAvatar from "@/assets/cow-avatar.png";
import { CHANNEL_METAS } from "@/lib/channel/channelMeta";
import { useChannelsStore } from "@/stores/channelsStore";
import { ChannelIcon } from "@/components/im/ChannelIcon";
import { ChannelConfigDialog } from "@/components/im/ChannelConfigDialog";
import { toast } from "@/components/Toast";
import { platform } from "@/platform";
import type { ChannelRuntimeState } from "@/platform/types";
import type { ChannelKind, ChannelSyncStatus } from "@/types";

/** 同步状态 → 展示标签 */
const SYNC_LABEL: Record<ChannelSyncStatus, string> = {
  idle: "未同步",
  syncing: "同步中",
  synced: "已同步",
  error: "同步失败",
};

/**
 * IM 频道页（FR-010）。
 * 渠道卡片列表（钉钉/飞书/Lark/微信/企业微信）+ 配置弹窗 + 启停；
 * 配置保存 / 启停后自动同步进 nanobot（合并 config.json 并重启网关），
 * 无需手动点击同步。频道会话（任务）列表已移至侧边栏「任务 / 频道」Tab。
 *
 * @param embedded 嵌入设置弹窗时传 true：去掉外层滚动容器（弹窗右侧自带滚动）、
 *   内边距与 `maxWidth`，并把装饰用的 Hero 换成一段说明文字——Hero 是整页的
 *   「落地页」式开场（大插画 + 22px 标题），塞进设置分区会占掉半屏而只传达一句话。
 */
export function ImChannelsPage({ embedded = false }: { embedded?: boolean }) {
  const [configKind, setConfigKind] = useState<ChannelKind | null>(null);

  return (
    <Box sx={embedded ? undefined : { height: "100%", overflowY: "auto", pb: 4 }}>
      <ChannelsContent embedded={embedded} onConfigure={setConfigKind} />

      <ChannelConfigDialog
        open={configKind !== null}
        kind={configKind ?? "dingtalk"}
        onClose={() => setConfigKind(null)}
      />
    </Box>
  );
}

/** 频道内容：hero 装饰 + 渠道卡片列表（配置变更后自动同步到 nanobot） */
function ChannelsContent({
  embedded = false,
  onConfigure,
}: {
  embedded?: boolean;
  onConfigure: (k: ChannelKind) => void;
}) {
  const configs = useChannelsStore((s) => s.configs);
  const setEnabled = useChannelsStore((s) => s.setEnabled);
  const disconnectChannel = useChannelsStore((s) => s.disconnectChannel);
  const lastSync = useChannelsStore((s) => s.lastSync);
  const secretKeys = useChannelsStore((s) => s.secretKeys);
  const syncing = configs.some((c) => c.syncStatus === "syncing");
  // FR-6.6：渠道实时健康
  const health = useChannelsStore((s) => s.health);
  const gatewayUp = useChannelsStore((s) => s.gatewayUp);
  const healthError = useChannelsStore((s) => s.healthError);
  const refreshHealth = useChannelsStore((s) => s.refreshHealth);
  const startHealthPolling = useChannelsStore((s) => s.startHealthPolling);
  const stopHealthPolling = useChannelsStore((s) => s.stopHealthPolling);
  const reconnectChannel = useChannelsStore((s) => s.reconnectChannel);

  // FR-6.6：挂载即启动 ~30s 健康轮询，卸载停止
  useEffect(() => {
    startHealthPolling();
    return () => stopHealthPolling();
  }, [startHealthPolling, stopHealthPolling]);

  // 已启用却掉线的渠道（failed / stopped）→ 顶部告警条
  const downChannels = configs.filter((c) => {
    if (!c.enabled) return false;
    const h = health[c.kind];
    return !!h && (h.state === "failed" || h.state === "stopped");
  });
  const showDownAlert = gatewayUp === true && downChannels.length > 0;

  // 断开连接确认弹窗状态（仅扫码渠道且已连接时才会打开）
  const [disconnectKind, setDisconnectKind] = useState<ChannelKind | null>(
    null,
  );
  const [disconnecting, setDisconnecting] = useState(false);

  /** 确认断开：主进程清凭证 + 重启网关 → 成功后清本地状态 */
  const handleConfirmDisconnect = async () => {
    if (!disconnectKind || disconnecting) return;
    const kind = disconnectKind;
    setDisconnecting(true);
    try {
      const result = await platform.disconnectChannel(kind);
      if (result.ok) {
        // 引擎侧已由主进程直写清除：本地只清状态，绝不触发自动同步回写
        disconnectChannel(kind);
        if (result.needsRestart) toast.warning(result.message);
        else toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      // 防御：正常路径主进程不抛异常（错误走 ok=false），IPC 层异常兜底提示
      toast.error(
        `断开连接失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setDisconnecting(false);
      setDisconnectKind(null);
    }
  };

  // 自动同步结果反馈：仅在结果变化时提示一次，避免重复打扰；
  // 幂等校准（changed=false）静默处理，不打扰用户
  const lastSyncNotifiedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!lastSync || lastSyncNotifiedAt.current === lastSync.at) return;
    lastSyncNotifiedAt.current = lastSync.at;
    if (!lastSync.ok) {
      toast.error(lastSync.message);
    } else if (lastSync.needsRestart) {
      toast.warning(lastSync.message);
    } else if (lastSync.changed !== false) {
      toast.success(lastSync.message);
    }
  }, [lastSync]);

  return (
    <Box sx={embedded ? undefined : { maxWidth: 900, margin: "0 auto", px: 3 }}>
      {embedded ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mb: 2, lineHeight: 1.9 }}
        >
          配置 IM 频道，让智能体接收来自钉钉、飞书等平台的消息。频道配置信息仅存储在本地，不会上传到云端。
        </Typography>
      ) : (
        <Hero />
      )}

      {syncing && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mb: 1.5, textAlign: "right" }}
        >
          正在同步配置到 nanowork…
        </Typography>
      )}

      {/* FR-6.6：网关未运行 / 不可达 → 顶部错误条 */}
      {gatewayUp === false && (
        <Alert severity="error" sx={{ mb: 1.5 }}>
          网关未运行或不可达，无法获取渠道实时状态。
        </Alert>
      )}
      {/* FR-6.6：有已启用渠道掉线 → 顶部告警条 */}
      {showDownAlert && (
        <Alert
          severity="warning"
          sx={{ mb: 1.5, alignItems: "center" }}
        >
          <Typography component="span" variant="body2">
            以下已启用渠道已断开：
            {downChannels
              .map(
                (c) =>
                  CHANNEL_METAS.find((m) => m.kind === c.kind)?.name ?? c.kind,
              )
              .join("、")}
            。可点击对应卡片的「重新连接」。
          </Typography>
        </Alert>
      )}

      {CHANNEL_METAS.map((meta) => {
        const cfg = configs.find((c) => c.kind === meta.kind);
        /*
         * 「已连接」：扫码渠道 + 桌面端 + 有配置且启用 + 持有凭证。
         *
         * 凭据判据**必须纳入保险库**：密钥已不落 `channels.json`（见 channelsStore 的文件头），
         * 重启后微信的 `cfg.token` 是空的——只看配置就会把「已连接」判成「未连接」，
         * 卡片上的「断开连接」按钮随之消失，用户失去唯一的断开入口。
         */
        const hasCredential =
          (secretKeys[meta.kind]?.length ?? 0) > 0 ||
          (meta.kind === "weixin" ? !!cfg?.token : !!cfg?.appId);
        const connected = !!(
          meta.scanConnect &&
          platform.env === "electron" &&
          cfg &&
          cfg.enabled &&
          hasCredential
        );
        // FR-6.6：实时健康（仅网关在线时才有意义）
        const h = health[meta.kind];
        const healthState: ChannelRuntimeState =
          gatewayUp === true ? h?.state ?? "unknown" : "unknown";
        const down =
          gatewayUp === true &&
          !!cfg?.enabled &&
          !!h &&
          (h.state === "failed" || h.state === "stopped");
        return (
          <Card key={meta.kind} sx={{ mb: 1.5 }}>
            <CardContent
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                py: 1.75,
                "&:last-child": { pb: 1.75 },
              }}
            >
              <Box
                sx={{
                  width: 42,
                  height: 42,
                  borderRadius: 1.5,
                  bgcolor: "action.hover",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                <ChannelIcon kind={meta.kind} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  sx={{
                    fontSize: 14,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    gap: 0.75,
                  }}
                >
                  {meta.name}
                  {meta.scanConnect && platform.env === "electron" && (
                    <Box
                      component="span"
                      sx={{
                        fontSize: 11,
                        fontWeight: 500,
                        lineHeight: 1.4,
                        px: 0.75,
                        borderRadius: 1,
                        border: "1px solid",
                        // 深色保留亮绿观感，浅色用语义 token 保证对比度（与 Hero 气泡同范式）
                        borderColor: (t) =>
                          t.palette.mode === "dark"
                            ? "rgba(74,222,128,0.5)"
                            : "success.main",
                        color: (t) =>
                          t.palette.mode === "dark"
                            ? "#4ade80"
                            : "success.main",
                      }}
                    >
                      支持扫码
                    </Box>
                  )}
                </Typography>
                <Typography variant="body2" color="text.secondary" noWrap>
                  {meta.description}
                </Typography>
                {/* FR-6.6：掉线原因（failed 态优先展示） */}
                {h?.error && gatewayUp === true && (
                  <Typography
                    variant="caption"
                    color="error"
                    noWrap
                    sx={{ display: "block", mt: 0.25 }}
                  >
                    {h.error}
                  </Typography>
                )}
              </Box>

              {cfg ? (
                <>
                  <Tooltip
                    title={
                      cfg.lastSyncAt
                        ? `上次同步 ${new Date(cfg.lastSyncAt).toLocaleString()}`
                        : "尚未同步"
                    }
                  >
                    <span>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={
                          cfg.syncStatus === "synced"
                            ? "success"
                            : cfg.syncStatus === "error"
                              ? "error"
                              : "default"
                        }
                        label={SYNC_LABEL[cfg.syncStatus]}
                      />
                    </span>
                  </Tooltip>
                  {/* FR-6.6：实时健康徽标 */}
                  <ChannelHealthBadge state={healthState} />
                  <Tooltip title={cfg.enabled ? "停用" : "启用"}>
                    <span>
                      <Switch
                        checked={cfg.enabled}
                        onChange={(e) =>
                          setEnabled(meta.kind, e.target.checked)
                        }
                      />
                    </span>
                  </Tooltip>
                  {connected && (
                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      startIcon={<LinkOffIcon sx={{ fontSize: 15 }} />}
                      sx={{ fontSize: 12, flexShrink: 0 }}
                      onClick={() => setDisconnectKind(meta.kind)}
                    >
                      断开连接
                    </Button>
                  )}
                  {/* FR-6.6：掉线渠道「重新连接」（网关在线 + 已启用 + failed/stopped） */}
                  {down && (
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<ReplayIcon sx={{ fontSize: 15 }} />}
                      sx={{ fontSize: 12, flexShrink: 0 }}
                      onClick={() => void reconnectChannel(meta.kind)}
                    >
                      重新连接
                    </Button>
                  )}
                  <IconButton
                    size="small"
                    onClick={() => onConfigure(meta.kind)}
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                </>
              ) : (
                <Button
                  size="small"
                  variant="contained"
                  sx={{
                    bgcolor: "text.primary",
                    color: "background.default",
                    "&:hover": { bgcolor: "text.primary", opacity: 0.85 },
                  }}
                  onClick={() => onConfigure(meta.kind)}
                >
                  配置
                </Button>
              )}
            </CardContent>
          </Card>
        );
      })}

      {/* <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        频道配置仅存储在本地；保存或启停后会自动写入 nanobot config.json 并重启网关生效。
      </Typography> */}

      {/* 断开连接确认弹窗：断开后需重新扫码，策略配置（白名单等）保留 */}
      <Dialog
        open={disconnectKind !== null}
        onClose={() => !disconnecting && setDisconnectKind(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>
          {`断开${
            disconnectKind
              ? (CHANNEL_METAS.find((m) => m.kind === disconnectKind)?.name ??
                "")
              : ""
          }连接`}
        </DialogTitle>
        <DialogContent>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ lineHeight: 1.9 }}
          >
            断开后将清除本地连接凭证并停用该渠道，之后需要重新扫码才能恢复接入。
            <br />
            白名单等策略配置会保留，重新连接后自动沿用。
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            size="small"
            color="inherit"
            disabled={disconnecting}
            onClick={() => setDisconnectKind(null)}
          >
            取消
          </Button>
          <Button
            size="small"
            variant="contained"
            color="error"
            disabled={disconnecting}
            onClick={() => void handleConfirmDisconnect()}
          >
            {disconnecting ? "断开中…" : "确认断开"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

/** FR-6.6 渠道实时健康徽标 */
const CHANNEL_HEALTH_BADGE: Record<
  ChannelRuntimeState,
  { label: string; color: "success" | "info" | "error" | "warning" | "default" }
> = {
  running: { label: "在线", color: "success" },
  starting: { label: "连接中", color: "info" },
  failed: { label: "连接失败", color: "error" },
  stopped: { label: "已停止", color: "warning" },
  unknown: { label: "状态未知", color: "default" },
};

function ChannelHealthBadge({ state }: { state: ChannelRuntimeState }) {
  const badge = CHANNEL_HEALTH_BADGE[state];
  return (
    <Chip
      size="small"
      variant="outlined"
      color={badge.color}
      label={badge.label}
      sx={{ fontSize: 11, flexShrink: 0, height: 22 }}
    />
  );
}

/** 顶部装饰：对话气泡 + 双头像（还原设计稿 hero 区） */
function Hero() {
  return (
    <Box sx={{ py: 5, textAlign: "center" }}>
      {/* 气泡行 */}
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          alignItems: "flex-start",
          gap: 1,
        }}
      >
        <Box
          sx={{
            px: 1.5,
            py: 0.75,
            borderRadius: 2,
            bgcolor: "rgba(34,197,94,0.15)",
            // 深色保留原亮绿观感，浅色用语义 token 保证对比度
            color: (t) =>
              t.palette.mode === "dark" ? "#4ade80" : "success.main",
            fontSize: 12.5,
            fontWeight: 600,
            transform: "translateY(-4px)",
          }}
        >
          Done. Want it more formal?
        </Box>
        <Box
          sx={{
            px: 1.5,
            py: 0.75,
            borderRadius: 2,
            bgcolor: "action.hover",
            color: "text.secondary",
            fontSize: 12.5,
            fontWeight: 600,
            transform: "translateY(8px)",
          }}
        >
          Draft a friendly reply to customer
        </Box>
      </Box>

      {/* 头像行：nanobot 章鱼 + 用户 */}
      <Box sx={{ display: "flex", justifyContent: "center", mt: 1 }}>
        <Box
          sx={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            bgcolor: "rgba(34,197,94,0.18)",
            display: "grid",
            placeItems: "center",
            mr: -1,
            zIndex: 0,
          }}
        >
          <img
            src={cowAvatar}
            alt="nanowork"
            style={{ width: 30, height: 30, objectFit: "contain" }}
          />
        </Box>
        <Box
          sx={{
            width: 60,
            height: 60,
            borderRadius: "50%",
            bgcolor: "#e2e8f0",
            display: "grid",
            placeItems: "center",
            zIndex: 1,
            border: "2px solid",
            borderColor: "background.default",
          }}
        >
          <PersonIcon sx={{ color: "#64748b", fontSize: 30 }} />
        </Box>
      </Box>

      <Typography sx={{ mt: 3, fontSize: 22, fontWeight: 700 }}>
        助理设置
      </Typography>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 1, lineHeight: 1.9 }}
      >
        配置 IM 频道，让智能体接收来自钉钉、飞书等平台的消息。
        <br />
        频道配置信息仅存储在本地，不会上传到云端。
      </Typography>
    </Box>
  );
}
