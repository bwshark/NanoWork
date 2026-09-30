import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
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
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RestoreIcon from '@mui/icons-material/Restore';
import VisibilityIcon from '@mui/icons-material/Visibility';
import CloseIcon from '@mui/icons-material/Close';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import AddIcon from '@mui/icons-material/Add';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import LanguageIcon from '@mui/icons-material/Language';
import OpenInBrowserIcon from '@mui/icons-material/OpenInBrowser';
import ImageIcon from '@mui/icons-material/Image';
import MovieIcon from '@mui/icons-material/Movie';
import CodeIcon from '@mui/icons-material/Code';
import ArticleIcon from '@mui/icons-material/Article';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import { ArtifactRenderer } from '@/components/ArtifactRenderer';
import { FileIcon } from './FileIcon';
import { ArtifactPreviewBody } from './ArtifactPreviewBody';
import { WebFrame, WebUrlBar, toFileUrl, urlHostLabel } from './WebTabView';
import type { WebTab } from './WebTabView';
import { useArtifactActions } from './useArtifactActions';
import { toast } from '@/components/Toast';
import { UNBOUND_AGENT_LABEL } from '@/lib/constants';
import { changeCountOf, formatBytes, isFileArtifact, isHtmlArtifact } from '@/lib/fileArtifact';
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
/** 有标签页时的默认宽度：正文（尤以代码为中心）在 300px 里几乎不可读 */
const PREVIEW_PANEL_WIDTH = 460;
/** 拖宽下限：再窄连文件名与代码行都保不住 */
const MIN_PANEL_WIDTH = 260;
/** 拖宽上限：给主内容区留出呼吸空间 */
const MAX_PANEL_WIDTH = 1000;
/** 拖宽时主内容区至少保留的宽度，避免把对话挤没 */
const MIN_CONTENT_WIDTH = 320;
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
 * - **标签栏**（常驻）：已打开的产物各占一个标签，可切换 / 关闭 / 全部关闭，
 *   左侧 ☰ 回到产物列表——列表与标签并存，因此点开第二个产物不会顶掉第一个；
 * - **列表视图**：概览（会话元信息）+ 产物（文件产物用扩展名角标 + 名称 + 体积，
 *   富产物用类型图标；超出折叠阈值收进「展开更多」）；
 * - **正文视图**：由「点消息里的产物卡片」或点列表行进进入，正文就地渲染
 *   （文件产物快照为空时按需回读磁盘），并保留版本历史 / 对比 / 回退。
 * - **宽度可拖**：左边缘 6px 抓手（hover 变 `col-resize`），拖到多宽看正文由用户定。
 *
 * 预览做成**面板内的一态**而不是弹窗：产品要求「点卡片 → 在右侧侧边栏打开预览」，
 * 弹窗会盖住对话流，恰好违背这条路径的意图。
 */
