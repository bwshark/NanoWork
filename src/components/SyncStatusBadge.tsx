import { useEffect, useRef, type ReactNode } from 'react';
import { Box, CircularProgress, Tooltip, Typography } from '@mui/material';
import CloudOffOutlinedIcon from '@mui/icons-material/CloudOffOutlined';
import CloudDoneOutlinedIcon from '@mui/icons-material/CloudDoneOutlined';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { useNavigate } from 'react-router-dom';
import { toast } from '@/components/Toast';
import { ROUTES } from '@/lib/constants';
import { useSettingsUiStore } from '@/stores/settingsUiStore';
import { getSyncRuntime, useSyncStatus } from '@/sync';
import type { SyncStatus, SyncStatusState } from '@/sync';

/**
 * 同步状态徽章（侧栏底部，紧邻「设置」行）。
 *
 * ## 为什么放侧栏而不是标题栏
 *
 * `TitleBar` 只在 Electron 渲染（`if (platform.env !== 'electron') return null`），
 * 而 Web 端同样要看同步状态；且 Web 端没有标题栏可挂。侧栏底部已有一行「设置」，
 * 徽章放其上方，天然成为「同步状态 + 同步入口」的落点，两平台一致。
 *
 * ## 冲突 toast 只在「过渡沿」弹一次
 *
 * 一轮同步把 `status` 判成 `conflict` 后，若每轮空闲同步都重复置位，直接对
 * `status === 'conflict'` 弹 toast 会变成 30s 一次的骚扰。故用 `prev` 记住上一个
 * 状态，只在「非 conflict → conflict」的**跳变**时弹一次。
 */

/** 五态展示（图标 / 文案 / 颜色）。徽章与设置页内嵌指示器共用同一份映射。 */
export interface SyncStatusView {
  label: string;
  color: string;
  icon: ReactNode;
}

/** 把同步状态映射成可展示的视图模型（单一事实源）。 */
export function syncStatusView(status: SyncStatus): SyncStatusView {
  switch (status) {
    case 'syncing':
      return {
        label: '同步中',
        color: 'primary.main',
        icon: <CircularProgress size={12} thickness={5} color="inherit" />,
      };
    case 'synced':
      return {
        label: '已同步',
        color: 'success.main',
        icon: <CloudDoneOutlinedIcon sx={{ fontSize: 14 }} />,
      };
    case 'conflict':
      return {
        label: '同步冲突',
        color: 'warning.main',
        icon: <WarningAmberOutlinedIcon sx={{ fontSize: 14 }} />,
      };
    case 'offline':
      return {
        label: '离线',
        color: 'error.main',
        icon: <ErrorOutlineOutlinedIcon sx={{ fontSize: 14 }} />,
      };
    case 'local':
    default:
      return {
        label: '未同步',
        color: 'text.secondary',
        icon: <CloudOffOutlinedIcon sx={{ fontSize: 14 }} />,
      };
  }
}

/** 徽章的悬停说明：把该态最有用的细节（时间 / 错误）带出来。 */
function badgeTooltip(state: SyncStatusState): string {
  switch (state.status) {
    case 'syncing':
      return '正在同步…';
    case 'synced':
      return state.lastSyncedAt
        ? `上次同步：${new Date(state.lastSyncedAt).toLocaleString()}`
        : '已同步';
    case 'conflict':
      return '检测到同步冲突：已保留服务端版本，本地改动未丢失';
    case 'offline':
      return state.lastError ?? '网络或服务端异常，本地功能不受影响';
    case 'local':
    default:
      return '尚未登录 / 未同步；点击去登录以开启跨设备同步';
  }
}

/**
 * 只读状态指示器（图标 + 文案），不弹 toast、不可点击。
 * 设置弹窗「账户」分区内嵌用它——它若也带上徽章那套 toast 逻辑，就会与侧栏徽章
 * 重复弹冲突提示（违反「只弹一次」）。
 */
export function SyncStatusIndicator({ state }: { state: SyncStatusState }) {
  const view = syncStatusView(state.status);
  return (
    <Box
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, color: view.color }}
    >
      {view.icon}
      <Typography sx={{ fontSize: 12.5, fontWeight: 600, color: 'inherit' }}>
        {view.label}
      </Typography>
    </Box>
  );
}

/** 侧栏底部的同步状态徽章（可点击：未登录跳登录页，已登录打开「账户」分区）。 */
export function SyncStatusBadge() {
  const state = useSyncStatus();
  const navigate = useNavigate();
  const openSettings = useSettingsUiStore((s) => s.openSettings);

  // 过渡沿去重：只有「非 conflict → conflict」才弹（见文件头说明）
  const prev = useRef<SyncStatus>(state.status);
  useEffect(() => {
    if (state.status === 'conflict' && prev.current !== 'conflict') {
      toast.warning('检测到同步冲突：已保留服务端版本，本地改动未丢失');
    }
    prev.current = state.status;
  }, [state.status]);

  const view = syncStatusView(state.status);

  const activate = (): void => {
    const session = getSyncRuntime()?.account.getSession() ?? null;
    // 已登录：直接打开设置弹窗的「账户」分区（settingsUiStore 支持指定分区）；
    // 未登录：去登录页开启同步。
    if (session) openSettings('account');
    else navigate(ROUTES.auth);
  };

  return (
    <Tooltip title={badgeTooltip(state)} placement="top">
      <Box
        component="button"
        type="button"
        onClick={activate}
        aria-label={`同步状态：${view.label}`}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          width: '100%',
          px: 1.5,
          py: 0.75,
          border: 'none',
          borderRadius: 2,
          bgcolor: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          color: view.color,
          '&:hover': { bgcolor: 'action.hover' },
        }}
      >
        {view.icon}
        <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: 'inherit' }}>
          {view.label}
        </Typography>
      </Box>
    </Tooltip>
  );
}
