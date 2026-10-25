import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Chip, LinearProgress, Typography } from '@mui/material';
import { SettingsCard } from '@/components/settings/SettingsPrimitives';
import { toast } from '@/components/Toast';
import { RELEASES_URL, UPDATE_UNSIGNED_HINT } from '@/lib/core/constants';
import { platform } from '@/platform';
import type { UpdatePhase, UpdateStatus } from '@/types/update';

/**
 * 自动更新卡片（B4-01，GitHub Releases）。
 *
 * ## 三条约束
 *
 * 1. **不谎报**：只有主进程明确给出 `up-to-date` 才显示「已是最新」。`unsupported`
 *    （Web / 未打包）与 `error`（签名拦截 / 404 / 断网）各自如实显示——把这两种
 *    说成「已是最新」，用户会永远升不上去且不知道该干什么。
 * 2. **报错原文照抄**：`message` 直接进等宽块。签名失败、仓库 404、网络不可达的
 *    修法完全不同，任何「友好化」都会把这三种情况揉成同一句废话。
 * 3. **未签名给退路**：卡片常驻一句「当前构建未签名」的说明 + 「打开发布页」。
 *    自动更新被系统拦截时，用户至少知道可以手动下载。
 */
const PHASE_META: Record<
  UpdatePhase,
  { label: string; color: 'default' | 'info' | 'success' | 'warning' | 'error' }
> = {
  unsupported: { label: '不适用', color: 'default' },
  idle: { label: '未检查', color: 'default' },
  checking: { label: '检查中', color: 'info' },
  available: { label: '有新版本', color: 'warning' },
  'up-to-date': { label: '已是最新', color: 'success' },
  downloading: { label: '下载中', color: 'info' },
  downloaded: { label: '待安装', color: 'warning' },
  error: { label: '失败', color: 'error' },
};

/** 等宽块：原始报错用（可横向滚，不折行改语义） */
const MONO_SX = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: 12,
  p: 1,
  borderRadius: 1,
  bgcolor: 'action.hover',
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
} as const;

export function UpdateCard() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    // 先取一次当前状态（打开设置时可能已经错过了挂载前的推送），再订阅后续变化。
    void platform
      .updaterGetStatus()
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => undefined);
    const off = platform.onUpdaterStatus((next) => setStatus(next));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = useCallback(async (action: () => Promise<UpdateStatus>) => {
    setBusy(true);
    try {
      setStatus(await action());
    } catch (err) {
      toast.error(`更新操作失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const phase: UpdatePhase = status?.phase ?? 'idle';
  const meta = PHASE_META[phase];
  const currentVersion = status?.currentVersion || '未知';
  const newVersion = status?.availableVersion;

  return (
    <SettingsCard
      title="自动更新"
      description="从 GitHub Releases 检查新版本；下载完成后重启应用生效。"
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 500 }}>
          当前版本 {currentVersion}
        </Typography>
        <Chip size="small" label={meta.label} color={meta.color} variant="outlined" />
      </Box>

      {phase === 'unsupported' ? (
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          当前环境不支持自动更新（Web 端或未打包的桌面端）。发布版可到 Releases 手动下载。
        </Typography>
      ) : null}

      {phase === 'available' ? (
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          发现新版本 {newVersion ?? ''}，点击「下载更新」。
        </Typography>
      ) : null}

      {phase === 'downloading' ? (
        <Box sx={{ my: 1 }}>
          <LinearProgress
            variant={status?.percent == null ? 'indeterminate' : 'determinate'}
            value={status?.percent ?? 0}
          />
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.5 }}>
            正在下载
            {status?.percent != null ? ` ${Math.round(status.percent)}%` : '…'}
          </Typography>
        </Box>
      ) : null}

      {phase === 'downloaded' ? (
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          新版本 {newVersion ?? ''} 已下载，点击「重启并安装」生效。
        </Typography>
      ) : null}

      {phase === 'error' && status?.message ? (
        <Typography component="pre" sx={MONO_SX}>
          {status.message}
        </Typography>
      ) : null}

      <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          disabled={
            busy ||
            phase === 'checking' ||
            phase === 'downloading' ||
            phase === 'unsupported'
          }
          onClick={() => void run(() => platform.updaterCheck())}
        >
          检查更新
        </Button>

        {phase === 'available' ? (
          <Button
            variant="contained"
            disabled={busy}
            onClick={() => void run(() => platform.updaterDownload())}
          >
            下载更新
          </Button>
        ) : null}

        {phase === 'downloaded' ? (
          <Button
            variant="contained"
            disabled={busy}
            onClick={() => {
              void platform.updaterInstall().then((started) => {
                if (!started) toast.error('安装尚未就绪，请先下载更新');
              });
            }}
          >
            重启并安装
          </Button>
        ) : null}

        <Button variant="text" onClick={() => void platform.openUrl(RELEASES_URL)}>
          打开发布页
        </Button>
      </Box>

      {/* 未签名是**当前构建的事实**，不是错误状态的附属品：常驻说明，避免用户在
          更新被系统拦截时误以为功能坏了。 */}
      <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 1.5 }}>
        {UPDATE_UNSIGNED_HINT}
      </Typography>
    </SettingsCard>
  );
}
