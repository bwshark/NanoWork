import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Collapse,
  Dialog,
  Divider,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RestoreIcon from '@mui/icons-material/Restore';
import VisibilityIcon from '@mui/icons-material/Visibility';
import ImageIcon from '@mui/icons-material/Image';
import MovieIcon from '@mui/icons-material/Movie';
import CodeIcon from '@mui/icons-material/Code';
import ArticleIcon from '@mui/icons-material/Article';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import { ArtifactRenderer } from '@/components/ArtifactRenderer';
import { FileIcon } from './FileIcon';
import { ArtifactPreviewBody } from './ArtifactPreviewBody';
import { useArtifactActions } from './useArtifactActions';
import { toast } from '@/components/Toast';
import { UNBOUND_AGENT_LABEL } from '@/lib/constants';
import { changeCountOf, formatBytes, isFileArtifact } from '@/lib/fileArtifact';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore, resolveArtifactContent } from '@/stores/artifactsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { useDefaultWorkspacePath } from '@/stores/storageInfoStore';
import { platform } from '@/platform';
import { ARTIFACT_TYPE_LABELS } from '@/lib/artifactIndex';
import type { Artifact, ArtifactType } from '@/types';

/** 列表态宽度（与左侧 240px 侧栏对称，主内容区仍保有足够空间） */
const PANEL_WIDTH = 300;
/** 预览态宽度：正文（尤以代码为中心）在 300px 里几乎不可读，预览时适当放宽 */
const PREVIEW_PANEL_WIDTH = 460;
/** 产物列表折叠阈值：超出部分收进「展开更多 (N)」，对齐参考稿 */
const COLLAPSED_LIMIT = 6;

/** 未设置工作空间时的展示名（与侧边栏的默认分组名保持一致） */
const DEFAULT_WORKSPACE_LABEL = '默认工作空间';

/** 富产物类型 → 列表图标（文件产物走 `FileIcon` 的扩展名角标） */
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
 * - **列表态**：概览（会话元信息）+ 产物（文件产物用扩展名角标 + 名称 + 体积，
 *   富产物用类型图标；超出折叠阈值收进「展开更多」）；
 * - **预览态**：由「点消息里的产物卡片」或点列表行进入，正文就地渲染
 *   （文件产物快照为空时按需回读磁盘），并保留版本历史 / 对比 / 回退。
 *
 * 预览做成**面板内的一个态**而不是弹窗：产品要求「点卡片 → 在右侧侧边栏打开预览」，
 * 弹窗会盖住对话流，恰好违背这条路径的意图。
 */
