import { Box } from '@mui/material';
import { hashHue } from '@/lib/cardSx';

/**
 * 技能图标：同色相淡底 + 同色相描边的圆角方块。
 *
 * 尺寸与圆角都按边长派生，保证同一个技能在市场卡（32）与详情弹窗（64）里
 * 是**同一个图标的不同大小**，而不是两套配色。
 *
 * 底色刻意用低透明度的色相淡底而不是饱和实底：本项目的技能图标是 emoji，
 * 实底会把彩色 emoji 压得发灰；淡底既保留「每个技能一个颜色」的识别性，
 * 也不牺牲 emoji 本身的辨识度。
 *
 * 没有图标时退回首字母而不是一个通用 emoji：参考样式里无图标的技能就是
 * 一枚字母牌，通用 emoji 会让十几个技能长得一模一样，识别性反而更差。
 */
export function SkillIcon({
  name,
  icon,
  size = 32,
}: {
  name: string;
  icon?: string;
  size?: number;
}) {
  const h = hashHue(name || '?');
  const glyph = icon?.trim() || name?.trim()?.[0]?.toUpperCase() || '?';
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
