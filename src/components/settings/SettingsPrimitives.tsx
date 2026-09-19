import type { ReactNode } from 'react';
import { Box, Paper, Typography, type SxProps, type Theme } from '@mui/material';

/**
 * 设置弹窗的通用外观件：卡片 + 行。
 *
 * 抽出来的唯一理由：WorkBuddy 式设置界面里「一行 = 左标签 + 右控件」重复了几十次，
 * 每处各写一遍 flex/sx 必然长歪（间距、分割线、副标题颜色各写各的）。这里收口成一个
 * 组件，后续新增配置项只要填 label / hint / control。
 *
 * **分割线由容器给，不由行给**：`SettingsCard` 对子元素用 `& > * + *` 补上分割线，
 * 这样「首行无上边线」是结构性保证，不依赖每行传 `divider` 参数——参数总有传漏的一次。
 */
export function SettingsCard({
  title,
  description,
  children,
  sx,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  sx?: SxProps<Theme>;
}) {
  return (
    <Paper
      variant="outlined"
      sx={{
        mb: 2,
        bgcolor: 'background.paper',
        overflow: 'hidden',
        ...(sx as object),
      }}
    >
      {(title || description) && (
        <Box sx={{ px: 2, pt: 1.75, pb: 1.5 }}>
          {title && (
            <Typography sx={{ fontSize: 13.5, fontWeight: 700 }}>
              {title}
            </Typography>
          )}
          {description && (
            <Typography
              sx={{
                fontSize: 12,
                color: 'text.secondary',
                mt: title ? 0.5 : 0,
                lineHeight: 1.7,
              }}
            >
              {description}
            </Typography>
          )}
        </Box>
      )}
      <Box
        sx={{
          '& > * + *': { borderTop: '1px solid', borderColor: 'divider' },
        }}
      >
        {children}
      </Box>
    </Paper>
  );
}

/**
 * 单行配置项。
 *
 * - `layout="row"`（默认）：左标签 + 右控件，适合开关 / 下拉；
 * - `layout="stack"`：标签在上、控件占满整行，适合输入框 / 多行文本。
 */
export function SettingsRow({
  label,
  hint,
  control,
  children,
  layout = 'row',
}: {
  label: ReactNode;
  hint?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  layout?: 'row' | 'stack';
}) {
  const stacked = layout === 'stack';
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: stacked ? 'column' : 'row',
        alignItems: stacked ? 'stretch' : 'center',
        gap: stacked ? 1.25 : 2,
        px: 2,
        py: 1.75,
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.5 }}>
          {label}
        </Typography>
        {hint && (
          <Typography
            sx={{
              fontSize: 12,
              color: 'text.secondary',
              mt: 0.25,
              lineHeight: 1.65,
            }}
          >
            {hint}
          </Typography>
        )}
      </Box>
      {control && (
        <Box
          sx={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
          }}
        >
          {control}
        </Box>
      )}
      {children}
    </Box>
  );
}

/**
 * 分区内的区块标题（无卡片外框），用于「卡片之外」的内容分组，
 * 例如记忆 / 人格 / 插件这些整块嵌入的编辑器上方。
 */
export function SettingsBlockLabel({
  children,
  description,
}: {
  children: ReactNode;
  description?: ReactNode;
}) {
  return (
    <Box sx={{ mb: 1 }}>
      <Typography sx={{ fontSize: 13.5, fontWeight: 700 }}>
        {children}
      </Typography>
      {description && (
        <Typography
          sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, lineHeight: 1.7 }}
        >
          {description}
        </Typography>
      )}
    </Box>
  );
}
