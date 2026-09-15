import { useMemo, useState } from 'react';
import {
  Box,
  Collapse,
  Dialog,
  Divider,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ImageIcon from '@mui/icons-material/Image';
import MovieIcon from '@mui/icons-material/Movie';
import CodeIcon from '@mui/icons-material/Code';
import ArticleIcon from '@mui/icons-material/Article';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import FolderIcon from '@mui/icons-material/Folder';
import { ArtifactRenderer } from '@/components/ArtifactRenderer';
import { toast } from '@/components/Toast';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { platform } from '@/platform';
import type { Artifact, ArtifactType } from '@/types';

/** 面板固定宽度（与左侧 240px 侧栏对称，主内容区仍保有足够空间） */
const PANEL_WIDTH = 300;

/** 未设置工作空间时的展示名（与侧边栏的默认分组名保持一致） */
const DEFAULT_WORKSPACE_LABEL = '默认工作空间';

/** 产物类型 → 列表图标 */
function artifactIcon(type: ArtifactType) {
  const sx = { fontSize: 15 } as const;
  switch (type) {
    case 'image':
    case 'svg':
      return <ImageIcon sx={sx} />;
    case 'video':
      return <MovieIcon sx={sx} />;
    case 'mermaid':
      return <AccountTreeIcon sx={sx} />;
    case 'html':
    case 'code':
      return <CodeIcon sx={sx} />;
    default:
      return <ArticleIcon sx={sx} />;
  }
}

/** 本地时间简写：MM-DD HH:mm */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 右侧产物面板（会话级）。
 *
 * 由侧边栏会话行的「产物面板」入口开关，跟随 `sessionUiStore`：
 * - 概览：当前会话的元信息（Agent / 模型 / 消息数 / 工作空间 / 时间）
 * - 产物：`artifactsStore` 中该会话归档的富产物，点击就地预览
 */
export function ArtifactPanel() {
  const open = useSessionUiStore((s) => s.artifactPanelOpen);
  const sessionId = useSessionUiStore((s) => s.artifactPanelSessionId);
  const closePanel = useSessionUiStore((s) => s.closeArtifactPanel);

  const sessions = useSessionsStore((s) => s.sessions);
  const agents = useAgentsStore((s) => s.agents);
  const bySession = useArtifactsStore((s) => s.bySession);

  const session = useMemo(
    () => sessions.find((s) => s.id === sessionId),
    [sessions, sessionId],
  );
  const artifacts = useMemo(
    () => (sessionId ? (bySession[sessionId] ?? []) : []),
    [bySession, sessionId],
  );

  /** 分组展开状态（默认全展开，对齐截图里的「概览 ⌄ / 产物 ⌄」） */
  const [overviewOpen, setOverviewOpen] = useState(true);
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  /** 正在预览的产物 */
  const [preview, setPreview] = useState<Artifact | null>(null);

  if (!open) return null;

  const agentName =
    agents.find((a) => a.id === session?.agentId)?.name ?? '未知 Agent';

  const overviewRows: Array<{ label: string; value: string }> = [
    { label: '智能体', value: agentName },
    { label: '模型', value: session?.model?.trim() || '跟随全局默认' },
    { label: '消息数', value: `${session?.messages.length ?? 0} 条` },
    { label: '产物数', value: `${artifacts.length} 个` },
    { label: '工作空间', value: session?.workdir?.trim() || DEFAULT_WORKSPACE_LABEL },
    { label: '创建于', value: session ? shortTime(session.createdAt) : '—' },
    { label: '更新于', value: session ? shortTime(session.updatedAt) : '—' },
  ];

  /** 在系统文件管理器中打开该会话的工作空间 */
  const openWorkspace = async () => {
    const workdir = session?.workdir?.trim();
    if (!workdir) {
      toast.warning('该会话未设置工作空间');
      return;
    }
    const result = await platform.openPath(workdir);
    if (!result.ok) toast.error(result.error ?? '打开工作空间失败');
  };

  /** 折叠/展开全部分组 */
  const toggleAll = () => {
    const next = !(overviewOpen && artifactsOpen);
    setOverviewOpen(next);
    setArtifactsOpen(next);
  };

  return (
    <>
      <Box
        sx={{
          width: PANEL_WIDTH,
          flexShrink: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderLeft: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        {/* 顶栏：折叠全部 / 打开工作空间 / 收起面板 */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            px: 1,
            py: 0.75,
            flexShrink: 0,
          }}
        >
          <Tooltip title="折叠 / 展开全部分组" placement="bottom">
            <IconButton size="small" sx={{ p: 0.4 }} onClick={toggleAll}>
              <MenuIcon sx={{ fontSize: 17 }} />
            </IconButton>
          </Tooltip>
          <Typography
            noWrap
            sx={{
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              fontWeight: 600,
              color: 'text.secondary',
              px: 0.5,
            }}
          >
            {session?.title ?? '会话详情'}
          </Typography>
          <Tooltip title="在资源管理器打开工作空间" placement="bottom">
            <IconButton size="small" sx={{ p: 0.4 }} onClick={() => void openWorkspace()}>
              <OpenInNewIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="收起产物面板" placement="bottom">
            <IconButton size="small" sx={{ p: 0.4 }} onClick={closePanel}>
              <ViewSidebarIcon sx={{ fontSize: 16, transform: 'scaleX(-1)' }} />
            </IconButton>
          </Tooltip>
        </Box>
        <Divider />

        <Box sx={{ flex: 1, overflowY: 'auto', py: 0.5 }}>
          {/* 概览：会话元信息 */}
          <GroupHeader
            label="概览"
            open={overviewOpen}
            onToggle={() => setOverviewOpen((v) => !v)}
          />
          <Collapse in={overviewOpen} timeout={180} unmountOnExit>
            <Box sx={{ px: 1.5, pb: 1 }}>
              {overviewRows.map((row) => (
                <Box
                  key={row.label}
                  sx={{ display: 'flex', gap: 1, py: 0.4, alignItems: 'flex-start' }}
                >
                  <Typography
                    sx={{
                      fontSize: 12,
                      color: 'text.secondary',
                      flexShrink: 0,
                      width: 62,
                    }}
                  >
                    {row.label}
                  </Typography>
                  <Typography
                    sx={{
                      fontSize: 12,
                      flex: 1,
                      minWidth: 0,
                      wordBreak: 'break-all',
                      lineHeight: 1.45,
                    }}
                  >
                    {row.value}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Collapse>

          {/* 产物：该会话归档的富产物 */}
          <GroupHeader
            label="产物"
            open={artifactsOpen}
            onToggle={() => setArtifactsOpen((v) => !v)}
          />
          <Collapse in={artifactsOpen} timeout={180} unmountOnExit>
            <Box sx={{ px: 0.75, pb: 1 }}>
              {artifacts.length === 0 ? (
                <Typography
                  sx={{
                    px: 0.75,
                    py: 1.5,
                    fontSize: 12.5,
                    color: 'text.secondary',
                  }}
                >
                  暂无内容
                </Typography>
              ) : (
                artifacts.map((a) => (
                  <Box
                    key={a.id}
                    onClick={() => setPreview(a)}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      px: 0.75,
                      py: 0.6,
                      borderRadius: 1,
                      cursor: 'pointer',
                      color: 'text.secondary',
                      '&:hover': { bgcolor: 'action.hover' },
                    }}
                  >
                    {artifactIcon(a.type)}
                    <Typography
                      noWrap
                      sx={{ fontSize: 12.5, color: 'text.primary', flex: 1, minWidth: 0 }}
                    >
                      {a.title?.trim() || a.id}
                    </Typography>
                  </Box>
                ))
              )}
            </Box>
          </Collapse>
        </Box>
      </Box>

      {/* 产物预览：复用消息流内的富产物渲染器 */}
      <Dialog
        open={!!preview}
        onClose={() => setPreview(null)}
        maxWidth="md"
        fullWidth
        PaperProps={{ sx: { borderRadius: 2 } }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 2,
            py: 1.25,
            borderBottom: '1px solid',
            borderColor: 'divider',
          }}
        >
          <FolderIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          <Typography noWrap sx={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0 }}>
            {preview?.title?.trim() || preview?.id}
          </Typography>
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary', flexShrink: 0 }}>
            {preview ? shortTime(preview.createdAt) : ''}
          </Typography>
        </Box>
        <Box sx={{ p: 2, maxHeight: '70vh', overflow: 'auto' }}>
          {preview && <ArtifactRenderer artifact={preview} />}
        </Box>
      </Dialog>
    </>
  );
}

/** 分组标题：chevron + 名称，整行可点 */
function GroupHeader({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Box
      onClick={onToggle}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        px: 1.25,
        py: 0.6,
        cursor: 'pointer',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      {open ? (
        <ExpandMoreIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
      ) : (
        <ChevronRightIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
      )}
      <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{label}</Typography>
    </Box>
  );
}
