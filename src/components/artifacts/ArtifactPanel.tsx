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
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RestoreIcon from '@mui/icons-material/Restore';
import VisibilityIcon from '@mui/icons-material/Visibility';
import OpenInBrowserIcon from '@mui/icons-material/OpenInBrowser';
import { ArtifactRenderer } from '@/components/ArtifactRenderer';
import { ArtifactPreviewBody } from './ArtifactPreviewBody';
import { WebFrame, WebUrlBar, toFileUrl } from './WebTabView';
import type { WebTab } from './WebTabView';
import { PanelTabBar } from './PanelTabBar';
import { NewTabPage } from './NewTabPage';
import { WorkspaceTreeView } from './WorkspaceTreeView';
import { ChangesView } from './ChangesView';
import { TerminalView } from './TerminalView';
import { FilePreviewView } from './FilePreviewView';
import { useArtifactActions } from './useArtifactActions';
import { toast } from '@/components/Toast';
import { UNBOUND_AGENT_LABEL } from '@/lib/core/constants';
import { isHtmlArtifact } from '@/lib/artifact/fileArtifact';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore, resolveArtifactContent } from '@/stores/artifactsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { useDefaultWorkspacePath } from '@/stores/storageInfoStore';
import { platform } from '@/platform';
import type { Artifact } from '@/types';

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

/** 未设置工作空间时的展示名（与侧边栏的默认分组名保持一致） */
const DEFAULT_WORKSPACE_LABEL = '默认工作空间';

