import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import ViewSidebarIcon from '@mui/icons-material/ViewSidebar';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import DifferenceIcon from '@mui/icons-material/Difference';
import TerminalIcon from '@mui/icons-material/Terminal';
import LanguageIcon from '@mui/icons-material/Language';
import ArticleIcon from '@mui/icons-material/Article';
import { LogoIcon } from '@/components/LogoIcon';
import { FileIcon } from './FileIcon';
import { ArtifactTypeIcon } from './ArtifactTypeIcon';
import { urlHostLabel } from './WebTabView';
import { isFileArtifact } from '@/lib/artifact/fileArtifact';
import type { Artifact } from '@/types';
import type { ArtifactPanelTab } from '@/stores/sessionUiStore';

/**
 * 标签栏（浏览器式）。
 *
 * 参考稿的形状是「一排可关闭的标签 + 紧随其后的 +，右侧两个工具图标」：
 * 标签是**填充式**的（激活项底色更亮、圆角、无边框），而不是下划线 tab。
 * 这样在窄面板里也能一眼分出「当前在看哪一个」，代价是标签文字必须短
 * （所以标签名一律取文件名 / 主机名，不取全路径）。
 */

/** 一个标签的可读名与图标（网页 / 文件 / 产物三类各有自己的取名规则） */
function describeTab(tab: ArtifactPanelTab, artifacts: readonly Artifact[]): {
  label: string;
  icon: React.ReactNode;
  aria: string;
} {
  switch (tab.kind) {
    case 'list':
      return {
        label: '新标签页',
        // 参考稿这里放的是应用自己的标记（一个圆角方块里的 logo），不是通用图标：
        // 「新标签页」是这个产品的落地页，用地球 / 文档都不对味
        icon: (
          <Box
            aria-hidden
            sx={{
              width: 17,
              height: 17,
              borderRadius: '5px',
              border: '1px solid',
              borderColor: 'divider',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: 'text.secondary',
            }}
          >
            <LogoIcon size={10} />
          </Box>
        ),
        aria: '新标签页',
      };
    case 'files':
      return { label: '文件', icon: <FolderOpenIcon sx={{ fontSize: 15 }} />, aria: '工作空间' };
    case 'changes':
      return { label: '变更', icon: <DifferenceIcon sx={{ fontSize: 15 }} />, aria: '变更' };
    case 'terminal':
      return { label: tab.title, icon: <TerminalIcon sx={{ fontSize: 15 }} />, aria: '终端' };
    case 'file':
      return {
        label: tab.name,
        icon: <FileIcon name={tab.name} size={15} radius={3} />,
        aria: `文件 ${tab.name}`,
      };
    case 'web': {
      // 产物预览标签用产物名（比 `file:///D:/aa/...` 好读）；手输地址用主机名。
      // 空地址叫「浏览器」而不是「新标签页」：后者是左边那个落地页的名字，
      // 两个标签同名会让人分不清哪个能打字
      const label = tab.label ?? (tab.url === '' ? '' : urlHostLabel(tab.url));
      const name = label === '' ? '浏览器' : label;
      return {
        label: name,
        icon: <LanguageIcon sx={{ fontSize: 15 }} />,
        aria: `标签页 ${name}`,
      };
    }
    case 'artifact': {
      const artifact = artifacts.find((a) => a.id === tab.id);
      const name = artifact?.title?.trim() || artifact?.path || '产物';
      return {
        label: name,
        icon: artifact ? (
          isFileArtifact(artifact) ? (
            <FileIcon name={name} size={15} radius={3} />
          ) : (
            <ArtifactTypeIcon type={artifact.type} />
          )
        ) : (
          <ArticleIcon sx={{ fontSize: 15 }} />
        ),
        aria: `产物 ${name}`,
      };
    }
  }
}

export interface PanelTabBarProps {
  tabs: readonly ArtifactPanelTab[];
  activeId: string | null;
  /** 产物标签的取名与图标来源 */
  artifacts: readonly Artifact[];
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /** 「+」：追加一个空白新标签页 */
  onNewTab: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClosePanel: () => void;
}

