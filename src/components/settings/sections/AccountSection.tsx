import { useEffect, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { SyncStatusIndicator } from '@/components/SyncStatusBadge';
import { toast } from '@/components/Toast';
import { ROUTES } from '@/lib/constants';
import { platform } from '@/platform';
import { useSettingsUiStore } from '@/stores/settingsUiStore';
import { getSyncRuntime, useSyncStatus } from '@/sync';
import type { AccountSession } from '@/sync';

/**
 * 设置弹窗「账户」分区（批次 4，FR-10）。
 *
 * 只做三件事：展示登录态（邮箱 / 设备 ID / 上次同步 / 状态徽章）、未登录入口、
 * 登出。**不手调 `engine.stop()`**——登出经 `account.logout()` → `account.subscribe`
 * 已在 runtime 内触发 `engine.stop()` + `resetSyncStatus()`，手调会漏 reset 或重复。
 *
 * runtime 一律用 `getSyncRuntime()` 读取（不在这里 `initSyncRuntime`）：App 启动块
 * 已负责初始化单例；设置分区只消费，避免页面一多就各造一份 runtime。
 */

/** ISO 时间 → 本地可读串；无则占位。 */
function formatSyncedAt(iso: string | null): string {
  if (!iso) return '尚未同步';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toLocaleString();
}

export function AccountSection() {
  const navigate = useNavigate();
  const closeSettings = useSettingsUiStore((s) => s.closeSettings);
  const status = useSyncStatus();
  const runtime = getSyncRuntime();

  const [session, setSession] = useState<AccountSession | null>(
    () => runtime?.account.getSession() ?? null,
  );
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 账户变更（登录 / 登出 / 轮换）驱动本分区重渲染
  useEffect(() => {
    if (!runtime) return;
    setSession(runtime.account.getSession());
    return runtime.account.subscribe(() => {
      setSession(runtime.account.getSession());
    });
  }, [runtime]);

  // 设备 ID：Web 端 `platform.appInfo()` 恒为 null → 优雅降级为「仅桌面端可见」
  useEffect(() => {
    let cancelled = false;
    void platform
      .appInfo()
      .then((info) => {
        if (!cancelled) setDeviceId(info?.deviceId ?? null);
      })
      .catch(() => {
        if (!cancelled) setDeviceId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 未登录入口：先关弹窗再跳登录页（否则弹窗会压在登录页上）。 */
  const goAuth = (): void => {
    closeSettings();
    navigate(ROUTES.auth);
  };

  const logout = async (): Promise<void> => {
    if (!runtime || busy) return;
    setBusy(true);
    try {
      // 只调 logout：engine.stop() + resetSyncStatus() 由 account.subscribe 触发。
      await runtime.account.logout();
      toast.success('已退出登录');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <SettingsCard
        title="账户与同步"
        description="登录后可跨设备同步你的 Agent、会话与设置；不登录也能使用全部本地功能。"
      >
        {session ? (
          <>
            <SettingsRow
              label="邮箱"
              hint="当前登录账户"
              control={
                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                  {session.email}
                </Typography>
              }
            />
            <SettingsRow
              label="设备 ID"
              hint="本机标识，用于标记同步改动的来源"
              control={
                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                  {deviceId ?? '仅桌面端可见'}
                </Typography>
              }
            />
            <SettingsRow
              label="上次同步"
              hint="最近一次成功同步的时刻"
              control={
                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                  {formatSyncedAt(status.lastSyncedAt)}
                </Typography>
              }
            />
            <SettingsRow label="同步状态" control={<SyncStatusIndicator state={status} />} />
            <SettingsRow
              label="退出登录"
              hint="仅断开本机与云端的同步，本地数据保留"
              control={
                <Button
                  color="error"
                  variant="outlined"
                  disabled={busy}
                  onClick={() => void logout()}
                  sx={{ textTransform: 'none', fontSize: 13 }}
                >
                  退出登录
                </Button>
              }
            />
          </>
        ) : (
          <SettingsRow
            label="登录 / 注册"
            hint="登录后可跨设备同步你的 Agent、会话与设置"
            control={
              <Button
                variant="contained"
                onClick={goAuth}
                sx={{ textTransform: 'none', fontSize: 13 }}
              >
                登录 / 注册
              </Button>
            }
          />
        )}
      </SettingsCard>

      {/*
        ⚠️ 批次 6：以下两项属数据主权（FR-10.6），本批不实现。
          - 「导出全部数据」→ 见 batch-6 规格
          - 「彻底删除账户」→ 见 batch-6 规格
        位置在此占位，避免批次 6 重新设计版面。
      */}
      <SettingsCard
        title="数据主权（即将开放）"
        description="以下能力属数据主权范畴，将在后续版本提供；此处先占位，避免届时重新设计版面。"
      >
        <SettingsRow
          label="导出全部数据"
          hint="导出你在 nanoWork 中的全部数据（JSON 归档）"
          control={
            <Button variant="outlined" disabled sx={{ textTransform: 'none', fontSize: 13 }}>
              导出全部数据
            </Button>
          }
        />
        <SettingsRow
          label="彻底删除账户"
          hint="删除云端账户与全部同步数据，不可撤销"
          control={
            <Button
              variant="outlined"
              color="error"
              disabled
              sx={{ textTransform: 'none', fontSize: 13 }}
            >
              彻底删除账户
            </Button>
          }
        />
      </SettingsCard>
    </Box>
  );
}
