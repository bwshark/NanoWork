import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { selectPendingApproval, useSessionsStore } from '@/stores/sessionsStore';

/**
 * 逐条批准弹窗（FR-1.5）。
 *
 * 与旧版「敏感操作权限确认」的本质区别：**引擎真的停下了**。此时工具尚未执行，
 * 会话的流被阻塞在引擎的 `before_execute_tool` 里等待裁决，所以这里的按钮
 * 不是「更新一下本地状态」，而是把裁决通过独立请求回传给引擎（SSE 是单向的，
 * 塞不进去）。用户不响应的话，引擎会在超时后按拒绝处理。
 */
export function PermissionDialog() {
  const pending = useSessionsStore(selectPendingApproval);
  const queued = useSessionsStore((s) => s.pendingApprovals.length);
  const resolveApproval = useSessionsStore((s) => s.resolveApproval);

  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // 切到下一条请求时清空上一条的拒绝原因，避免误带
  useEffect(() => {
    setReason('');
    setBusy(false);
  }, [pending?.id]);

  const open = !!pending;

  const settle = async (decision: 'allow' | 'deny') => {
    if (busy) return;
    setBusy(true);
    await resolveApproval(decision, decision === 'deny' ? reason : undefined);
    setBusy(false);
  };

  return (
    <Dialog open={open} disableEscapeKeyDown maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        需要你的授权
        {queued > 1 && (
          <Typography component="span" variant="body2" sx={{ ml: 1, color: 'text.secondary' }}>
            还有 {queued - 1} 条待处理
          </Typography>
        )}
      </DialogTitle>
      <DialogContent>
        <Alert severity="warning" icon={false} sx={{ mb: 1.5, py: 0.5 }}>
          Agent 想执行一个会改动环境的操作，已暂停等待你的决定。
        </Alert>
        <Box sx={{ mb: 1 }}>
          <Chip label={pending?.tool ?? ''} color="warning" size="small" />
        </Box>
        <Box
          component="pre"
          sx={{
            whiteSpace: 'pre-wrap',
            fontSize: 12,
            bgcolor: 'action.hover',
            p: 1,
            borderRadius: 1,
            maxHeight: 200,
            overflow: 'auto',
            m: 0,
          }}
        >
          {pending ? JSON.stringify(pending.args, null, 2) : ''}
        </Box>
        <TextField
          fullWidth
          size="small"
          label="拒绝原因（可选，会告诉 Agent 你的意图）"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          sx={{ mt: 1.5 }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={() => void settle('deny')} color="error" disabled={busy}>
          拒绝
        </Button>
        <Button
          onClick={() => void settle('allow')}
          variant="contained"
          disabled={busy}
        >
          允许本次
        </Button>
      </DialogActions>
    </Dialog>
  );
}