/** 本地时间简写：MM-DD HH:mm */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 右侧边栏（会话级）。界面上一律称「右侧边栏」——它现在已经不只是产物面板：
 * 里面是**一个浏览器式的标签容器**，每个标签承载一种页面。
 *
 * 标签种类（与参考稿一致）：
 * - **新标签页**：会话概况 + 四个快捷入口 + 产物清单（打开面板时的落地页）；
 * - **文件**：工作空间目录树，点文件在面板内预览；
 * - **变更**：git 改动列表 + 单个文件的 diff；
 * - **终端**：面板内 PTY（xterm）；
 * - **产物 / 文件 / 网页**：产物正文、磁盘文件正文、外部网页。
 *
 * ## 快捷入口是「替换当前新标签页」，不是「再开一个标签」
 *
 * 参考稿里点「查看工作空间」后，那个写着「新标签页」的标签就地变成「文件」
 * ——标签数不变。这条规则落在 store 的 `openPage` 里（见 `sessionUiStore`），
 * 组件层只管调 action。
 *
 * ## 为什么网页 / 终端标签常驻挂载
 *
 * iframe 与 xterm 都不耐卸载：前者白屏重载、后者连滚动历史和正在跑的命令一起丢。
 * 所以这两类标签**全部保持挂载**，只切 `display`；其余页面按需渲染即可
 * （它们的状态要么在 store 里，要么每次挂载重读一次磁盘，代价可以接受）。
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
  const openWebTab = useSessionUiStore((s) => s.openWebTab);
  const openFilesTab = useSessionUiStore((s) => s.openFilesTab);
  const openChangesTab = useSessionUiStore((s) => s.openChangesTab);
  const openTerminalTab = useSessionUiStore((s) => s.openTerminalTab);
  const openFileTab = useSessionUiStore((s) => s.openFileTab);
  const openNewTab = useSessionUiStore((s) => s.openNewTab);
  const showList = useSessionUiStore((s) => s.showArtifactList);
  const fullscreen = useSessionUiStore((s) => s.artifactPanelFullscreen);
  const toggleFullscreen = useSessionUiStore((s) => s.toggleArtifactPanelFullscreen);

  const sessions = useSessionsStore((s) => s.sessions);
  const agents = useAgentsStore((s) => s.agents);
  const bySession = useArtifactsStore((s) => s.bySession);
  const bodies = useArtifactsStore((s) => s.bodies);
  const index = useArtifactsStore((s) => s.index);

  const session = useMemo(() => sessions.find((s) => s.id === sessionId), [sessions, sessionId]);
  const artifacts = useMemo(
    () => (sessionId ? (bySession[sessionId] ?? []) : []),
    [bySession, sessionId],
  );

  /**
   * 「默认工作空间」当前的真实落点。早期会话没有 `workdir`（那时还没有这个设置项），
   * 但它们发消息时同样会落到这个目录上——面板要显示真实落点，否则会出现
   * 「概览写着默认工作空间、文件却存在 <home>/NanoWork」的错位。
   */
  const defaultWorkspacePath = useDefaultWorkspacePath();
  const actions = useArtifactActions(sessionId ?? '');
  const workspaceRoot = session?.workdir?.trim() || defaultWorkspacePath || '';

  /** 产物正文态的版本历史：展开/收起 + 对比目标 + 正在预览的历史版本 */
  const [versionOpen, setVersionOpen] = useState(false);
  const [compare, setCompare] = useState<{ bHash: string; bLabel: string } | null>(null);
  const [versionHash, setVersionHash] = useState<string | null>(null);

  /**
   * 网页标签的刷新计数：地址没变，只能靠换 `key` 让 iframe 重新加载。
   * 状态放在面板层（而不是地址栏 / iframe 各自一份）——按钮在一行、iframe 在另一行，
   * 两份 state 就点不动了。
   */
  const [webReloadKey, setWebReloadKey] = useState(0);

  // ── 宽度可拖 ──
  // `null` = 用户没拖过，跟随默认宽度（列表态窄、有标签时宽）；
  // 一旦拖过就固定住，不再随「有没有标签」跳变——用户手动定的宽度比默认值更可信
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

  /**
   * 兜底：面板开着却一个标签都没有时，补一个「新标签页」。
   *
   * 正常路径（`openArtifactPanel` / `toggleArtifactPanel`）都会建好落地页，但
   * 会话状态被外部重置 / 旧持久化数据里标签为空时，面板会渲染出兜底列表页——
   * 而那个兜底页**不在标签数组里**，一旦点开一个产物就再也回不去了。
   * 这条 effect 把「兜底页」扶正成一个真正的标签。
   */
  useEffect(() => {
    if (open && tabs.length === 0) showList();
  }, [open, tabs.length, showList]);

  /** 当前激活的标签；`null`（会话刚切换 / 还没有标签）一律按「新标签页」渲染 */
  const activeTab = useMemo(
    () => (activeTabId ? (tabs.find((t) => t.id === activeTabId) ?? null) : null),
    [tabs, activeTabId],
  );

  /** 当前激活的产物标签对应的产物（产物被收回 / 换会话残留 → null） */
  const activeArtifact = useMemo(
    () => (activeTab?.kind === 'artifact' ? (artifacts.find((a) => a.id === activeTab.id) ?? null) : null),
    [activeTab, artifacts],
  );

  /** 当前激活的网页标签（自带地址栏，占满第二行以下） */
  const activeWebTab = activeTab?.kind === 'web' ? activeTab : null;

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
      {
        version: entry.version ?? 1,
        contentHash: entry.contentHash,
        createdAt: entry.createdAt,
        title: entry.title,
      },
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

  const activeTitle = activeArtifact?.title?.trim() || activeArtifact?.path || activeArtifact?.id || '';

  /** 需要跨切换保活的标签：网页（iframe）与终端（xterm + PTY） */
  const persistentTabs = tabs.filter((t) => t.kind === 'web' || t.kind === 'terminal');
  const activeIsPersistent = activeWebTab !== null || activeTab?.kind === 'terminal';
  /** 第二行（地址栏 / 产物动作）只在有内容时出现 */
  const showSecondRow = activeWebTab !== null || activeArtifact !== null;

  return (
    <>
      <Box
        sx={{
          // 全屏 = 铺满整个窗口（连自绘标题栏一起盖住）。只换定位、**不换 DOM 结构**：
          // 重建会让网页标签的 iframe 白屏重载、终端里的 shell 会话全断
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
            aria-label="拖动调整右侧边栏宽度"
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

        <PanelTabBar
          tabs={tabs}
          activeId={activeTabId}
          artifacts={artifacts}
          onActivate={activateTab}
          onClose={closeTab}
          onNewTab={openNewTab}
          fullscreen={fullscreen}
          onToggleFullscreen={toggleFullscreen}
          onClosePanel={closePanel}
        />

        {/* 第二行：网页地址栏 / 产物名与动作。
            其余页面（新标签页 / 文件 / 变更 / 终端）不需要它——它们自带内容头部，
            多一行空壳只会把内容区压矮。 */}
        {showSecondRow && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, px: 1, py: 0.5, flexShrink: 0 }}>
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
            ) : null}
          </Box>
        )}

        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* 网页 / 终端：常驻挂载，只切显示 */}
          {persistentTabs.map((tab) => {
            const visible = tab.id === activeTabId;
            return (
              <Box
                key={tab.id}
                sx={{
                  display: visible ? 'flex' : 'none',
                  flex: 1,
                  minHeight: 0,
                  flexDirection: 'column',
                }}
              >
                {tab.kind === 'web' ? (
                  <WebFrame tab={tab as WebTab} reloadKey={webReloadKey} />
                ) : (
                  <TerminalView tabId={tab.id} cwd={workspaceRoot} active={visible} />
                )}
              </Box>
            );
          })}

          {/* 其余页面：只渲染当前那一个 */}
          {activeIsPersistent ? null : activeTab?.kind === 'files' ? (
            <WorkspaceTreeView root={workspaceRoot} onOpenFile={openFileTab} />
          ) : activeTab?.kind === 'changes' ? (
            <ChangesView root={workspaceRoot} />
          ) : activeTab?.kind === 'file' ? (
            <FilePreviewView path={activeTab.path} name={activeTab.name} />
          ) : activeArtifact ? (
            /* ── 产物正文态 ── */
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
                              <Tooltip title={hasBody ? '预览此版本' : '该版本未捕获正文'} placement="bottom">
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
                                  onClick={() => setCompare({ bHash: v.contentHash, bLabel: `v${v.version}` })}
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
            /* ── 新标签页（也是 `activeTabId === null` 的兜底页）── */
            <NewTabPage
              artifacts={artifacts}
              openedIds={tabs.filter((t) => t.kind === 'artifact').map((t) => t.id)}
              onOpenBrowser={() => openWebTab()}
              onOpenFiles={openFilesTab}
              onOpenChanges={openChangesTab}
              onOpenTerminal={openTerminalTab}
              onOpenArtifact={openTab}
              onLocate={(artifact) => actions.locate(artifact)}
              overviewRows={overviewRows}
            />
          )}
        </Box>
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
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
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
        px: 0.5,
        py: 0.6,
        borderRadius: 1,
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
