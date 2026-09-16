import { useState, type ReactNode } from 'react';
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
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswer';
import ChecklistIcon from '@mui/icons-material/Checklist';
import BuildIcon from '@mui/icons-material/Build';
import { platform } from '@/platform';
import { useSessionsStore } from '@/stores/sessionsStore';
import { getRuntime } from '@/ai/runtime';
import type { ExecutionMode } from '@/types/event';

/** 从路径取末级目录名用于展示（跨平台分隔符兼容） */
function dirBasename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * 执行模式三选项（FR-1.4）。
 *
 * 文案刻意**先说能不能改文件**——用户对这三个词最可能的误解是「这只是回答
 * 风格」，而它实际约束的是工具网关：Ask / Plan 下写类工具被引擎 deny，
 * 不是「提示词自律」，是调用根本做不成。
 */
const MODE_OPTIONS: ReadonlyArray<{
  value: ExecutionMode;
  label: string;
  caption: string;
  icon: ReactNode;
}> = [
  {
    value: 'ask',
    label: 'Ask · 只问不改',
    caption: '只读探索，写类工具被引擎直接拒绝',
    icon: <QuestionAnswerIcon fontSize="small" />,
  },
  {
    value: 'plan',
    label: 'Plan · 先出计划',
    caption: '产出可勾选的计划，批准后才进入执行',
    icon: <ChecklistIcon fontSize="small" />,
  },
  {
    value: 'craft',
    label: 'Craft · 直接执行',
    caption: '允许改动文件与执行命令（受权限开关约束）',
    icon: <BuildIcon fontSize="small" />,
  },
];

/**
 * 输入框工具条的「会话级上下文」控件：工作空间选择 + 权限设定。
 * - 工作空间：Electron 弹原生目录选择；Web 降级 File System Access API。
 *   未选择目录的会话归入「默认工作空间」。
 * - 权限：两个正交开关——「逐条批准」（细：改动环境的操作执行前先问）与
 *   「允许完全访问」（粗：直接放开，等于不再逐条询问）。
 * - 执行模式（FR-1.4）：Ask / Plan / Craft，决定「能不能改东西」这一层。
 * 三者均作用于当前会话（无活跃会话时先创建会话再应用）。
 *
 * 执行模式选择器受 `capabilities.executionModes` 门控：引擎不支持时必须隐藏，
 * 不能留一个点了不生效的开关——那会让用户以为自己在 Plan 里，实际句句能写。
 */
export function ComposerControls() {
  const activeSessionId = useSessionsStore((s) => s.activeId);
  const activeSession = useSessionsStore((s) =>
    activeSessionId ? s.sessions.find((x) => x.id === activeSessionId) : undefined,
  );
  const createSession = useSessionsStore((s) => s.createSession);
  const setSessionWorkdir = useSessionsStore((s) => s.setSessionWorkdir);
  const setSessionFullAccess = useSessionsStore((s) => s.setSessionFullAccess);
  const setSessionToolApproval = useSessionsStore((s) => s.setSessionToolApproval);
  const setSessionMode = useSessionsStore((s) => s.setSessionMode);

  const [wsMenuAnchor, setWsMenuAnchor] = useState<null | HTMLElement>(null);
  const [permAnchor, setPermAnchor] = useState<null | HTMLElement>(null);
  const [modeAnchor, setModeAnchor] = useState<null | HTMLElement>(null);

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
  const toolApproval = activeSession?.toolApproval ?? false;
  const mode: ExecutionMode = activeSession?.mode ?? 'craft';
  const currentMode = MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[2];
  // 能力门控：同步取当前实现即可（单例惰性构造，不含 IO）
  const modesSupported = getRuntime().capabilities.executionModes === true;

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
        {fullAccess ? '完全访问' : toolApproval ? '逐条批准' : '默认权限'}
      </Button>

      {/* 执行模式按钮（FR-1.4）：不支持能力时整块隐藏，不留无效入口 */}
      {modesSupported && (
        <Button
          size="small"
          aria-label="切换执行模式"
          startIcon={currentMode.icon}
          onClick={(e) => setModeAnchor(e.currentTarget)}
          sx={{
            textTransform: 'none',
            color: 'text.secondary',
            fontSize: 12,
            '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
          }}
        >
          {currentMode.label}
        </Button>
      )}

      {/* 执行模式菜单 */}
      <Menu
        anchorEl={modeAnchor}
        open={!!modeAnchor}
        onClose={() => setModeAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 280 } } }}
      >
        {MODE_OPTIONS.map((opt) => (
          <MenuItem
            key={opt.value}
            selected={opt.value === mode}
            onClick={() => {
              setModeAnchor(null);
              setSessionMode(ensureSession(), opt.value);
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
              <Box sx={{ color: opt.value === mode ? 'primary.main' : 'text.secondary', mt: 0.1 }}>
                {opt.icon}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2">{opt.label}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {opt.caption}
                </Typography>
              </Box>
            </Box>
          </MenuItem>
        ))}
      </Menu>

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
        slotProps={{ paper: { sx: { p: 2, width: 320 } } }}
      >
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {fullAccess
            ? '当前为完全访问，AI 将在工作空间外直接执行操作，不再逐一请求你的允许。'
            : toolApproval
              ? '当前为逐条批准：写文件 / 执行命令等改动环境的操作，会在执行前暂停并请你确认。'
              : '当前为默认权限，操作在安全沙箱约束内进行，超出范围会被引擎拒绝。'}
        </Typography>
        <Divider sx={{ my: 1.5 }} />
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 1,
          }}
        >
          <Box>
            <Typography variant="body2" fontWeight={600}>
              逐条批准工具调用
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              只读操作自动放行；超时未响应按拒绝处理。
            </Typography>
          </Box>
          <Switch
            size="small"
            checked={toolApproval && !fullAccess}
            disabled={fullAccess}
            onChange={(e) => {
              setSessionToolApproval(ensureSession(), e.target.checked);
            }}
          />
        </Box>
        <Divider sx={{ my: 1.5 }} />
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 1,
          }}
        >
          <Box>
            <Typography variant="body2" fontWeight={600}>
              允许完全访问
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              更粗的开关：开启后不再逐条询问。
            </Typography>
          </Box>
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
