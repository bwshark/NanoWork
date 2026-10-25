import { Box } from '@mui/material';
import { entityAvatarSx, hashHue } from '@/lib/ui/cardSx';

/**
 * 技能图标。
 *
 * ## 两种形态
 *
 * - `tile`（默认，卡片用）：同色相淡底 + 同色相描边的圆角方块。
 * - `solid`（详情页用）：同色相**饱和渐变圆形**，与专家头像同一套渐变语言。
 *
 * 底色刻意用低透明度的色相淡底而不是饱和实底：本项目的技能图标是 emoji，
 * 实底会把彩色 emoji 压得发灰；淡底既保留「每个技能一个颜色」的识别性，
 * 也不牺牲 emoji 本身的辨识度。
 *
 * `solid` 之所以敢用饱和底：它只出现在详情页的 64px 大图标上，
 * emoji 放大到 30px 后压色问题不再明显；而详情页需要一枚**有分量**的主视觉。
 *
 * 尺寸与圆角都按边长派生，保证同一个技能在卡片（32）与详情页（64）里
 * 是**同一个图标的不同大小**，而不是两套配色。
 *
 * 没有图标时退回首字母而不是一个通用 emoji：参考样式里无图标的技能就是
 * 一枚字母牌，通用 emoji 会让十几个技能长得一模一样，识别性反而更差。
 */
export function SkillIcon({
  name,
  icon,
  size = 32,
  variant = 'tile',
}: {
  name: string;
  icon?: string;
  size?: number;
  /** `tile` 圆角淡底方块（卡片）/ `solid` 饱和渐变圆形（详情页） */
  variant?: 'tile' | 'solid';
}) {
  const glyph = icon?.trim() || name?.trim()?.[0]?.toUpperCase() || '?';

  if (variant === 'solid') {
    // 复用专家头像的渐变（同名同色相），让技能与专家在详情页里是同一种视觉语言
    const isEmoji = /\p{Extended_Pictographic}/u.test(glyph);
    return (
      <Box
        aria-hidden
        sx={{
          ...entityAvatarSx(name, isEmoji),
          width: size,
          height: size,
          borderRadius: '50%',
          fontSize: Math.round(size * 0.46),
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {glyph}
      </Box>
    );
  }

  const h = hashHue(name || '?');
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: `${Math.round(size * 0.28)}px`,
        fontSize: Math.round(size * 0.5),
        fontWeight: 600,
        lineHeight: 1,
        bgcolor: `hsla(${h}, 55%, 50%, 0.16)`,
        border: '1px solid',
        borderColor: `hsla(${h}, 55%, 50%, 0.28)`,
      }}
    >
      {glyph}
    </Box>
  );
}