export function ArtifactPanel() {
  const open = useSessionUiStore((s) => s.artifactPanelOpen);
  const sessionId = useSessionUiStore((s) => s.artifactPanelSessionId);
  const closePanel = useSessionUiStore((s) => s.closeArtifactPanel);
  const previewId = useSessionUiStore((s) => s.artifactPanelPreviewId);
  const setPreviewId = useSessionUiStore((s) => s.setArtifactPanelPreview);
  const view = useSessionUiStore((s) => s.artifactPanelView);
  const setView = useSessionUiStore((s) => s.setArtifactPanelView);

  const sessions = useSessionsStore((s) => s.sessions);
  const agents = useAgentsStore((s) => s.agents);
  const bySession = useArtifactsStore((s) => s.bySession);
  const bodies = useArtifactsStore((s) => s.bodies);
  const index = useArtifactsStore((s) => s.index);

  const session = useMemo(
    () => sessions.find((s) => s.id === sessionId),
    [sessions, sessionId],
  );
  const artifacts = useMemo(
    () => (sessionId ? (bySession[sessionId] ?? []) : []),
    [bySession, sessionId],
  );

  /**
   * 「默认工作空间」当前的真实落点。早期会话没有 `workdir`（那时还没有这个设置项），
   * 但它们发消息时同样会落到这个目录上——面板要显示真实落点，否则会出现
   * 「概览写着默认工作空间、文件却存在 <home>/NanoWork」的错位，且右上角
   * 「在资源管理器打开」会以「该会话未设置工作空间」拒绝。
   */
  const defaultWorkspacePath = useDefaultWorkspacePath();
  const actions = useArtifactActions(sessionId ?? '');

  /** 分组展开状态（默认全展开，对齐截图里的「概览 ⌄ / 产物 ⌄」） */
  const [overviewOpen, setOverviewOpen] = useState(true);
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  /** 产物列表是否展开到全部（false = 只显示前 `COLLAPSED_LIMIT` 条） */
  const [listExpanded, setListExpanded] = useState(false);
  /** FR-7.4 版本历史：展开/收起 + 对比目标 + 正在预览的历史版本 */
  const [versionOpen, setVersionOpen] = useState(false);
  const [compare, setCompare] = useState<{ bHash: string; bLabel: string } | null>(null);
  const [versionHash, setVersionHash] = useState<string | null>(null);

  /** 正在预览的产物（列表里的引用） */
  const preview = useMemo(
    () => (previewId ? (artifacts.find((a) => a.id === previewId) ?? null) : null),
    [artifacts, previewId],
  );
  const entry = preview ? index[preview.id] : undefined;

  /**
   * 预览正文：按索引里的 `contentHash` 从内容池回填。
   *
   * `versionHash` 非空表示用户在版本历史里点了「预览此版本」，此时改用它回填；
   * 池里没有该版本正文（改写类产品不存快照）则回落内联 content（空串），
   * 由 `ArtifactPreviewBody` 决定是否回读磁盘。
   */
  const previewResolved = useMemo(() => {
    if (!preview) return null;
    if (versionHash) return { ...preview, content: resolveArtifactContent(versionHash, bodies, '') };
    const hash = index[preview.id]?.contentHash;
    const content = hash ? resolveArtifactContent(hash, bodies, preview.content) : preview.content;
    return { ...preview, content };
  }, [preview, versionHash, index, bodies]);

  /** 版本列表：优先用 `versions` 完整历史，旧数据（无 `versions`）退化为单版本 */
  const versionList = useMemo(() => {
    if (!entry) return [];
    if (Array.isArray(entry.versions) && entry.versions.length > 0) return entry.versions;
    return [
      { version: entry.version ?? 1, contentHash: entry.contentHash, createdAt: entry.createdAt, title: entry.title },
    ];
  }, [entry]);

  /** 把某版本的 `contentHash` 还原成可渲染的 `Artifact`（正文从内容池回填） */
  const resolveVersion = (hash: string, title?: string) => {
    if (!preview) return null;
    return { ...preview, content: resolveArtifactContent(hash, bodies, ''), title: title ?? preview.title };
  };

  /** FR-7.4 回退：把当前产物恢复到历史版本的正文（新开一版，旧正文仍留内容池） */
  const onRollback = (v: { version: number; contentHash: string; title?: string }) => {
    if (!preview) return;
    useArtifactsStore.getState().rollbackToVersion(preview.id, v.contentHash, v.title);
    setVersionHash(null);
    toast.success(`已回退到 v${v.version}，并新增当前版本`);
  };

  /** 切换预览的产物（同时清掉历史版本预览，避免串到别的产物上） */
  const openPreview = (id: string) => {
    setVersionHash(null);
    setPreviewId(id);
  };

  // 过滤：变更视图只留**被再次写入 / 编辑过的文件产物**（版本数 > 1）。
  // 口径与消息底部「查看所有变更 (M)」一致（都按文件数），因此富产物即使被改过
  // 也不进这一视图——它的版本徽章在「全部」里已经标出，不会因此被藏起来。
  const visibleArtifacts = useMemo(
    () =>
      view === 'changes'
        ? artifacts.filter((a) => isFileArtifact(a) && changeCountOf(index[a.id]) > 0)
        : artifacts,
    [artifacts, index, view],
  );
  const shownArtifacts = listExpanded
    ? visibleArtifacts
    : visibleArtifacts.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = visibleArtifacts.length - shownArtifacts.length;

  if (!open) return null;

  // 未绑定专家（「新建任务」的默认态）是正常状态，展示中性名而非「未知 Agent」
  const agentName =
    session?.agentId === ''
      ? UNBOUND_AGENT_LABEL
      : (agents.find((a) => a.id === session?.agentId)?.name ?? '未知 Agent');

  const overviewRows: Array<{ label: string; value: string }> = [
    { label: '智能体', value: agentName },
    { label: '模型', value: session?.model?.trim() || '跟随全局默认' },
    { label: '消息数', value: `${session?.messages.length ?? 0} 条` },
    { label: '产物数', value: `${artifacts.length} 个` },
    {
      label: '工作空间',
      value: session?.workdir?.trim() || defaultWorkspacePath || DEFAULT_WORKSPACE_LABEL,
    },
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

  const previewTitle = preview?.title?.trim() || preview?.path || preview?.id || '';

  return (
    <>
      <Box
        sx={{
          width: preview ? PREVIEW_PANEL_WIDTH : PANEL_WIDTH,
          flexShrink: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderLeft: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
          transition: 'width .18s ease',
        }}
      >
        {/* 顶栏：列表态 = 折叠全部 / 标题 / 打开工作空间；预览态 = 返回 / 产物名 / 操作 */}
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
          {preview ? (
            <>
              <Tooltip title="返回产物列表" placement="bottom">
                <IconButton size="small" sx={{ p: 0.4 }} onClick={() => setPreviewId(null)}>
                  <ArrowBackIcon sx={{ fontSize: 17 }} />
                </IconButton>
              </Tooltip>
              <Typography
                noWrap
                sx={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, px: 0.5 }}
              >
                {previewTitle}
              </Typography>
              <Tooltip title="在资源管理器打开" placement="bottom">
                <IconButton
                  size="small"
                  sx={{ p: 0.4 }}
                  onClick={() => actions.reveal(preview)}
                >
                  <FolderOpenIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="复制路径" placement="bottom">
                <IconButton
                  size="small"
                  sx={{ p: 0.4 }}
                  onClick={() => actions.copyPath(preview)}
                >
                  <ContentCopyIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            </>
          ) : (
            <>
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
            </>
          )}
          <Tooltip title="收起产物面板" placement="bottom">
            <IconButton size="small" sx={{ p: 0.4 }} onClick={closePanel}>
              <ViewSidebarIcon sx={{ fontSize: 16, transform: 'scaleX(-1)' }} />
            </IconButton>
          </Tooltip>
        </Box>
        <Divider />

        {preview ? (
          /* ── 预览态 ── */
          <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <Box sx={{ px: 1.25, pt: 1 }}>
              {preview.path && (
                <Tooltip title={preview.path} enterDelay={600}>
                  <Typography
                    noWrap
                    sx={{ fontSize: 11.5, color: 'text.secondary' }}
                  >
                    {preview.path}
                  </Typography>
                </Tooltip>
              )}
              {versionHash && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                  <Typography sx={{ fontSize: 11.5, color: 'warning.main' }}>
                    正在预览历史版本
                  </Typography>
                  <Button
                    size="small"
                    sx={{ textTransform: 'none', fontSize: 11.5, minWidth: 0, px: 0.5 }}
                    onClick={() => setVersionHash(null)}
                  >
                    返回当前版本
                  </Button>
                </Box>
              )}
            </Box>
            <Box sx={{ px: 1.25, py: 1 }}>
              {previewResolved && <ArtifactPreviewBody artifact={previewResolved} />}
            </Box>

            {/* 版本历史（FR-7.4）：列表 + 预览 / 对比 / 回退 */}
            {versionList.length > 1 && (
              <>
                <Divider />
                <Box sx={{ px: 1.5, py: 0.75 }}>
                  <GroupHeader
                    label={`版本历史 (${versionList.length})`}
                    open={versionOpen}
                    onToggle={() => setVersionOpen((v) => !v)}
                  />
                  <Collapse in={versionOpen} timeout={180} unmountOnExit>
                    <Box sx={{ pb: 0.5 }}>
                      {versionList.map((v) => {
                        const isCurrent = entry?.contentHash === v.contentHash;
                        // 改写类工具不存正文快照：没有正文的版本只能对比，不能预览 / 回退
                        const hasBody = bodies[v.contentHash] !== undefined;
                        return (
                          <Box
                            key={v.version}
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 0.5,
                              px: 0.5,
                              py: 0.4,
                              borderRadius: 1,
                              '&:hover': { bgcolor: 'action.hover' },
                            }}
                          >
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Typography noWrap sx={{ fontSize: 12.5, color: 'text.primary' }}>
                                v{v.version}
                                {v.title ? ` · ${v.title}` : ''}
                                {isCurrent ? ' · 当前' : ''}
                              </Typography>
                              <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                                {shortTime(v.createdAt)}
                                {!hasBody ? ' · 无正文快照' : ''}
                              </Typography>
                            </Box>
                            <Tooltip
                              title={hasBody ? '预览此版本' : '该版本未捕获正文'}
                              placement="bottom"
                            >
                              <span>
                                <IconButton
                                  size="small"
                                  sx={{ p: 0.4 }}
                                  disabled={!hasBody}
                                  onClick={() => {
                                    setVersionHash(v.contentHash);
                                    setVersionOpen(false);
                                  }}
                                >
                                  <VisibilityIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                              </span>
                            </Tooltip>
                            <Tooltip title="与当前版本对比" placement="bottom">
                              <IconButton
                                size="small"
                                sx={{ p: 0.4 }}
                                onClick={() =>
                                  setCompare({ bHash: v.contentHash, bLabel: `v${v.version}` })
                                }
                              >
                                <CompareArrowsIcon sx={{ fontSize: 16 }} />
                              </IconButton>
                            </Tooltip>
                            <Tooltip
                              title={hasBody ? '回退到此版本' : '该版本未捕获正文，无法回退'}
                              placement="bottom"
                            >
                              <span>
                                <IconButton
                                  size="small"
                                  sx={{ p: 0.4 }}
                                  disabled={!hasBody}
                                  onClick={() => onRollback(v)}
                                >
                                  <RestoreIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                              </span>
                            </Tooltip>
                          </Box>
                        );
                      })}
                    </Box>
                  </Collapse>
                </Box>
              </>
            )}
          </Box>
        ) : (
          /* ── 列表态 ── */
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

            {/* 产物：该会话归档的富产物 + 文件产物 */}
            <GroupHeader
              label="产物"
              open={artifactsOpen}
              onToggle={() => setArtifactsOpen((v) => !v)}
            />
            <Collapse in={artifactsOpen} timeout={180} unmountOnExit>
              <Box sx={{ px: 0.75, pb: 1 }}>
                {artifacts.length === 0 ? (
                  <Typography
                    sx={{ px: 0.75, py: 1.5, fontSize: 12.5, color: 'text.secondary' }}
                  >
                    暂无内容
                  </Typography>
                ) : (
                  <>
                    {/* 全部 / 变更 两个口径：变更 = 被再次写入或编辑过（版本数 > 1） */}
                    <Box sx={{ display: 'flex', gap: 0.5, px: 0.5, pb: 0.75 }}>
                      {(['all', 'changes'] as const).map((mode) => (
                        <Button
                          key={mode}
                          size="small"
                          disableRipple
                          onClick={() => setView(mode)}
                          sx={{
                            textTransform: 'none',
                            fontSize: 12,
                            minWidth: 0,
                            px: 1,
                            py: 0.25,
                            borderRadius: 999,
                            color: view === mode ? 'primary.contrastText' : 'text.secondary',
                            bgcolor: view === mode ? 'primary.main' : 'action.hover',
                            '&:hover': {
                              bgcolor: view === mode ? 'primary.main' : 'action.selected',
                            },
                          }}
                        >
                          {mode === 'all' ? '全部' : '变更'}
                        </Button>
                      ))}
                    </Box>

                    {visibleArtifacts.length === 0 ? (
                      <Typography
                        sx={{ px: 0.75, py: 1.5, fontSize: 12.5, color: 'text.secondary' }}
                      >
                        暂无被编辑过的产物
                      </Typography>
                    ) : (
                      shownArtifacts.map((a) => (
                        <ArtifactRow
                          key={a.id}
                          artifact={a}
                          changes={changeCountOf(index[a.id])}
                          version={index[a.id]?.version ?? 1}
                          onOpen={() => openPreview(a.id)}
                          onLocate={() => actions.locate(a)}
                        />
                      ))
                    )}

                    {/* 展开更多 / 收起（对齐参考稿的「展开更多 (N)」） */}
                    {hiddenCount > 0 && (
                      <Button
                        size="small"
                        onClick={() => setListExpanded(true)}
                        sx={{
                          textTransform: 'none',
                          fontSize: 12,
                          color: 'text.secondary',
                          px: 0.75,
                          mt: 0.25,
                        }}
                      >
                        展开更多 ({hiddenCount})
                      </Button>
                    )}
                    {listExpanded && visibleArtifacts.length > COLLAPSED_LIMIT && (
                      <Button
                        size="small"
                        onClick={() => setListExpanded(false)}
                        sx={{
                          textTransform: 'none',
                          fontSize: 12,
                          color: 'text.secondary',
                          px: 0.75,
                          mt: 0.25,
                        }}
                      >
                        收起
                      </Button>
                    )}
                  </>
                )}
              </Box>
            </Collapse>
          </Box>
        )}
      </Box>

      {/* 版本对比（FR-7.4）：左 = 当前版本，右 = 所选历史版本 */}
      <Dialog
        open={!!compare}
        onClose={() => setCompare(null)}
        maxWidth="lg"
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
          <CompareArrowsIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
          <Typography noWrap sx={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0 }}>
            版本对比 · 当前 vs {compare?.bLabel}
          </Typography>
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary', flexShrink: 0 }}>
            {preview ? shortTime(preview.createdAt) : ''}
          </Typography>
        </Box>
        <Box sx={{ p: 2, maxHeight: '72vh', overflow: 'auto' }}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
              gap: 2,
            }}
          >
            <Box>
              <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 0.5 }}>当前版本</Typography>
              {previewResolved && <ArtifactRenderer artifact={previewResolved} header={false} />}
            </Box>
            <Box>
              <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 0.5 }}>
                {compare?.bLabel}
              </Typography>
              {compare &&
                (() => {
                  const resolved = resolveVersion(compare.bHash);
                  return resolved ? <ArtifactRenderer artifact={resolved} header={false} /> : null;
                })()}
            </Box>
          </Box>
        </Box>
      </Dialog>
    </>
  );
}

