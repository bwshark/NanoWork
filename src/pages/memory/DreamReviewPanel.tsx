import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import DeleteSweepOutlinedIcon from '@mui/icons-material/DeleteSweepOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { connectionManager } from '@/ai/connectionManager';
import type { DreamReviewResponse } from '@/ai/runtime/types';
import type { MemoryScope } from '@/types';
import { toast } from '@/components/Toast';

const STATUS_META: Record<
  'new' | 'modified' | 'deleted',
  { label: string; color: 'success' | 'warning' | 'error' }
> = {
  new: { label: '新增', color: 'success' },
  modified: { label: '修改', color: 'warning' },
  deleted: { label: '删除', color: 'error' },
};

const FILE_LABELS: Record<string, string> = {
  'MEMORY.md': '精炼记忆',
  'SOUL.md': '人格设定',
  'USER.md': '用户画像',
};

/**
 * FR-4.6 Dream 审查闸门：记忆页的「待审查」区。
 *
 * 网关开闸门（默认开）时，Dream 的合并产物先落 `memory/.dream_candidate/` 而非直写
 * `MEMORY.md`。这个面板从 `GET /v1/dream/review` 拉候选 diff，逐文件展示
 * 「新增 / 修改 / 删除」，用户**采纳**才经 `POST /v1/dream/accept` 写回，
 * **丢弃**经 `POST /v1/dream/reject`（正式文件永不被碰）。
 *
 * 这是引擎侧记忆（工作区 `MEMORY.md`/`SOUL.md`/`USER.md`）的闸门，与记忆 v2 的
 * 本地 `conflicts.json` 裁决是两回事——这里只复用「待裁决」的视觉形态，不复用那张表。
 *
 * 能力降级：老版本网关没有 `/v1/dream/review`，`getDreamReview` 不存在时静默不渲染，
 * 不报错、不阻塞记忆页其余部分。
 */
export function DreamReviewPanel({
  scope,
  reloadToken,
}: {
  scope: MemoryScope;
  /** 记忆页写盘后自增；变化即重新拉取候选，保证「刚跑完 Dream」能及时看到待审查。 */
  reloadToken: number;
}) {
  const [review, setReview] = useState<DreamReviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    if (scope !== 'workspace') {
      setReview(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const client = await connectionManager.getClient();
      if (typeof client.getDreamReview !== 'function') {
        setReview(null);
        return;
      }
      const r = await client.getDreamReview();
      setReview(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : '拉取 Dream 候选失败');
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  if (scope !== 'workspace') return null;

  const entries = review?.pending ? Object.entries(review.diff) : [];
  if (!loading && !error && (!review || !review.pending)) return null;

  const handleAccept = async () => {
    setActing(true);
    try {
      const client = await connectionManager.getClient();
      const res = await client.acceptDream!();
      toast.success(`已采纳 ${res.updated} 个记忆文件的变更`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '采纳 Dream 候选失败');
    } finally {
      setActing(false);
    }
  };

  const handleReject = async () => {
    setActing(true);
    try {
      const client = await connectionManager.getClient();
      await client.rejectDream!();
      toast.success('已丢弃 Dream 候选，正式记忆文件未改动');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '丢弃 Dream 候选失败');
    } finally {
      setActing(false);
    }
  };

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        mb: 2,
        borderColor: 'warning.main',
        bgcolor: 'action.hover',
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Dream 待审查
        </Typography>
        <Chip
          size="small"
          color="warning"
          label={`${entries.length} 处变更`}
        />
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          startIcon={<RefreshOutlinedIcon />}
          onClick={() => void load()}
          disabled={loading || acting}
        >
          刷新
        </Button>
      </Stack>

      {error ? (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      ) : null}

      {entries.map(([name, entry]) => {
        const meta = STATUS_META[entry.status];
        const friendly = FILE_LABELS[name] ?? name;
        return (
          <Box key={name} sx={{ mb: 1.5 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
              <Chip size="small" color={meta.color} label={meta.label} />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {friendly}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {name}
              </Typography>
            </Stack>
            {entry.status === 'modified' ? (
              <Stack spacing={0.5}>
                <Typography variant="caption" color="text.secondary">
                  原文
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    p: 1,
                    overflow: 'auto',
                    maxHeight: 160,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                    fontSize: 12,
                    textDecoration: 'line-through',
                    opacity: 0.7,
                  }}
                >
                  {entry.old || '(空)'}
                </Box>
                <Typography variant="caption" color="text.secondary">
                  建议
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    p: 1,
                    overflow: 'auto',
                    maxHeight: 160,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    bgcolor: 'rgba(34,197,94,0.10)',
                    borderRadius: 1,
                    fontSize: 12,
                  }}
                >
                  {entry.new}
                </Box>
              </Stack>
            ) : entry.status === 'new' ? (
              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 1,
                  overflow: 'auto',
                  maxHeight: 160,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  bgcolor: 'rgba(34,197,94,0.10)',
                  borderRadius: 1,
                  fontSize: 12,
                }}
              >
                {entry.new}
              </Box>
            ) : (
              <Typography variant="caption" color="text.secondary">
                将删除该文件（当前内容见「原文」）：
              </Typography>
            )}
            {entry.status === 'deleted' ? (
              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 1,
                  overflow: 'auto',
                  maxHeight: 160,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  bgcolor: 'action.hover',
                  borderRadius: 1,
                  fontSize: 12,
                  textDecoration: 'line-through',
                  opacity: 0.7,
                }}
              >
                {entry.old || '(空)'}
              </Box>
            ) : null}
          </Box>
        );
      })}

      <Divider sx={{ my: 1 }} />
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button
          color="inherit"
          variant="outlined"
          startIcon={<DeleteSweepOutlinedIcon />}
          onClick={() => void handleReject()}
          disabled={acting || loading}
        >
          丢弃
        </Button>
        <Button
          color="success"
          variant="contained"
          startIcon={<CheckCircleOutlineIcon />}
          onClick={() => void handleAccept()}
          disabled={acting || loading}
        >
          采纳
        </Button>
      </Stack>
    </Paper>
  );
}
