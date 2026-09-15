import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import MenuBookIcon from '@mui/icons-material/MenuBook';

interface MemoryBarProps {
  /** 已注入的记忆条数 */
  count: number;
  /** 关闭提示条回调 */
  onDismiss: () => void;
}

/**
 * 「已加载 N 条记忆」提示条。
 * 纯展示组件，不读 store，便于在会话头部/其他位置复用。
 */
export function MemoryBar({ count, onDismiss }: MemoryBarProps) {
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        pl: 1,
        pr: 0.25,
        py: 0.25,
        borderRadius: 999,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'action.hover',
        maxWidth: '100%',
      }}
    >
      <MenuBookIcon sx={{ fontSize: 16, color: 'primary.main' }} />
      <Typography sx={{ fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}>
        已加载 {count} 条记忆
      </Typography>
      <Tooltip title="本次会话不再注入记忆">
        <IconButton size="small" onClick={onDismiss} aria-label="关闭记忆注入">
          <CloseIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
