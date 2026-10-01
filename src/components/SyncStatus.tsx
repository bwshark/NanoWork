import { useEffect, useRef, type ReactNode } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import CloudOffOutlinedIcon from '@mui/icons-material/CloudOffOutlined';
import CloudDoneOutlinedIcon from '@mui/icons-material/CloudDoneOutlined';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { toast } from '@/components/Toast';
import { useSyncStatus } from '@/sync';
import type { SyncStatus, SyncStatusState } from '@/sync';

/**
 * 同步状态的展示层：五态映射（`syncStatusView`）+ 只读指示器（`SyncStatusIndicator`）
 * + 冲突通知（`useSyncConflictToast`）。
 *
 * ## 这里为什么**没有**侧栏徽章
 *
 * 曾有一个挂在侧栏底部的可点击徽章（未登录显示「未同步」，点击去登录 / 打开账户分区）。
 * 它已被**账户入口**取代（`components/AccountEntry.tsx`）：未登录时那一行直接就是
 * 「登录」，已登录时是账号菜单——徽章那点信息量（一个灰色「未同步」）在未登录时是纯噪音，
 * 而它的两个点击动作都已被账户入口完整承接，不是被砍掉的能力。
 *
 * 保留 `syncStatusView` 是因为设置弹窗「账户」分区里的 `SyncStatusIndicator` 仍要它；
 * 保留 `useSyncConflictToast` 是因为**冲突提示不能跟着徽章一起消失**——见下。
 */

/** 五态展示（图标 / 文案 / 颜色）。设置页内嵌指示器与后续任何同步状态展示共用这一份映射。 */
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

/**
 * 只读状态指示器（图标 + 文案），不弹 toast、不可点击。
 * 设置弹窗「账户」分区内嵌用它。
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

/**
 * 「同步冲突」只弹一次的**过渡沿去重**。
 *
 * 一轮空闲同步（默认 30s）若每轮都把状态判成 `conflict` 就弹一次，骚扰程度远超其价值；
 * 故用 `prev` 记住上一个状态，只在「非 conflict → conflict」的**跳变**时弹一次。
 *
 * 挂在**布局层**（`AppLayout`）而不是某块 UI 上：它是一条应用级通知。挂在侧栏里就会
 * 被「侧边栏折叠」（Electron 下整块不渲染）连带关掉——那时冲突提示会**静默消失**，
 * 而这恰恰是用户最需要知道的一次状态变化。
 */
export function useSyncConflictToast(): void {
  const state = useSyncStatus();
  const prev = useRef<SyncStatus>(state.status);
  useEffect(() => {
    if (state.status === 'conflict' && prev.current !== 'conflict') {
      toast.warning('检测到同步冲突：已保留服务端版本，本地改动未丢失');
    }
    prev.current = state.status;
  }, [state.status]);
}
