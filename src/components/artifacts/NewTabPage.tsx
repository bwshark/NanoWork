import { useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Button, Collapse, IconButton, Tooltip, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInBrowserIcon from '@mui/icons-material/OpenInBrowser';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import DifferenceIcon from '@mui/icons-material/Difference';
import TerminalIcon from '@mui/icons-material/Terminal';
import { FileIcon } from './FileIcon';
import { ArtifactTypeIcon } from './ArtifactTypeIcon';
import { isFileArtifact } from '@/lib/artifact/fileArtifact';
import type { Artifact } from '@/types';

/** 产物列表折叠阈值：超出部分收进「展开更多 (N)」 */
const COLLAPSED_LIMIT = 6;

/**
 * 「新标签页」——右栏的落地页。
 *
 * 参考稿把它做成浏览器的空白标签页：**内容居中、只有四行快捷入口 + 产物清单**，
 * 没有会话标题、没有筛选胶囊。这样打开面板的第一眼是「我能做什么」，
 * 而不是一屏元信息。
 *
 * 内容的垂直位置用 `my: 'auto'` 顶出来（内容少时落在中间，多了自然向上滚），
 * 不用固定 padding 猜高度——面板可以被拖到 260 也可能铺满全屏。
 */
export interface NewTabPageProps {
  artifacts: readonly Artifact[];
  /** 已在标签栏里打开的产物 id（行上加 `aria-current`，避免重复点开才发现） */
  openedIds?: readonly string[];
  /** 打开浏览器（网页标签） */
  onOpenBrowser: () => void;
  /** 查看工作空间（文件树标签） */
  onOpenFiles: () => void;
  /** 查看变更（git 变更标签） */
  onOpenChanges: () => void;
  /** 打开终端（面板内终端标签） */
  onOpenTerminal: () => void;
  /** 点产物行：在标签里预览 */
  onOpenArtifact: (artifactId: string) => void;
  /** 「定位到消息」（hover 显现的小箭头） */
  onLocate: (artifact: Artifact) => void;
  /** 会话概况的键值行（智能体 / 模型 / 消息数 …） */
  overviewRows: Array<{ label: string; value: string }>;
}

export function NewTabPage({
  artifacts,
  openedIds = [],
  onOpenBrowser,
  onOpenFiles,
  onOpenChanges,
  onOpenTerminal,
  onOpenArtifact,
  onLocate,
  overviewRows,
}: NewTabPageProps) {
  const [listExpanded, setListExpanded] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  const [overviewOpen, setOverviewOpen] = useState(false);

  const shown = listExpanded ? artifacts : artifacts.slice(0, COLLAPSED_LIMIT);
  const hidden = artifacts.length - shown.length;

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        px: 2,
        py: 2,
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 420, mx: 'auto', my: 'auto' }}>
        {/* ── 四行快捷入口 ── */}
        <Box>
          <QuickAction
            icon={<OpenInBrowserIcon sx={{ fontSize: 18 }} />}
            label="打开浏览器"
            onClick={onOpenBrowser}
          />
          <QuickAction
            icon={<FolderOpenIcon sx={{ fontSize: 18 }} />}
            label="查看工作空间"
            onClick={onOpenFiles}
          />
          <QuickAction
            icon={<DifferenceIcon sx={{ fontSize: 18 }} />}
            label="查看变更"
            onClick={onOpenChanges}
          />
          <QuickAction
            icon={<TerminalIcon sx={{ fontSize: 18 }} />}
            label="打开终端"
            onClick={onOpenTerminal}
          />
        </Box>

        {/* ── 产物 ── */}
        <Box
          role="button"
          tabIndex={0}
          aria-label={`产物分组（${artifacts.length}）`}
          aria-expanded={artifactsOpen}
          onClick={() => setArtifactsOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setArtifactsOpen((v) => !v);
            }
          }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            mt: 1.5,
            mb: 0.5,
            px: 0.5,
            py: 0.5,
            borderRadius: 1,
            cursor: 'pointer',
            color: 'text.secondary',
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          {/* 参考稿这里不是加粗分组标题，而是一行小号灰字 + 细箭头：
              它是个「可折叠的区段标注」，不该和内容抢注意力 */}
          <Typography sx={{ fontSize: 12, fontWeight: 500 }}>
            产物 ({artifacts.length})
          </Typography>
          {artifactsOpen ? (
            <ExpandMoreIcon sx={{ fontSize: 14 }} />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 14 }} />
          )}
        </Box>

        <Collapse in={artifactsOpen} timeout={160} unmountOnExit>
          {artifacts.length === 0 ? (
            <EmptyHint>暂无产物。对话里写出的文件会自动出现在这里。</EmptyHint>
          ) : (
            <>
              {shown.map((artifact) => (
                <ArtifactRow
                  key={artifact.id}
                  artifact={artifact}
                  opened={openedIds.includes(artifact.id)}
                  onOpen={() => onOpenArtifact(artifact.id)}
                  onLocate={() => onLocate(artifact)}
                />
              ))}
              {hidden > 0 && (
                <Button
                  size="small"
                  onClick={() => setListExpanded(true)}
                  sx={{ textTransform: 'none', fontSize: 12, color: 'text.secondary', px: 0.5 }}
                >
                  展开更多 ({hidden})
                </Button>
              )}
              {listExpanded && artifacts.length > COLLAPSED_LIMIT && (
                <Button
                  size="small"
                  onClick={() => setListExpanded(false)}
                  sx={{ textTransform: 'none', fontSize: 12, color: 'text.secondary', px: 0.5 }}
                >
                  收起
                </Button>
              )}
            </>
          )}
        </Collapse>

        {/* ── 会话信息（默认收起）──
            参考稿里没有这一块。但「这个会话用的是哪个模型 / 消息几条 / 工作空间在哪」
            只在这里能看到，删掉就是丢功能，所以留一行灰字的入口，收起状态下不打扰版面。 */}
        <Box
          role="button"
          tabIndex={0}
          aria-label="会话信息"
          aria-expanded={overviewOpen}
          onClick={() => setOverviewOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOverviewOpen((v) => !v);
            }
          }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            mt: 1.5,
            px: 0.5,
            py: 0.5,
            borderRadius: 1,
            cursor: 'pointer',
            color: 'text.disabled',
            '&:hover': { bgcolor: 'action.hover' },
          }}
        >
          <Typography sx={{ fontSize: 11.5 }}>会话信息</Typography>
          {overviewOpen ? (
            <ExpandMoreIcon sx={{ fontSize: 13 }} />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 13 }} />
          )}
        </Box>
        <Collapse in={overviewOpen} timeout={160} unmountOnExit>
          <Box sx={{ px: 0.5, pb: 0.5 }}>
            {overviewRows.map((row) => (
              <Box key={row.label} sx={{ display: 'flex', gap: 1, py: 0.35 }}>
                <Typography sx={{ fontSize: 11.5, color: 'text.disabled', width: 62, flexShrink: 0 }}>
                  {row.label}
                </Typography>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
                  {row.value}
                </Typography>
              </Box>
            ))}
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <Typography sx={{ px: 0.5, py: 1, fontSize: 12, color: 'text.disabled', lineHeight: 1.6 }}>
      {children}
    </Typography>
  );
}

