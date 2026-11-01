import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, CircularProgress, IconButton, Tooltip, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import DifferenceIcon from '@mui/icons-material/Difference';
import { FileIcon } from './FileIcon';
import { platform } from '@/platform';
import type { GitFileChange, GitStatusResult } from '@/platform/types';

/** 一次最多画多少行 diff：再长的 patch 也没有人真去读，反而把滚动条压成一根线 */
const MAX_DIFF_LINES = 4000;

/** 改动状态 → 中文短标签（色块由状态决定，与 git 生态的绿 / 红一致） */
const STATUS_LABEL: Record<GitFileChange['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  untracked: '未跟踪',
  conflicted: '冲突',
};

const STATUS_COLOR: Record<GitFileChange['status'], string> = {
  added: 'success.main',
  untracked: 'success.main',
  modified: 'warning.main',
  deleted: 'error.main',
  renamed: 'info.main',
  conflicted: 'error.main',
};

/**
 * 工作区变更（右栏「变更」标签）。
 *
 * ## 数据为什么是 git 而不是产物表
 *
 * 「查看变更」回答的是「这个工作空间现在被改成了什么样」——包括智能体改的、
 * 用户自己改的、以及从没进过对话的文件。产物表只知道前者的一个子集，
 * 拿它冒充变更会让「改了但没显示」变成常态。
 *
 * ## 为什么左边列表 + 右边 diff
 *
 * 与参考稿一致：一眼扫完「改了哪些、各改了多少行」，再点进去看具体行。
 * 面板窄于 480px 时改成上下堆叠（列表在上），否则左右各半会窄到读不了代码。
 */
export function ChangesView({ root }: { root: string }) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState('');
  const [patchLoading, setPatchLoading] = useState(false);
  const [compact, setCompact] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (root === '') return;
    setLoading(true);
    const result = await platform.gitStatus(root);
    setLoading(false);
    setStatus(result);
    setSelected((prev) => {
      // 刷新后原来选中的文件可能已经不在列表里（提交了 / 还原了）→ 落到第一个
      if (prev && result.files.some((f) => f.path === prev)) return prev;
      return result.files[0]?.path ?? null;
    });
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 面板宽度决定左右分栏还是上下堆叠（拖宽抓手随时会改它）
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setCompact(width < 480);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (root === '' || selected === null) {
      setPatch('');
      return;
    }
    let cancelled = false;
    setPatchLoading(true);
    void platform.gitDiff(root, selected).then((result) => {
      if (cancelled) return;
      setPatchLoading(false);
      setPatch(result.ok ? result.patch : (result.error ?? ''));
    });
    return () => {
      cancelled = true;
    };
  }, [root, selected]);

  const diffLines = useMemo(() => patch.split('\n').slice(0, MAX_DIFF_LINES), [patch]);

  return (
    <Box ref={containerRef} sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {status && !status.ok && (
        <Box sx={{ px: 2, py: 3, display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'center' }}>
          <DifferenceIcon sx={{ fontSize: 30, color: 'text.disabled' }} />
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary', textAlign: 'center' }}>
            {status.error ?? '无法读取改动'}
          </Typography>
          <Typography sx={{ fontSize: 11.5, color: 'text.disabled', textAlign: 'center' }}>
            变更视图依赖 git：需要这个工作空间是一个 git 仓库，且本机装了 git。
          </Typography>
        </Box>
      )}

      {status?.ok && (
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: compact ? 'column' : 'row' }}>
          {/* ── 左：文件清单 ── */}
          <Box
            sx={{
              width: compact ? '100%' : '46%',
              maxWidth: compact ? '100%' : 320,
              minWidth: compact ? 0 : 180,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              borderRight: compact ? 'none' : '1px solid',
              borderBottom: compact ? '1px solid' : 'none',
              borderColor: 'divider',
              // 堆叠时给列表一个上限，别把 diff 挤没
              maxHeight: compact ? '45%' : undefined,
              minHeight: 0,
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                px: 1.5,
                height: 34,
                flexShrink: 0,
              }}
            >
              <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: 'text.secondary' }}>
                文件变更
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: 'success.main' }}>
                +{status.added}
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: 'error.main' }}>-{status.removed}</Typography>
              <Box sx={{ flex: 1 }} />
              <Tooltip title="刷新" placement="bottom">
                <span>
                  <IconButton
                    size="small"
                    aria-label="刷新变更"
                    sx={{ p: 0.3 }}
                    disabled={loading}
                    onClick={() => void refresh()}
                  >
                    {loading ? (
                      <CircularProgress size={13} sx={{ color: 'text.disabled' }} />
                    ) : (
                      <RefreshIcon sx={{ fontSize: 15 }} />
                    )}
                  </IconButton>
                </span>
              </Tooltip>
            </Box>

            <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pb: 1 }}>
              {status.files.length === 0 ? (
                <Typography sx={{ px: 1.5, py: 2, fontSize: 12, color: 'text.disabled' }}>
                  工作区没有未提交的改动
                </Typography>
              ) : (
                status.files.map((file) => (
                  <ChangeRow
                    key={file.path}
                    file={file}
                    active={file.path === selected}
                    onClick={() => setSelected(file.path)}
                  />
                ))
              )}
            </Box>
          </Box>

          {/* ── 右：diff ── */}
          <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {selected === null ? (
              <Box
                sx={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  px: 3,
                }}
              >
                <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>
                  请选择一个文件查看详情
                </Typography>
              </Box>
            ) : patchLoading ? (
              <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CircularProgress size={14} sx={{ color: 'text.disabled' }} />
              </Box>
            ) : patch.trim() === '' ? (
              <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>这个文件没有可显示的差异</Typography>
              </Box>
            ) : (
              <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', py: 0.5 }}>
                <Box component="pre" sx={{ m: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5, lineHeight: 1.55 }}>
                  {diffLines.map((line, index) => (
                    <DiffLine key={index} line={line} />
                  ))}
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {status === null && (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <CircularProgress size={14} sx={{ color: 'text.disabled' }} />
        </Box>
      )}
    </Box>
  );
}