export function PanelTabBar({
  tabs,
  activeId,
  artifacts,
  onActivate,
  onClose,
  onNewTab,
  fullscreen,
  onToggleFullscreen,
  onClosePanel,
}: PanelTabBarProps) {
  const iconBtn = { p: 0.4 } as const;

  return (
    <Box
      role="tablist"
      aria-label="已打开的标签"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1,
        height: 46,
        flexShrink: 0,
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          // 标签多了横向滚动，但不常驻滚动条：滚动条会顶掉标签的垂直居中
          minWidth: 0,
          overflowX: 'auto',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { height: 0 },
          // 标签区按内容取宽（单个标签时「+」就紧跟在它后面，与参考稿一致），
          // 空间不够时整体收缩，再不够就横向滚动
          flex: '0 1 auto',
        }}
      >
        {tabs.map((tab) => {
          const { label, icon, aria } = describeTab(tab, artifacts);
          const active = tab.id === activeId;
          return (
            <Box
              key={tab.id}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              aria-label={`切换到${aria}`}
              onClick={() => onActivate(tab.id)}
              onKeyDown={(e) => {
                // role="tab" 里的关闭按钮是嵌套的可聚焦元素，所以选中语义只能自己做
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onActivate(tab.id);
                }
              }}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                pl: 1.25,
                pr: 0.5,
                height: 32,
                borderRadius: '8px',
                // 标签的「理想宽度」是 360（参考稿里它占面板宽度的六成左右），
                // 面板窄 / 标签多的时候按比例收缩，到 104 就不再缩（改横向滚动）
                width: 360,
                minWidth: 104,
                flexShrink: 1,
                cursor: 'pointer',
                userSelect: 'none',
                bgcolor: active ? 'action.selected' : 'transparent',
                color: active ? 'text.primary' : 'text.secondary',
                transition: 'background-color .12s',
                '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover' },
                // 关闭按钮平时藏着，hover / 激活才显现：标签多起来时不至于满眼 ×
                '&:hover .panel-tab-close': { opacity: 0.9 },
              }}
            >
              <Box sx={{ display: 'flex', flexShrink: 0, color: active ? 'inherit' : 'text.secondary' }}>
                {icon}
              </Box>
              <Typography
                noWrap
                sx={{ fontSize: 12.5, fontWeight: active ? 600 : 400, minWidth: 0, flex: 1 }}
              >
                {label}
              </Typography>
              <IconButton
                className="panel-tab-close"
                size="small"
                aria-label={`关闭${aria}`}
                sx={{
                  p: 0.2,
                  flexShrink: 0,
                  opacity: active ? 0.9 : 0,
                  transition: 'opacity .12s',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <CloseIcon sx={{ fontSize: 13 }} />
              </IconButton>
            </Box>
          );
        })}
      </Box>

      {/* 「+」放在滚动区**外面**：标签多到要横向滚动时，新建入口不能被一起滚走
          （被滚走的 + 等于这个面板再也开不出新标签） */}
      <Tooltip title="新建标签页" placement="bottom">
        <IconButton
          size="small"
          aria-label="新建标签页"
          sx={{ ...iconBtn, flexShrink: 0 }}
          onClick={onNewTab}
        >
          <AddIcon sx={{ fontSize: 19 }} />
        </IconButton>
      </Tooltip>

      {/* 中间留白：右侧两个工具图标属于「面板级」，靠右对齐，不与标签挤在一起 */}
      <Box sx={{ flex: 1, minWidth: 8 }} />

      <Tooltip title={fullscreen ? '退出全屏' : '进入全屏'} placement="bottom">
        <IconButton
          size="small"
          aria-label={fullscreen ? '退出全屏' : '进入全屏'}
          sx={iconBtn}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? (
            <CloseFullscreenIcon sx={{ fontSize: 17 }} />
          ) : (
            <OpenInFullIcon sx={{ fontSize: 17 }} />
          )}
        </IconButton>
      </Tooltip>
      <Tooltip title="收起右侧边栏" placement="bottom">
        <IconButton size="small" aria-label="收起右侧边栏" sx={iconBtn} onClick={onClosePanel}>
          <ViewSidebarIcon sx={{ fontSize: 17, transform: 'scaleX(-1)' }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
