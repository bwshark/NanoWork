import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
  FormControlLabel,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import ChecklistIcon from '@mui/icons-material/Checklist';
import { toast } from '@/components/Toast';
import { useSessionsStore } from '@/stores/sessionsStore';
import type { MessagePlan } from '@/types';

/**
 * Plan 模式的计划清单卡片（FR-1.5）。
 *
 * 三条设计约束：
 *
 * 1. **勾选是默认全选，但必须显式提交**：计划的语义是「这些步骤我授权了」，
 *    所以用户看到的是一份待确认的范围，而不是已经生效的决定。
 * 2. **批准 ≠ 执行**：两者分开两个按钮。「仅批准」只把会话切到 Craft（用户可能
 *    还想补充几句再让它动手），「按选中项执行」才会真的发出下一轮请求。
 *    合并成一个按钮会让「批准」这个动作带出用户没预期的副作用。
 * 3. **打回必须能带意见**：理由会原样作为下一轮的用户消息发出去，模型据此重规划；
 *    空理由也可以提交（有些驳回不需要解释），但不替用户编理由。
 */
export function PlanCard({
  sessionId,
  messageId,
  planId,
}: {
  sessionId: string;
  messageId: string;
  planId: string;
}) {
  const plan = useSessionsStore((s) => {
    const found = s.sessions
      .find((x) => x.id === sessionId)
      ?.messages.find((m) => m.id === messageId)?.plan;
    // 按 id 认计划：同一条消息可能先后挂过不同计划（重发会产生新计划）
    return found?.planId === planId ? found : undefined;
  });
  const resolvePlan = useSessionsStore((s) => s.resolvePlan);
  /** 本轮还在流式：此时发起执行会被 send 拦下，故提前置灰并说明原因 */
  const streaming = useSessionsStore((s) => s.streams[sessionId] !== undefined);

  /** 勾选集：未裁决前按 step id 全选 */
  const [selected, setSelected] = useState<string[] | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const allIds = useMemo(() => (plan?.steps ?? []).map((s) => s.id), [plan]);
  const checked = selected ?? allIds;
  const settled = plan?.status !== 'pending';

  if (!plan) return null;

  const toggle = (id: string) => {
    setSelected(
      checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id],
    );
  };

  const run = async (decision: 'approved' | 'rejected', opts?: { execute?: boolean }) => {
    setBusy(true);
    try {
      const ok = await resolvePlan(planId, decision, {
        approvedStepIds: decision === 'approved' ? checked : [],
        ...(decision === 'rejected' && reason.trim() !== '' ? { reason: reason.trim() } : {}),
        ...(opts?.execute ? { execute: true } : {}),
      });
      if (!ok) toast.error('该计划已裁决过或已失效');
    } finally {
      setBusy(false);
    }
  };

  /** 已批准项数：未裁决时显示待确认的勾选数 */
  const approvedCount = settled ? (plan.approvedStepIds ?? []).length : checked.length;

  return (
    <Paper
      variant="outlined"
      sx={{ p: 1.25, my: 0.5, bgcolor: 'background.paper', borderColor: 'divider' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <ChecklistIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>执行计划</Typography>
        <Chip
          size="small"
          variant="outlined"
          color={plan.status === 'approved' ? 'success' : plan.status === 'rejected' ? 'error' : 'warning'}
          label={
            plan.status === 'approved'
              ? `已批准 ${approvedCount}/${plan.steps.length} 项`
              : plan.status === 'rejected'
                ? '已打回'
                : `待裁决 · 已选 ${checked.length}/${plan.steps.length}`
          }
        />
        <Box sx={{ flex: 1 }} />
        {busy && <CircularProgress size={12} />}
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, mb: 1 }}>
        {plan.steps.map((step) => {
          const isChecked = settled
            ? (plan.approvedStepIds ?? []).includes(step.id)
            : checked.includes(step.id);
          return (
            <FormControlLabel
              key={step.id}
              disabled={settled}
              control={
                <Checkbox
                  size="small"
                  checked={isChecked}
                  onChange={() => toggle(step.id)}
                  inputProps={{ 'aria-label': step.text }}
                />
              }
              label={
                <Typography
                  sx={{
                    fontSize: 12.5,
                    color: plan.status === 'rejected' ? 'text.disabled' : 'text.primary',
                    textDecoration: plan.status === 'rejected' ? 'line-through' : 'none',
                  }}
                >
                  {step.text}
                </Typography>
              }
              sx={{ m: 0, alignItems: 'flex-start' }}
            />
          );
        })}
      </Box>

      {plan.status === 'rejected' && plan.reason && (
        <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 1 }}>
          打回意见：{plan.reason}
        </Typography>
      )}

      {!settled && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
          <Button
            size="small"
            variant="contained"
            disableElevation
            disabled={busy || streaming || checked.length === 0}
            onClick={() => void run('approved', { execute: true })}
          >
            按选中项执行
          </Button>
          <Button
            size="small"
            disabled={busy}
            onClick={() => void run('approved')}
          >
            仅批准（不执行）
          </Button>
          <Button
            size="small"
            color="error"
            disabled={busy}
            onClick={() => setRejectOpen((v) => !v)}
          >
            打回
          </Button>
          {streaming && (
            <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>
              本轮回复尚未结束，稍后才能执行
            </Typography>
          )}
        </Box>
      )}

      <Collapse in={rejectOpen && !settled}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
          <TextField
            size="small"
            fullWidth
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="打回意见（可选）：告诉它哪里不对"
            sx={{ '& .MuiInputBase-root': { fontSize: 12.5 } }}
          />
          <Button
            size="small"
            color="error"
            variant="outlined"
            disabled={busy}
            onClick={() => void run('rejected')}
          >
            提交打回
          </Button>
        </Box>
      </Collapse>
    </Paper>
  );
}
