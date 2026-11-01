import { useCallback, useEffect, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { FileIcon } from './FileIcon';
import { platform } from '@/platform';
import { formatBytes } from '@/lib/artifact/fileArtifact';
import type { WorkspaceEntry } from '@/platform/types';

/** 子目录 → 子项缓存；`undefined` 表示还没加载过 */
type ChildrenMap = Record<string, WorkspaceEntry[] | undefined>;

/** `root` + 一级名 → 绝对路径（Windows 上也用 `/`，Node 两种都吃） */
function joinPath(parent: string, name: string): string {
  return parent.endsWith('/') || parent.endsWith('\\') ? `${parent}${name}` : `${parent}/${name}`;
}

/**
 * 工作空间文件树（右栏「文件」标签）。
 *
 * ## 为什么按层懒加载
 *
 * 工作空间可能是几万个文件的仓库。一次递归读完既慢又白读（用户通常只看一层），
 * 所以每展开一个目录才 `workspaceListDir` 一次，并把结果缓存住——反复折叠展开
 * 不该再打一次 IPC。
 *
 * ## 为什么点文件是「面板内预览」而不是交给系统
 *
 * 用户点文件是**想看内容**。交给系统默认程序会把窗口切走（甚至切到 IDE 里，
 * 上下文全丢），这与「右栏是用来不离开会话看东西」的前提直接冲突。
 */
export function WorkspaceTreeView({
  root,
  onOpenFile,
}: {
  /** 工作空间根目录绝对路径；空串 = 这个会话还没绑定工作空间 */
  root: string;
  onOpenFile: (path: string, name: string) => void;
}) {
  const [children, setChildren] = useState<ChildrenMap>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState<Set<string>>(new Set());

  /** 读一层目录（已缓存则跳过） */
  const load = useCallback(async (dir: string) => {
    setLoading((prev) => new Set(prev).add(dir));
    const result = await platform.workspaceListDir(dir);
    setLoading((prev) => {
      const next = new Set(prev);
      next.delete(dir);
      return next;
    });
    if (!result.ok) {
      setError(result.error ?? '目录读取失败');
      setChildren((prev) => ({ ...prev, [dir]: [] }));
      return;
    }
    setError(null);
    setChildren((prev) => ({ ...prev, [dir]: result.entries }));
    if (result.truncated) setTruncated((prev) => new Set(prev).add(dir));
  }, []);

  // 换工作空间 / 首次打开：重置缓存并展开根
  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    setTruncated(new Set());
    setError(null);
    if (root !== '') void load(root);
  }, [root, load]);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
      }
      return next;
    });
    if (children[dir] === undefined) void load(dir);
  };

  if (root === '') {
    return (
      <CenteredHint
        title="这个会话还没有工作空间"
        detail="在会话设置里指定一个目录后，这里会列出它的文件。"
      />
    );
  }

  const rows: React.ReactNode[] = [];
  const walk = (dir: string, depth: number) => {
    const entries = children[dir];
    const isLoading = loading.has(dir);
    if (isLoading && entries === undefined) {
      rows.push(
        <Box key={`${dir}:loading`} sx={{ pl: 1.25 + depth * 1.5, py: 0.5, display: 'flex', gap: 1 }}>
          <CircularProgress size={11} sx={{ color: 'text.disabled' }} />
          <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>读取中…</Typography>
        </Box>,
      );
      return;
    }
    if (entries === undefined) return;
    if (entries.length === 0) {
      rows.push(
        <Typography
          key={`${dir}:empty`}
          sx={{ pl: 2.5 + depth * 1.5, py: 0.5, fontSize: 11.5, color: 'text.disabled' }}
        >
          （空目录）
        </Typography>,
      );
    }
    for (const entry of entries) {
      const path = joinPath(dir, entry.name);
      const isOpen = expanded.has(path);
      if (entry.dir) {
        rows.push(
          <Row
            key={path}
            depth={depth}
            ariaLabel={`${isOpen ? '折叠' : '展开'}目录 ${entry.name}`}
            onClick={() => toggle(path)}
            chevron={isOpen ? 'down' : 'right'}
            icon={
              isOpen ? (
                <FolderOpenIcon sx={{ fontSize: 15, color: 'warning.main' }} />
              ) : (
                <FolderIcon sx={{ fontSize: 15, color: 'warning.main' }} />
              )
            }
            label={entry.name}
          />,
        );
        if (isOpen) walk(path, depth + 1);
      } else {
        rows.push(
          <Row
            key={path}
            depth={depth}
            ariaLabel={`预览文件 ${entry.name}`}
            onClick={() => onOpenFile(path, entry.name)}
            icon={<FileIcon name={entry.name} size={14} radius={3} />}
            label={entry.name}
            meta={formatBytes(entry.size)}
          />,
        );
      }
    }
    if (truncated.has(dir)) {
      rows.push(
        <Typography
          key={`${dir}:truncated`}
          sx={{ pl: 2.5 + depth * 1.5, py: 0.5, fontSize: 11.5, color: 'text.disabled' }}
        >
          条目过多，只显示前 800 项
        </Typography>,
      );
    }
  };
  walk(root, 0);

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', py: 1 }}>
      {/* 根目录常驻一行：用户切到别的目录前要能一眼确认「我在看哪个工作空间」 */}
      <Typography
        noWrap
        title={root}
        sx={{ px: 1.5, pb: 0.75, fontSize: 11, color: 'text.disabled', letterSpacing: '0.02em' }}
      >
        {root}
      </Typography>
      {error && (
        <Typography sx={{ px: 1.5, pb: 0.5, fontSize: 11.5, color: 'error.main' }}>
          {error}
        </Typography>
      )}
      {rows}
    </Box>
  );
}

/** 树里的一行（目录 / 文件共用同一套行高与 hover） */
function Row({
  depth,
  label,
  icon,
  chevron,
  meta,
  ariaLabel,
  onClick,
}: {
  depth: number;
  label: string;
  icon: React.ReactNode;
  chevron?: 'down' | 'right';
  meta?: string;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
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
        gap: 0.75,
        pl: 1 + depth * 1.5,
        pr: 1,
        height: 26,
        cursor: 'pointer',
        borderRadius: 1,
        mx: 0.75,
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <Box sx={{ width: 10, display: 'flex', flexShrink: 0, color: 'text.disabled' }}>
        {chevron === 'down' ? (
          <ExpandMoreIcon sx={{ fontSize: 14 }} />
        ) : chevron === 'right' ? (
          <ChevronRightIcon sx={{ fontSize: 14 }} />
        ) : null}
      </Box>
      <Box sx={{ display: 'flex', flexShrink: 0, alignItems: 'center' }}>{icon}</Box>
      <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
        {label}
      </Typography>
      {meta && (
        <Typography sx={{ fontSize: 10.5, color: 'text.disabled', flexShrink: 0, ml: 0.5 }}>
          {meta}
        </Typography>
      )}
    </Box>
  );
}

function CenteredHint({ title, detail }: { title: string; detail: string }) {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        px: 3,
        textAlign: 'center',
      }}
    >
      <FolderOpenIcon sx={{ fontSize: 30, color: 'text.disabled' }} />
      <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>{title}</Typography>
      <Typography sx={{ fontSize: 11.5, color: 'text.disabled', lineHeight: 1.7 }}>{detail}</Typography>
    </Box>
  );
}