export function ArtifactPanel() {
  const open = useSessionUiStore((s) => s.artifactPanelOpen);
  const sessionId = useSessionUiStore((s) => s.artifactPanelSessionId);
  const closePanel = useSessionUiStore((s) => s.closeArtifactPanel);
  const tabs = useSessionUiStore((s) => s.artifactPanelTabs);
  const activeTabId = useSessionUiStore((s) => s.artifactPanelActiveTabId);
  const openTab = useSessionUiStore((s) => s.openArtifactTab);
  const activateTab = useSessionUiStore((s) => s.activateArtifactTab);
  const closeTab = useSessionUiStore((s) => s.closeArtifactTab);
  const closeAllTabs = useSessionUiStore((s) => s.closeAllArtifactTabs);
  const showList = useSessionUiStore((s) => s.showArtifactList);
  const openWebTab = useSessionUiStore((s) => s.openWebTab);
  const fullscreen = useSessionUiStore((s) => s.artifactPanelFullscreen);
  const toggleFullscreen = useSessionUiStore((s) => s.toggleArtifactPanelFullscreen);
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

  // ── 宽度可拖 ──
  // `null` = 用户没拖过，跟随默认宽度（列表态窄、有标签时宽）；
  // 一旦拖过就固定住，不再随「有没有标签」跳变——用户手动定的宽度比默认值更可信
  /**
   * 网页标签的刷新计数：地址没变，只能靠换 `key` 让 iframe 重新加载。
   * 状态放在面板层（而不是地址栏 / iframe 各自一份）——按钮在一行、iframe 在另一行，
   * 两份 state 就点不动了。
   */
  const [webReloadKey, setWebReloadKey] = useState(0);
  const [width, setWidth] = useState<number | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const effectiveWidth = width ?? (tabs.length > 0 ? PREVIEW_PANEL_WIDTH : PANEL_WIDTH);

  const clampWidth = (value: number) => {
    // 上限同时受「绝对上限」与「主内容区最小保留宽度」约束；小窗口下后者可能小于
    // 下限，此时取下限（宁可挤主内容区也不能把面板拖成一条线）
    const maxByViewport = Math.max(MIN_PANEL_WIDTH, window.innerWidth - MIN_CONTENT_WIDTH);
    return Math.max(MIN_PANEL_WIDTH, Math.min(value, Math.min(MAX_PANEL_WIDTH, maxByViewport)));
  };

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: effectiveWidth };
    // 指针捕获：拖出抓手范围（甚至拖到 iframe 上）也不会丢事件
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
  };

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 面板贴着窗口右边：指针往左拖 = 变宽，故用 startX - clientX
    setWidth(clampWidth(drag.startWidth + (drag.startX - e.clientX)));
  };

  const onResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  };

  /** 拖动期间禁掉文本选中与默认光标，否则会拖出一片蓝色选区 */
  useEffect(() => {
    if (!dragging) return;
    const prevSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.body.style.userSelect = prevSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging]);

  /**
   * 全屏时 ESC 退出。
   *
   * 全屏会把面板铺满整个窗口（含自绘标题栏），鼠标只剩「退出全屏」按钮一条路，
   * 键盘必须也能退得出去。
   */
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleFullscreen();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen, toggleFullscreen]);

  /** 当前激活的标签；为 null / 指向已失效的产物时面板处于列表视图 */
  const activeTab = useMemo(
    () => (activeTabId ? (tabs.find((t) => t.id === activeTabId) ?? null) : null),
    [tabs, activeTabId],
  );

  /** 当前激活的产物标签对应的产物（产物被收回 / 换会话残留 → null） */
  const activeArtifact = useMemo(
    () =>
      activeTab?.kind === 'artifact'
        ? (artifacts.find((a) => a.id === activeTab.id) ?? null)
        : null,
    [activeTab, artifacts],
  );

  /** 当前激活的网页标签（自带地址栏，占满第二行以下） */
  const activeWebTab = activeTab?.kind === 'web' ? activeTab : null;

  const isPreviewing = !!activeArtifact || !!activeWebTab;
  const entry = activeArtifact ? index[activeArtifact.id] : undefined;

  /**
   * 预览正文：按索引里的 `contentHash` 从内容池回填。
   *
   * `versionHash` 非空表示用户在版本历史里点了「预览此版本」，此时改用它回填；
   * 池里没有该版本正文（改写类产品不存快照）则回落内联 content（空串），
   * 由 `ArtifactPreviewBody` 决定是否回读磁盘。
   */
  const previewResolved = useMemo(() => {
    if (!activeArtifact) return null;
    if (versionHash) {
      return { ...activeArtifact, content: resolveArtifactContent(versionHash, bodies, '') };
    }
    const hash = index[activeArtifact.id]?.contentHash;
    const content = hash
      ? resolveArtifactContent(hash, bodies, activeArtifact.content)
      : activeArtifact.content;
    return { ...activeArtifact, content };
  }, [activeArtifact, versionHash, index, bodies]);

  /** 版本列表：优先用 `versions` 完整历史，旧数据（无 `versions`）退化为单版本 */
  const versionList = useMemo(() => {
    if (!entry) return [];
    if (Array.isArray(entry.versions) && entry.versions.length > 0) return entry.versions;
    return [
      { version: entry.version ?? 1, contentHash: entry.contentHash, createdAt: entry.createdAt, title: entry.title },
    ];
  }, [entry]);

  // 换标签必须清掉上一个产物的版本态：历史预览 / 对比目标都是**产物私有**的，
  // 留着会串到当前标签上（最典型的是对比弹窗里出现另一个文件的正文）
  useEffect(() => {
    setVersionHash(null);
    setCompare(null);
    setVersionOpen(false);
  }, [activeTabId]);

  /** 把某版本的 `contentHash` 还原成可渲染的 `Artifact`（正文从内容池回填） */
  const resolveVersion = (hash: string, title?: string) => {
    if (!activeArtifact) return null;
    return {
      ...activeArtifact,
      content: resolveArtifactContent(hash, bodies, ''),
      title: title ?? activeArtifact.title,
    };
  };

  /** FR-7.4 回退：把当前产物恢复到历史版本的正文（新开一版，旧正文仍留内容池） */
  const onRollback = (v: { version: number; contentHash: string; title?: string }) => {
    if (!activeArtifact) return;
    useArtifactsStore.getState().rollbackToVersion(activeArtifact.id, v.contentHash, v.title);
    setVersionHash(null);
    toast.success(`已回退到 v${v.version}，并新增当前版本`);
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

  /**
   * html 产物 → 网页标签。
   *
   * 正文来源决定打开方式：
   * - 有磁盘路径且跑在桌面端 → `file://`：读到的是**磁盘最新内容**，比写入时的快照准；
   * - 否则退回正文快照（围栏 html 只有快照；Web 端也加载不了 `file://`）。
   */
  const openInWebTab = (artifact: Artifact) => {
    const label = artifact.title?.trim() || artifact.path || '未命名';
    const fileUrl = artifact.path ? toFileUrl(artifact.path) : '';
    if (fileUrl !== '' && platform.env === 'electron') {
      openWebTab({ url: fileUrl, label });
      return;
    }
    if (artifact.content !== '') {
      openWebTab({ doc: artifact.content, label });
      return;
    }
    toast.warning('这个 html 产物没有可渲染的正文快照');
  };

  /** 折叠/展开全部分组 */
  const toggleAll = () => {
    const next = !(overviewOpen && artifactsOpen);
    setOverviewOpen(next);
    setArtifactsOpen(next);
  };

  const activeTitle = activeArtifact?.title?.trim() || activeArtifact?.path || activeArtifact?.id || '';

  return (
    <>
      <Box
        sx={{
          // 全屏 = 铺满整个窗口（连自绘标题栏一起盖住）。只换定位、**不换 DOM 结构**：
          // 重建会让网页标签的 iframe 白屏重载、产物正文的滚动位置全丢
          ...(fullscreen
            ? {
                position: 'fixed',
                inset: 0,
                width: '100%',
                zIndex: (theme) => theme.zIndex.modal + 1,
              }
            : {
                position: 'relative',
                width: effectiveWidth,
                borderLeft: '1px solid',
                borderColor: 'divider',
              }),
          flexShrink: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.paper',
          // 拖动中不挂过渡，否则宽度会跟不上指针（表现为「粘手」）
          transition: dragging ? 'none' : 'width .18s ease',
          // 拖动中把内容的指针事件全关掉：正文里的 `iframe` 是**独立文档**，
          // 指针划过时会把 pointermove 从抓手手里接走 → 拖到一半就卡住
          // （抓手自己用 `pointerEvents: 'auto'` 顶回来）
          ...(dragging ? { pointerEvents: 'none' } : {}),
        }}
      >
        {/* 左边缘拖宽抓手：压在 borderLeft 上，hover / 拖动时点亮一条 2px 竖线。
            全屏时面板已铺满窗口，没有「边缘」可拖，抓手一并撤掉 */}
        {!fullscreen && (
        <Box
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整产物面板宽度"
          // 宽度值挂在 separator 上：屏幕阅读器能读到当前宽度，测试也据此断言拖拽生效
          aria-valuenow={Math.round(effectiveWidth)}
          aria-valuemin={MIN_PANEL_WIDTH}
          aria-valuemax={MAX_PANEL_WIDTH}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          sx={{
            position: 'absolute',
            left: -3,
            top: 0,
            bottom: 0,
            width: 6,
            zIndex: 3,
            cursor: 'col-resize',
            touchAction: 'none',
            // 父级在拖动中关掉了指针事件，抓手指的是自己这一小块，要顶回来
            pointerEvents: 'auto',
            '&:hover .artifact-panel-resizer': { opacity: 1 },
            ...(dragging ? { '& .artifact-panel-resizer': { opacity: 1 } } : {}),
          }}
        >
          <Box
            className="artifact-panel-resizer"
            sx={{
              position: 'absolute',
              left: 2,
              top: 0,
              bottom: 0,
              width: 2,
              bgcolor: 'primary.main',
              opacity: 0,
              transition: 'opacity .12s',
            }}
          />
        </Box>
        )}

        {/* 第一行：常驻标签栏（☰ 产物列表 + 标签 + 新建 / 关闭全部 / 全屏 / 收起面板） */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            px: 0.75,
            py: 0.5,
            flexShrink: 0,
          }}
        >
          <Tooltip title="产物列表" placement="bottom">
            <IconButton
              size="small"
              aria-label="产物列表"
              onClick={showList}
              sx={{ p: 0.4, ...(isPreviewing ? { color: 'text.secondary' } : { color: 'primary.main' }) }}
            >
              <MenuIcon sx={{ fontSize: 17 }} />
            </IconButton>
          </Tooltip>

          <Box
            role="tablist"
            aria-label="已打开的标签"
            sx={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              overflowX: 'auto',
              // 横向滚动条压到最细：标签栏本身很矮，默认滚动条会顶掉一行
              scrollbarWidth: 'thin',
              '&::-webkit-scrollbar': { height: 3 },
              '&::-webkit-scrollbar-thumb': { bgcolor: 'divider', borderRadius: 2 },
            }}
          >
            {tabs.map((tab) => {
              const active = tab.id === activeTabId;
              if (tab.kind === 'web') {
                return (
                  <WebTabChip
                    key={tab.id}
                    tab={tab}
                    active={active}
                    onSelect={() => activateTab(tab.id)}
                    onClose={() => closeTab(tab.id)}
                  />
                );
              }
              const artifact = artifacts.find((a) => a.id === tab.id);
              // 产物被收回 / 换会话残留的 id：这一格不渲染（激活项自然回落到列表）
              if (!artifact) return null;
              const label = artifact.title?.trim() || artifact.path || artifact.id;
              return (
                <ArtifactTab
                  key={tab.id}
                  label={label}
                  artifact={artifact}
                  active={active}
                  onSelect={() => activateTab(tab.id)}
                  onClose={() => closeTab(tab.id)}
                />
              );
            })}
          </Box>

          {/* 「+ 新建标签页」：开一个空白网页标签（地址栏 + iframe） */}
          <Tooltip title="新建标签页" placement="bottom">
            <IconButton
              size="small"
              aria-label="新建标签页"
              sx={{ p: 0.4 }}
              onClick={() => openWebTab()}
            >
              <AddIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          {tabs.length > 1 && (
            <Tooltip title="关闭全部标签" placement="bottom">
              <IconButton size="small" aria-label="关闭全部标签" sx={{ p: 0.4 }} onClick={closeAllTabs}>
                <ClearAllIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={fullscreen ? '退出全屏' : '进入全屏'} placement="bottom">
            <IconButton
              size="small"
              aria-label={fullscreen ? '退出全屏' : '进入全屏'}
              sx={{ p: 0.4 }}
              onClick={toggleFullscreen}
            >
              {fullscreen ? (
                <CloseFullscreenIcon sx={{ fontSize: 16 }} />
              ) : (
                <OpenInFullIcon sx={{ fontSize: 16 }} />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip title="收起产物面板" placement="bottom">
            <IconButton size="small" aria-label="收起产物面板" sx={{ p: 0.4 }} onClick={closePanel}>
              <ViewSidebarIcon sx={{ fontSize: 16, transform: 'scaleX(-1)' }} />
            </IconButton>
          </Tooltip>
        </Box>

        {/* 第二行：随态切换（网页标签 = 地址栏；正文态 = 产物名 + 文件动作；列表态 = 会话名 + 打开工作空间） */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, px: 1, pb: 0.6, flexShrink: 0 }}>
          {activeWebTab ? (
            <WebUrlBar tab={activeWebTab} onReload={() => setWebReloadKey((k) => k + 1)} />
          ) : activeArtifact ? (
            <>
              <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, px: 0.5 }}>
                {activeTitle}
              </Typography>
              {isHtmlArtifact(activeArtifact) && (
                <Tooltip title="在网页标签打开" placement="bottom">
                  <IconButton
                    size="small"
                    aria-label="在网页标签打开"
                    sx={{ p: 0.4 }}
                    // 用**回填过正文**的引用：文件产物入库时 `content` 是空的（正文在内容池），
                    // 直接传 activeArtifact 会拿到空串，网页标签只能白屏
                    onClick={() => openInWebTab(previewResolved ?? activeArtifact)}
                  >
                    <OpenInBrowserIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title="在资源管理器打开" placement="bottom">
                <IconButton
                  size="small"
                  aria-label="在资源管理器打开"
                  sx={{ p: 0.4 }}
                  onClick={() => actions.reveal(activeArtifact)}
                >
                  <FolderOpenIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="复制路径" placement="bottom">
                <IconButton
                  size="small"
                  aria-label="复制路径"
                  sx={{ p: 0.4 }}
                  onClick={() => actions.copyPath(activeArtifact)}
                >
                  <ContentCopyIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            </>
          ) : (
            <>
              <Tooltip title="折叠 / 展开全部分组" placement="bottom">
                <IconButton
                  size="small"
                  aria-label="折叠 / 展开全部分组"
                  sx={{ p: 0.4 }}
                  onClick={toggleAll}
                >
                  {overviewOpen && artifactsOpen ? (
                    <UnfoldLessIcon sx={{ fontSize: 16 }} />
                  ) : (
                    <UnfoldMoreIcon sx={{ fontSize: 16 }} />
                  )}
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
                <IconButton
                  size="small"
                  aria-label="在资源管理器打开工作空间"
                  sx={{ p: 0.4 }}
                  onClick={() => void openWorkspace()}
                >
                  <OpenInNewIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </>
          )}
        </Box>
        <Divider />

        {activeWebTab ? (
          /* ── 网页态（地址栏在上面的第二行，这里只剩页面本体） ── */
          <WebFrame tab={activeWebTab} reloadKey={webReloadKey} />
        ) : activeArtifact ? (
          /* ── 正文态 ── */
          <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <Box sx={{ px: 1.25, pt: 1 }}>
              {activeArtifact.path && (
                <Tooltip title={activeArtifact.path} enterDelay={600}>
                  <Typography noWrap sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                    {activeArtifact.path}
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
                          opened={tabs.some((t) => t.kind === 'artifact' && t.id === a.id)}
                          onOpen={() => openTab(a.id)}
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
            {activeArtifact ? shortTime(activeArtifact.createdAt) : ''}
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
 * 标签栏里的一个产物标签。
 *
 * 用 `role="tab"` 而非 `<button>`：里面还要放一个关闭按钮，`button` 套 `button`
 * 是非法 HTML（浏览器会拆掉内层节点）。回车 / 空格同样可选中，键盘可用性不降级。
 */
function ArtifactTab({
  label,
  artifact,
  active,
  onSelect,
  onClose,
}: {
  label: string;
  artifact: Artifact;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const file = isFileArtifact(artifact);
  return (
    <Box
      role="tab"
      tabIndex={0}
      aria-selected={active}
      aria-label={`切换到产物 ${label}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.4,
        pl: 0.75,
        pr: 0.25,
        py: 0.3,
        borderRadius: 1.25,
        flexShrink: 0,
        maxWidth: 168,
        cursor: 'pointer',
        bgcolor: active ? 'action.selected' : 'transparent',
        color: active ? 'text.primary' : 'text.secondary',
        '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover' },
        // 关闭按钮平时藏着，hover / 激活时才显现（标签多起来时不至于满眼 ×）
        '&:hover .artifact-tab-close': { opacity: 1 },
      }}
    >
      {file ? <FileIcon name={label} size={14} radius={3} /> : artifactIcon(artifact.type)}
      <Typography noWrap sx={{ fontSize: 12, minWidth: 0 }}>
        {label}
      </Typography>
      <IconButton
        className="artifact-tab-close"
        size="small"
        aria-label={`关闭标签 ${label}`}
        sx={{ p: 0.2, opacity: active ? 0.75 : 0, transition: 'opacity .12s' }}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <CloseIcon sx={{ fontSize: 13 }} />
      </IconButton>
    </Box>
  );
}

/**
 * 标签栏里的一个**网页**标签（「+ 新建标签页」开出来的）。
 *
 * 地址还空着时不显示文字、只留地球图标 —— 这正是参考稿里那个空白新标签的样子；
 * 有地址后显示主机名（整条 URL 塞进 168px 只会被截成 `https://exa…`，更没用）。
 */
function WebTabChip({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: WebTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  // 产物预览标签用产物名（比 `file:///D:/aa/...` 好读）；手输地址用主机名；都没有 = 空白新标签
  const label = tab.label ?? (tab.url === '' ? '' : urlHostLabel(tab.url));
  const name = label === '' ? '新标签页' : label;
  return (
    <Box
      role="tab"
      tabIndex={0}
      aria-selected={active}
      aria-label={`切换到标签页 ${name}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.4,
        pl: 0.75,
        pr: 0.25,
        py: 0.3,
        borderRadius: 1.25,
        flexShrink: 0,
        maxWidth: 168,
        cursor: 'pointer',
        bgcolor: active ? 'action.selected' : 'transparent',
        color: active ? 'text.primary' : 'text.secondary',
        '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover' },
        '&:hover .artifact-tab-close': { opacity: 1 },
      }}
    >
      <LanguageIcon sx={{ fontSize: 15 }} />
      {label !== '' && (
        <Typography noWrap sx={{ fontSize: 12, minWidth: 0 }}>
          {label}
        </Typography>
      )}
      <IconButton
        className="artifact-tab-close"
        size="small"
        aria-label={`关闭标签页 ${name}`}
        sx={{ p: 0.2, opacity: active ? 0.75 : 0, transition: 'opacity .12s' }}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <CloseIcon sx={{ fontSize: 13 }} />
      </IconButton>
    </Box>
  );
}

/**
 * 产物列表行。
 *
 * 文件产物用扩展名角标 + 体积 / 变更信息（与消息底部卡片同源）；
 * 富产物沿用类型图标 + 版本徽章。两者共用一套行高与悬停反馈。
 * `opened` 标记该产物已在标签栏打开（背景点亮），避免重复点开才发现。
 */
function ArtifactRow({
  artifact,
  changes,
  version,
  opened,
  onOpen,
  onLocate,
}: {
  artifact: Artifact;
  changes: number;
  version: number;
  opened: boolean;
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
      aria-current={opened ? 'true' : undefined}
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
        bgcolor: opened ? 'action.selected' : 'transparent',
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
