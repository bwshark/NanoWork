import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import MenuBookIcon from '@mui/icons-material/MenuBook';

interface MemoryBarProps {
  /** 已注入的记忆条数 */
  count: number;
  /**
   * 因**预算**被裁掉的行数（0 或省略表示全装下了）。
   *
   * 为什么要显示它：记忆 v2 给注入加了硬预算（用户级 4000 / 工作区级 3000 字符），
   * 超出就按确定优先级裁剪。裁剪本身是对的，但**静默裁剪**会让用户以为「它记住了」
   * 而模型其实没看到那一条——所以这个数字必须露出来，并且指路到记忆页。
   */
  truncated?: number;
  /** 关闭提示条回调 */
  onDismiss: () => void;
}

/**
 * 「已加载 N 条记忆」提示条。
 * 纯展示组件，不读 store，便于在会话头部/其他位置复用。
 */
export function MemoryBar({ count, truncated = 0, onDismiss }: MemoryBarProps) {
  const hasTruncated = truncated > 0;
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
      {hasTruncated && (
        <Tooltip
          title={`还有 ${truncated} 条因上下文预算未注入。可在「记忆」页停用不重要的条目，或调整注入预算。`}
        >
          <Typography
            sx={{ fontSize: 12, color: 'warning.main', whiteSpace: 'nowrap', cursor: 'help' }}
          >
            · 截断 {truncated} 条
          </Typography>
        </Tooltip>
      )}
      <Tooltip title="本次会话不再注入记忆">
        <IconButton size="small" onClick={onDismiss} aria-label="关闭记忆注入">
          <CloseIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