function ChangeRow({
  file,
  active,
  onClick,
}: {
  file: GitFileChange;
  active: boolean;
  onClick: () => void;
}) {
  const name = file.path.split('/').pop() ?? file.path;
  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label={`查看改动 ${file.path}`}
      aria-current={active ? 'true' : undefined}
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
        mx: 0.75,
        px: 0.75,
        height: 27,
        borderRadius: 1,
        cursor: 'pointer',
        bgcolor: active ? 'action.selected' : 'transparent',
        '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover' },
      }}
    >
      <FileIcon name={name} size={14} radius={3} />
      <Tooltip title={file.path} placement="right" enterDelay={600}>
        <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: 12, color: 'text.primary' }}>
          {name}
        </Typography>
      </Tooltip>
      {file.added > 0 && (
        <Typography sx={{ fontSize: 10.5, color: 'success.main', flexShrink: 0 }}>
          +{file.added}
        </Typography>
      )}
      {file.removed > 0 && (
        <Typography sx={{ fontSize: 10.5, color: 'error.main', flexShrink: 0 }}>
          -{file.removed}
        </Typography>
      )}
      {file.added === 0 && file.removed === 0 && (
        <Typography sx={{ fontSize: 10, color: STATUS_COLOR[file.status], flexShrink: 0 }}>
          {STATUS_LABEL[file.status]}
        </Typography>
      )}
    </Box>
  );
}

/**
 * 一行 diff。
 *
 * 只按行的首字符着色（`+` / `-` / `@@`），不解析 hunk 结构——渲染层要做的是
 * 「一眼看出哪几行变了」，行号与语法的精确还原交给编辑器。
 */
function DiffLine({ line }: { line: string }) {
  const kind =
    line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')
      ? 'meta'
      : line.startsWith('@@')
        ? 'hunk'
        : line.startsWith('+')
          ? 'add'
          : line.startsWith('-')
            ? 'del'
            : 'ctx';

  const sx = {
    display: 'block',
    px: 1.25,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    ...(kind === 'add' ? { bgcolor: 'rgba(46,160,67,0.15)', color: '#3fb950' } : {}),
    ...(kind === 'del' ? { bgcolor: 'rgba(248,81,73,0.12)', color: '#f85149' } : {}),
    ...(kind === 'hunk' ? { color: 'info.main', opacity: 0.9 } : {}),
    ...(kind === 'meta' ? { color: 'text.disabled' } : {}),
    ...(kind === 'ctx' ? { color: 'text.secondary' } : {}),
  } as const;

  return <Box component="span" sx={sx}>{line === '' ? '\u00a0' : line}</Box>;
}
