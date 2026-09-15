import { useState } from 'react';
import {
  Box,
  Button,
  Divider,
  Menu,
  MenuItem,
  Popover,
  Switch,
  Typography,
} from '@mui/material';
import WorkspacesIcon from '@mui/icons-material/Workspaces';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import GppMaybeIcon from '@mui/icons-material/GppMaybe';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ClearIcon from '@mui/icons-material/Clear';
import { platform } from '@/platform';
import { useSessionsStore } from '@/stores/sessionsStore';

/** 从路径取末级目录名用于展示（跨平台分隔符兼容） */
function dirBasename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * 输入框工具条的「会话级上下文」控件：工作空间选择 + 权限设定。
 * - 工作空间：Electron 弹原生目录选择；Web 降级 File System Access API。
 *   未选择目录的会话归入「默认工作空间」。
 * - 权限：默认权限（敏感操作逐一确认）/ 允许完全访问（自动批准）。
 * 两者均作用于当前会话（无活跃会话时先创建会话再应用）。
 */
export function ComposerControls() {
  const activeSessionId = useSessionsStore((s) => s.activeId);
  const activeSession = useSessionsStore((s) =>
    activeSessionId ? s.sessions.find((x) => x.id === activeSessionId) : undefined,
  );
  const createSession = useSessionsStore((s) => s.createSession);
  const setSessionWorkdir = useSessionsStore((s) => s.setSessionWorkdir);
  const setSessionFullAccess = useSessionsStore((s) => s.setSessionFullAccess);

  const [wsMenuAnchor, setWsMenuAnchor] = useState<null | HTMLElement>(null);
  const [permAnchor, setPermAnchor] = useState<null | HTMLElement>(null);

  /** 无活跃会话时先创建（继承当前全局活跃专家团 / 专家），返回会话 id */
  const ensureSession = (): string => {
    if (activeSessionId) return activeSessionId;
    return createSession(undefined, '新会话').id;
  };

  /** 打开系统目录选择器并应用到当前会话 */
  const handlePickWorkdir = async () => {
    setWsMenuAnchor(null);
    const dir = await platform.pickDirectory();
    if (!dir) return; // 用户取消
    setSessionWorkdir(ensureSession(), dir);
  };

  const handleClearWorkdir = () => {
    setWsMenuAnchor(null);
    if (activeSessionId) setSessionWorkdir(activeSessionId, undefined);
  };

  const fullAccess = activeSession?.fullAccess ?? false;

  return (
    <>
      {/* 工作空间按钮：已选目录时显示目录名 */}
      <Button
        size="small"
        startIcon={<WorkspacesIcon fontSize="small" />}
        onClick={(e) => setWsMenuAnchor(e.currentTarget)}
        sx={{
          textTransform: 'none',
          color: 'text.secondary',
          fontSize: 12,
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
        }}
      >
        {activeSession?.workdir ? dirBasename(activeSession.workdir) : '选择工作空间'}
      </Button>

      {/* 权限按钮：图标颜色随策略变化（绿=默认沙箱，橙=完全访问） */}
      <Button
        size="small"
        startIcon={
          fullAccess ? (
            <GppMaybeIcon fontSize="small" sx={{ color: 'warning.main' }} />
          ) : (
            <VerifiedUserIcon fontSize="small" sx={{ color: 'success.main' }} />
          )
        }
        onClick={(e) => setPermAnchor(e.currentTarget)}
        sx={{
          textTransform: 'none',
          color: 'text.secondary',
          fontSize: 12,
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
        }}
      >
        {fullAccess ? '完全访问' : '默认权限'}
      </Button>

      {/* 工作空间选择菜单 */}
      <Menu
        anchorEl={wsMenuAnchor}
        open={!!wsMenuAnchor}
        onClose={() => setWsMenuAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 180 } } }}
      >
        <MenuItem onClick={() => void handlePickWorkdir()}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <FolderOpenIcon fontSize="small" sx={{ color: 'text.secondary' }} />
            <Typography variant="body2">选择工作空间…</Typography>
          </Box>
        </MenuItem>
        {activeSession?.workdir && (
          <MenuItem onClick={handleClearWorkdir}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <ClearIcon fontSize="small" sx={{ color: 'text.secondary' }} />
              <Typography variant="body2">清除（回到默认工作空间）</Typography>
            </Box>
          </MenuItem>
        )}
      </Menu>

      {/* 权限设定弹层 */}
      <Popover
        open={!!permAnchor}
        anchorEl={permAnchor}
        onClose={() => setPermAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { p: 2, width: 300 } } }}
      >
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {fullAccess
            ? '当前为完全访问，AI 将直接执行敏感操作（文件 / 终端 / 网络），不再逐一请求你的允许。'
            : '当前为默认权限，所有操作都会在安全沙箱约束内进行，超出范围会请求你的允许。'}
        </Typography>
        <Divider sx={{ my: 1.5 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="body2" fontWeight={600}>
            允许完全访问
          </Typography>
          <Switch
            size="small"
            checked={fullAccess}
            onChange={(e) => {
              setSessionFullAccess(ensureSession(), e.target.checked);
            }}
          />
        </Box>
      </Popover>
    </>
  );
}
