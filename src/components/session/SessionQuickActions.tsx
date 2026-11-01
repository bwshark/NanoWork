import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Divider,
  IconButton,
  Popover,
  Tooltip,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import HistoryIcon from '@mui/icons-material/History';
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar';
import { ROUTES } from '@/lib/core/constants';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import type { Message } from '@/types';

/** 尺寸变体：侧栏会话行用 sm（紧凑），会话头部用 md（与头部标题同级） */
const SIZES = {
  sm: { button: 22, icon: 14, gap: 0.25 },
  md: { button: 32, icon: 19, gap: 0.25 },
} as const;

type QuickActionSize = keyof typeof SIZES;

interface SessionQuickActionsProps {
  /** 会话 id：任务会话为本地 id，频道会话形如 `nb:{key}` */
  sessionId: string;
  /**
   * 会话尚未载入本地 store 时的载入钩子（频道会话走网关拉取）。
   * 打开「历史提问」与定位消息前会先 await 它，保证目标消息已渲染。
   */
  ensureLoaded?: () => Promise<void>;
  /** 尺寸变体，默认 sm（侧边栏） */
  size?: QuickActionSize;
}

/**
 * 会话的三个快捷入口：对话内搜索 / 历史提问 / 右侧边栏。
 *
 * 挂在会话标题右侧（任务列表行、频道列表行、聊天头部共用），交互保持一致：
 * - 搜索 → 在标题右侧内联展开搜索条（并切到该会话）
 * - 历史提问 → 就地弹出该会话的全部用户提问，点击滚动定位
 * - 右侧边栏 → 右侧展开（并切到该会话）
 */
export function SessionQuickActions({
  sessionId,
  ensureLoaded,
  size = 'sm',
}: SessionQuickActionsProps) {
  const navigate = useNavigate();
  const selectSession = useSessionsStore((s) => s.selectSession);
  const session = useSessionsStore((s) =>
    s.sessions.find((x) => x.id === sessionId),
  );

  const openSearch = useSessionUiStore((s) => s.openSearch);
  const toggleArtifactPanel = useSessionUiStore((s) => s.toggleArtifactPanel);
  const focusMessage = useSessionUiStore((s) => s.focusMessage);
  const searchOpen = useSessionUiStore((s) => s.searchSessionId === sessionId);
  const panelOpen = useSessionUiStore(
    (s) => s.artifactPanelOpen && s.artifactPanelSessionId === sessionId,
  );

  /** 历史提问弹层的锚点 */
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const dim = SIZES[size];
  const btnSx = {
    p: 0.25,
    width: dim.button,
    height: dim.button,
  } as const;
  const iconSx = { fontSize: dim.icon } as const;

  /** 会话未载入时，弹层打开后惰性载入一次（频道会话走网关，任务会话不会走到） */
  useEffect(() => {
    if (!anchorEl || session || !ensureLoaded) return;
    void ensureLoaded();
  }, [anchorEl, session, ensureLoaded]);

  /** 该会话的全部用户提问（仅 user 角色，按时间正序） */
  const asks = useMemo(
    () => (session?.messages ?? []).filter((m) => m.role === 'user'),
    [session],
  );

  /** 确保目标会话处于激活态：先把会话载入 store，再设为活跃 */
  const activateTarget = async () => {
    const store = useSessionsStore.getState();
    if (store.activeId === sessionId) return;
    if (!store.sessions.some((s) => s.id === sessionId) && ensureLoaded) {
      await ensureLoaded();
    }
    selectSession(sessionId);
  };

  const handleSearch = (e: React.MouseEvent) => {
    e.stopPropagation();
    void activateTarget();
    openSearch(sessionId);
    navigate(ROUTES.chat);
  };

  const handleArtifacts = (e: React.MouseEvent) => {
    e.stopPropagation();
    void activateTarget();
    toggleArtifactPanel(sessionId);
    navigate(ROUTES.chat);
  };

  const handleAskClick = async (m: Message) => {
    setAnchorEl(null);
    await activateTarget();
    navigate(ROUTES.chat);
    // 会话切换与定位请求同批提交，MessageStream 渲染后消费该请求
    focusMessage(m.id);
  };

  return (
    <>
      <Tooltip title="对话内搜索" placement="top">
        <IconButton
          size="small"
          sx={btnSx}
          color={searchOpen ? 'primary' : 'default'}
          onClick={handleSearch}
          aria-label="对话内搜索"
        >
          <SearchIcon sx={iconSx} />
        </IconButton>
      </Tooltip>

      <Tooltip title="历史提问" placement="top">
        <IconButton
          size="small"
          sx={btnSx}
          color={anchorEl ? 'primary' : 'default'}
          onClick={(e) => {
            e.stopPropagation();
            setAnchorEl(e.currentTarget);
          }}
          aria-label="历史提问"
        >
          <HistoryIcon sx={iconSx} />
        </IconButton>
      </Tooltip>

      <Tooltip title={panelOpen ? '收起右侧边栏' : '打开右侧边栏'} placement="top">
        <IconButton
          size="small"
          sx={btnSx}
          color={panelOpen ? 'primary' : 'default'}
          onClick={handleArtifacts}
          aria-label="右侧边栏"
        >
          {/* 水平镜像：ViewSidebar 默认是「左侧栏」，本面板在右侧 */}
          <ViewSidebarIcon sx={{ ...iconSx, transform: 'scaleX(-1)' }} />
        </IconButton>
      </Tooltip>

      <Popover
        open={!!anchorEl}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        onClick={(e) => e.stopPropagation()}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              width: 340,
              maxHeight: 360,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 2,
              mt: 0.75,
            },
          },
        }}
      >
        <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
            历史提问
            <Box component="span" sx={{ ml: 0.5, opacity: 0.75 }}>
              ({asks.length})
            </Box>
          </Typography>
        </Box>
        <Divider />
        <Box sx={{ flex: 1, overflowY: 'auto', py: 0.75 }}>
          {asks.length === 0 ? (
            <Typography
              sx={{
                px: 2,
                py: 3,
                fontSize: 12.5,
                color: 'text.secondary',
                textAlign: 'center',
              }}
            >
              暂无提问
            </Typography>
          ) : (
            asks.map((m) => (
              <Box
                key={m.id}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleAskClick(m);
                }}
                sx={{
                  px: 2,
                  py: 0.875,
                  cursor: 'pointer',
                  borderRadius: 1,
                  mx: 0.5,
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <Typography
                  noWrap
                  sx={{ fontSize: 13.5, lineHeight: 1.6 }}
                  title={m.content.trim()}
                >
                  {m.content.trim() || '(空消息)'}
                </Typography>
              </Box>
            ))
          )}
        </Box>
      </Popover>
    </>
  );
}