/**
 * 产物列表行。
 *
 * 文件产物用扩展名角标 + 体积 / 变更信息（与消息底部卡片同源）；
 * 富产物沿用类型图标 + 版本徽章。两者共用一套行高与悬停反馈。
 */
function ArtifactRow({
  artifact,
  changes,
  version,
  onOpen,
  onLocate,
}: {
  artifact: Artifact;
  changes: number;
  version: number;
  onOpen: () => void;
  onLocate: () => void;
}) {
  const file = isFileArtifact(artifact);
  const name = artifact.title?.trim() || artifact.path || artifact.id;
  const metaParts: string[] = [];
  if (file) {
    const size = formatBytes(artifact.size);
    if (size) metaParts.push(size);
    metaParts.push(artifact.change === 'modified' ? '已修改' : '新建');
  } else {
    metaParts.push(ARTIFACT_TYPE_LABELS[artifact.type] ?? artifact.type);
  }
  if (changes > 0) metaParts.push(`${changes} 次变更`);

  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label={`打开产物 ${name}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 0.75,
        py: 0.6,
        borderRadius: 1,
        cursor: 'pointer',
        '&:hover': { bgcolor: 'action.hover' },
        '&:hover .artifact-row-action': { opacity: 1 },
      }}
    >
      {file ? <FileIcon name={name} size={22} radius={5} /> : artifactIcon(artifact.type)}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography noWrap sx={{ fontSize: 12.5, color: 'text.primary', lineHeight: 1.35 }}>
          {name}
        </Typography>
        <Typography noWrap sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.35 }}>
          {metaParts.join(' · ')}
        </Typography>
      </Box>
      {version > 1 && (
        <Typography sx={{ fontSize: 10.5, color: 'secondary.main', flexShrink: 0 }}>
          v{version}
        </Typography>
      )}
      <Tooltip title="定位到消息" placement="left">
        <IconButton
          className="artifact-row-action"
          size="small"
          aria-label={`定位到消息 ${name}`}
          sx={{ p: 0.4, opacity: 0, transition: 'opacity .15s' }}
          onClick={(e) => {
            e.stopPropagation();
            onLocate();
          }}
        >
          <ChevronRightIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Tooltip>
    </Box>
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