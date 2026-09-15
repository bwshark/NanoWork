import { useState } from 'react';
import { Box, Chip, Collapse, IconButton, Paper, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { ToolCall, ToolCallStatus } from '@/types';

const STATUS_LABEL: Record<ToolCallStatus, string> = {
  pending: '等待授权',
  approved: '已批准',
  rejected: '已拒绝',
  running: '执行中',
  done: '完成',
  error: '错误',
};

const STATUS_COLOR: Record<ToolCallStatus, 'warning' | 'info' | 'error' | 'success' | 'default'> = {
  pending: 'warning',
  approved: 'info',
  rejected: 'error',
  running: 'info',
  done: 'success',
  error: 'error',
};

/** 工具调用卡片：展示工具名、敏感标记、状态、可展开的参数与结果 */
export function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
  const [open, setOpen] = useState(false);

  return (
    <Paper
      variant="outlined"
      sx={{ p: 1, my: 0.5, bgcolor: 'background.paper', borderColor: 'divider' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{toolCall.tool}</Typography>
        {toolCall.sensitive && (
          <Chip size="small" label="敏感" color="warning" variant="outlined" />
        )}
        <Chip
          size="small"
          label={STATUS_LABEL[toolCall.status]}
          color={STATUS_COLOR[toolCall.status]}
          variant="outlined"
        />
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={() => setOpen((v) => !v)}>
          <ExpandMoreIcon
            sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: '0.2s' }}
            fontSize="small"
          />
        </IconButton>
      </Box>

      <Collapse in={open}>
        <Box sx={{ mt: 1 }}>
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>参数</Typography>
          <Box
            component="pre"
            sx={{
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              m: 0,
              bgcolor: 'action.hover',
              p: 1,
              borderRadius: 1,
            }}
          >
            {JSON.stringify(toolCall.args, null, 2)}
          </Box>
          {toolCall.result && (
            <>
              <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1 }}>结果</Typography>
              <Box
                component="pre"
                sx={{
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  m: 0,
                  bgcolor: 'action.hover',
                  p: 1,
                  borderRadius: 1,
                }}
              >
                {toolCall.result}
              </Box>
            </>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
}
