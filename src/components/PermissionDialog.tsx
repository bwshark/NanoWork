import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';
import { useSessionsStore } from '@/stores/sessionsStore';

/** 敏感操作权限门控弹窗（FR-009）：读取待决策的 pendingPermission */
export function PermissionDialog() {
  const pending = useSessionsStore((s) => s.pendingPermission);
  const approve = useSessionsStore((s) => s.approvePermission);
  const reject = useSessionsStore((s) => s.rejectPermission);

  const open = !!pending;

  return (
    <Dialog open={open} disableEscapeKeyDown maxWidth="sm" fullWidth>
      <DialogTitle>敏感操作权限确认</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1 }}>
          以下工具涉及敏感资源（文件 / 终端 / 网络），是否允许本次执行？
        </Typography>
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
            maxHeight: 180,
            overflow: 'auto',
            m: 0,
          }}
        >
          {pending ? JSON.stringify(pending.args, null, 2) : ''}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={reject} color="error">
          拒绝
        </Button>
        <Button onClick={approve} variant="contained">
          批准
        </Button>
      </DialogActions>
    </Dialog>
  );
}