/**
 * 快捷入口行。
 *
 * 整行可点 + 键盘可达（Enter / Space）：这四行是「不需要先选产物」就能用的操作，
 * 只认鼠标等于把键盘用户挡在门外。
 */
function QuickAction({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 1.5,
        height: 46,
        cursor: 'pointer',
        borderBottom: '1px solid',
        borderColor: 'divider',
        color: 'text.primary',
        transition: 'background-color .12s',
        '&:last-of-type': { borderBottom: 'none' },
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <Box sx={{ color: 'text.secondary', display: 'flex', flexShrink: 0 }}>{icon}</Box>
      <Typography sx={{ fontSize: 13.5 }}>{label}</Typography>
    </Box>
  );
}

/**
 * 产物行：类型角标 + 文件名。
 *
 * 参考稿只画两样东西（图标 + 名称），体积 / 变更次数都不显示——那些信息在
 * 「产物」标签里点开就有，列表上堆 meta 会让每行都变成两行高。
 * 「定位到消息」留成 hover 才出现的箭头：它是列表里唯一的次要动作。
 */
function ArtifactRow({
  artifact,
  opened,
  onOpen,
  onLocate,
}: {
  artifact: Artifact;
  opened: boolean;
  onOpen: () => void;
  onLocate: () => void;
}) {
  const name = artifact.title?.trim() || artifact.path || artifact.id;
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
        height: 33,
        borderRadius: 1,
        cursor: 'pointer',
        bgcolor: opened ? 'action.hover' : 'transparent',
        '&:hover': { bgcolor: 'action.hover' },
        '&:hover .artifact-row-action': { opacity: 1 },
      }}
    >
      {isFileArtifact(artifact) ? (
        <FileIcon name={name} size={17} radius={4} />
      ) : (
        // 富产物（代码块 / 图 / 网页）没有扩展名可看，用类型图标区分
        <Box sx={{ display: 'flex', color: 'text.secondary', width: 17, justifyContent: 'center' }}>
          <ArtifactTypeIcon type={artifact.type} size={16} />
        </Box>
      )}
      <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'text.primary' }}>
        {name}
      </Typography>
      <Tooltip title="定位到消息" placement="left">
        <IconButton
          className="artifact-row-action"
          size="small"
          aria-label={`定位到消息 ${name}`}
          sx={{ p: 0.3, opacity: 0, transition: 'opacity .15s' }}
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
