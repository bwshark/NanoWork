import type { ReactNode } from 'react';
import {
  alpha,
  Box,
  Paper,
  Typography,
  useTheme,
  type SxProps,
  type Theme,
} from '@mui/material';

/**
 * 卡片内容区的水平内边距。
 *
 * **水平内边距归卡片所有，行只负责垂直节奏**——这条约定换来两个好处：
 *
 * 1. 分割线自动与文字左右对齐。行自己带 `px` 时，`& > * + *` 的 `borderTop`
 *    长在行上，会从卡片最左拉到最右；对齐 WorkBuddy「存储」那张卡片，分割线
 *    应当是**内缩**的，与文字同宽。
 * 2. 新增行时不必再考虑左边距，横向节奏只有一个出处。
 *
 * 取 2.5（20px）而不是 2：参考图里卡片内文字距卡片边缘约 20px，用 16px 会显得
 * 内容被边线挤住。区块标题共用同一个值，所以标题永远与卡片内文字左对齐。
 */
const CARD_PX = 2.5;

/**
 * 卡片圆角。比 MUI 默认的 `shape.borderRadius`(10) 大一档——参考图的卡片用更大的
 * 圆角把「面」和「线」区分开。
 */
const CARD_RADIUS = '12px';

/**
 * 设置弹窗的通用外观件：区块标题 + 卡片 + 行。
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
  const theme = useTheme();
  // 深色下阴影几乎不可见，分层只能靠「面色差 + 发丝线」；浅色下阴影才是主分层手段。
  const dark = theme.palette.mode === 'dark';

  return (
    <Box sx={{ mb: 2.5 }}>
      {/* 标题渲染在卡片**之外**（对齐 WorkBuddy「存储」的写法）。
          放卡片里会让「边框」看起来是在包标题：同一个分区有多张卡片时，会出现
          一串带框的标题与内容行混在一起，层级读不出来；标题是分组标签，不是卡片内容。
          `px: CARD_PX` 让标题与卡片内的文字左边界对齐。 */}
      {(title || description) && (
        <SettingsBlockLabel sx={{ px: CARD_PX }} description={description}>
          {title}
        </SettingsBlockLabel>
      )}

      <Paper
        sx={{
          bgcolor: 'background.paper',
          borderRadius: CARD_RADIUS,
          // 分层靠「面色 + 阴影」而不是描边：`variant="outlined"` 的 1px 实线会把卡片
          // 框成表格，参考图里卡片是浮在底色上的一个「面」。
          //
          // 描边用 `boxShadow` 的 0-0-0-1px 圆环而不是 `border`：`border` 会占掉 1px
          // **布局**宽度，卡片内的文字因此比卡片外的标题右移 1px——肉眼看不出，但
          // 「标题与卡片内容左对齐」这条约定就被悄悄破坏了。圆环只画不占位。
          boxShadow: dark
            ? `0 0 0 1px ${alpha(theme.palette.common.white, 0.06)}`
            : `0 0 0 1px ${alpha(theme.palette.text.primary, 0.05)}, ` +
              '0 1px 2px rgba(15,23,42,0.04), 0 2px 8px rgba(15,23,42,0.05)',
          overflow: 'hidden',
          ...(sx as object),
        }}
      >
        <Box
          sx={{
            px: CARD_PX,
            '& > * + *': { borderTop: '1px solid', borderColor: 'divider' },
          }}
        >
          {children}
        </Box>
      </Paper>
    </Box>
  );
}

/**
 * 单行配置项。
 *
 * - `layout="row"`（默认）：左标签 + 右控件，适合开关 / 下拉；
 * - `layout="stack"`：标签在上、控件占满整行，适合输入框 / 多行文本。
 *
 * 不带水平内边距——那属于卡片，见 `CARD_PX`。
 *
 * 标签用 14px/600 + `text.primary`，比区块标题（13.5px/600 + `text.secondary`）
 * 大一号且更亮：卡片外的标题是**分组**，卡片里的这个才是**内容**，两者不能长得一样。
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
        py: 2,
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}>
          {label}
        </Typography>
        {hint && (
          <Typography
            sx={{
              fontSize: 12.5,
              color: 'text.secondary',
              mt: 0.375,
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
 * 区块标题：位于卡片（或整块编辑器）**之外**的分组标签。
 *
 * 卡片标题与「卡片之外的编辑器标题」共用它，保证同一层级的标题长得一样——
 * 两处各写一份样式，早晚出现一处是灰的、一处是黑的。
 *
 * 用 `text.secondary` 而不是 `text.primary`：这一层是**分组**，卡片里的行标签
 * 才是内容。同字号下如果颜色也一样，读起来会分不清哪个是标题哪个是配置项。
 */
export function SettingsBlockLabel({
  children,
  description,
  sx,
}: {
  children?: ReactNode;
  description?: ReactNode;
  sx?: SxProps<Theme>;
}) {
  return (
    <Box sx={{ mb: 1.25, ...(sx as object) }}>
      {children && (
        <Typography
          sx={{ fontSize: 13.5, fontWeight: 600, color: 'text.secondary' }}
        >
          {children}
        </Typography>
      )}
      {description && (
        <Typography
          sx={{
            fontSize: 12,
            color: 'text.secondary',
            opacity: 0.85,
            mt: children ? 0.5 : 0,
            lineHeight: 1.7,
          }}
        >
          {description}
        </Typography>
      )}
    </Box>
  );
}
