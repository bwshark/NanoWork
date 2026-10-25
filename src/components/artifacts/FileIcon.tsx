import { Box } from '@mui/material';
import { badgeForFileName, toneForFileName, type FileTone } from '@/lib/artifact/fileArtifact';

/**
 * 角标色调 → 底色 / 字色。
 *
 * 取的是各组生态里**最有辨识度**的那一支色（TS 蓝 / MD 靛蓝 / Python 蓝 …），
 * 让用户在两列卡片里扫一眼就能分辨文件类型，而不必读文字。字色单独给出是因为
 * JS 黄底必须配深字，统一白字会糊成一片。
 */
const TONE_STYLE: Record<FileTone, { bg: string; fg: string }> = {
  ts: { bg: '#3178c6', fg: '#ffffff' },
  js: { bg: '#f7df1e', fg: '#1f2328' },
  doc: { bg: '#4f7cf7', fg: '#ffffff' },
  data: { bg: '#e0a029', fg: '#1f2328' },
  markup: { bg: '#e34f26', fg: '#ffffff' },
  style: { bg: '#1572b6', fg: '#ffffff' },
  python: { bg: '#3572a5', fg: '#ffffff' },
  image: { bg: '#a259ff', fg: '#ffffff' },
  other: { bg: '#6b7280', fg: '#ffffff' },
};

interface FileIconProps {
  /** 文件名（含扩展名），角标文字与配色都由它推出 */
  name: string;
  /** 边长（px） */
  size?: number;
  /** 圆角（px） */
  radius?: number;
}

/**
 * 文件类型角标：圆角色块 + 扩展名缩写（对应参考稿里 JS / TS / M 的小方块）。
 *
 * 纯展示组件（`aria-hidden`）：文件名本身就在旁边，读屏再念一次角标只是噪音。
 */
export function FileIcon({ name, size = 26, radius = 6 }: FileIconProps) {
  const label = badgeForFileName(name);
  const { bg, fg } = TONE_STYLE[toneForFileName(name)];
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        width: size,
        height: size,
        borderRadius: `${radius}px`,
        bgcolor: bg,
        color: fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        lineHeight: 1,
        fontSize: label.length > 2 ? size * 0.34 : size * 0.4,
        fontWeight: 700,
        letterSpacing: '-0.02em',
        userSelect: 'none',
      }}
    >
      {label}
    </Box>
  );
}