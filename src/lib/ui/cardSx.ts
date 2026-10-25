import type { SxProps, Theme } from "@mui/material/styles";

/**
 * 专家 / 专家团 / 技能 / MCP（连接器）卡片的统一视觉令牌。
 *
 * 半径写显式 px：MUI 的 `sx.borderRadius` 数值会乘 `theme.shape.borderRadius`(=10)，
 * 写成数字既不好读、跨主题也容易失控，这里统一锁定一组像素值。
 *
 * 注意：hoverCardSx 会被调用方放进 `sx={[...]}` 数组，因此不能标注为 SxProps
 * （SxProps 本身含数组分支，作为数组元素会报不匹配），保持字面量推断即可。
 */
export const CARD_RADIUS = "14px";
/** 卡片内小图标容器（技能 emoji 方块等）圆角 */
export const CARD_ICON_RADIUS = "10px";

/** 由字符串稳定派生色相：同名恒同色，用于头像 / 图标底色的伪随机着色。 */
export function hashHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

/**
 * 通用「可交互卡片」样式：静止态为纸面 + 极淡描边，hover 时整体浮起。
 * - 深色模式：底色提亮（更亮的表面）+ 描边加重 + 外阴影；
 * - 浅色模式：白底靠描边加重 + 阴影表达抬升。
 * 只用同一元素上的 `&:hover`，组件不需要额外的 React hover 状态即可生效。
 *
 * hover 三件套走 index.css 的 CSS 变量（由 html.dark 切换）而非 `action.focus`：
 * `action.focus` 与静止态 `divider` 只差 0.02 alpha，hover 几乎看不出变化。
 */
export const hoverCardSx = {
  bgcolor: "background.paper",
  border: "1px solid",
  borderColor: "divider",
  borderRadius: CARD_RADIUS,
  // 只过渡会变化的视觉属性，避免 transition: all 带来的抖动
  transition:
    "background-color .18s ease, border-color .18s ease, box-shadow .18s ease",
  "&:hover": {
    bgcolor: "var(--hover-surface)",
    borderColor: "var(--hover-border)",
    boxShadow: "var(--hover-shadow)",
  },
};

/** 专家 / 专家团头像：同名同色相的双色渐变，比平涂色更有质感。 */
export function entityAvatarSx(name: string, isEmoji = false) {
  const h = hashHue(name || "?");
  return {
    width: 40,
    height: 40,
    flexShrink: 0,
    color: "#fff",
    fontWeight: 600,
    fontSize: isEmoji ? 22 : 15,
    backgroundImage: `linear-gradient(140deg, hsl(${h}, 58%, 52%), hsl(${(h + 34) % 360}, 52%, 34%))`,
    boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.14)",
  };
}

/** 图标底托（技能 emoji / MCP 图标）：带同色相淡底的圆角方块，比裸 emoji 更像一枚图标。 */
export function iconTileSx(name: string) {
  const h = hashHue(name || "?");
  return {
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: CARD_ICON_RADIUS,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 18,
    lineHeight: 1,
    bgcolor: `hsla(${h}, 55%, 50%, 0.16)`,
    border: "1px solid",
    borderColor: `hsla(${h}, 55%, 50%, 0.28)`,
  };
}

/** 卡片内的信息标签（技能 / 成员 / 内置）：低对比软底，不抢标题。 */
export const cardChipSx: SxProps<Theme> = {
  height: 24,
  fontSize: 11.5,
  borderRadius: "8px",
  bgcolor: "action.hover",
  "& .MuiChip-label": { px: 1 },
};

/** 卡片内的描边标签（成员名 / 「N 技能」等次要信息）。 */
export const cardChipOutlinedSx: SxProps<Theme> = {
  height: 24,
  fontSize: 11.5,
  borderRadius: "8px",
  bgcolor: "transparent",
  borderColor: "divider",
  "& .MuiChip-label": { px: 1 },
};

/**
 * 语义色状态标签（连接状态 / 启用状态等）。
 * 只统一尺寸与圆角，**不设 bgcolor** —— 颜色交给 MUI 的 `color` /
 * `variant` 驱动（filled 语义色底会被 sx.bgcolor 覆盖掉，等于丢失状态信号）。
 */
export const cardStatusChipSx: SxProps<Theme> = {
  height: 24,
  fontSize: 11.5,
  borderRadius: "8px",
  "& .MuiChip-label": { px: 1 },
};

/** 多行截断：`clampLines(2)` 等价于 -webkit-line-clamp 两行省略。 */
export function clampLines(lines: number) {
  return {
    display: "-webkit-box",
    WebkitLineClamp: lines,
    WebkitBoxOrient: "vertical" as const,
    overflow: "hidden",
  };
}

/**
 * 卡片底部次级操作（编辑 / 删除）：常驻可点但降到半透明，hover 时才回到全亮。
 * 不做「hover 才出现」——它会牺牲可达性，且与「启用」开关正交、不该抢注意力。
 */
export const cardGhostActionSx: SxProps<Theme> = {
  textTransform: "none",
  minWidth: 0,
  p: 0.65,
  color: "text.secondary",
  opacity: 0.55,
  transition: "opacity .18s ease, color .18s ease, background-color .18s ease",
  "&:hover": { opacity: 1, color: "text.primary", bgcolor: "action.hover" },
};

/** 危险操作版本的次级操作（删除）：hover 才转成错误色。 */
export const cardGhostDangerSx: SxProps<Theme> = {
  textTransform: "none",
  minWidth: 0,
  p: 0.65,
  color: "text.secondary",
  opacity: 0.55,
  transition: "opacity .18s ease, color .18s ease, background-color .18s ease",
  "&:hover": { opacity: 1, color: "error.main", bgcolor: "action.hover" },
};

/** 头像 / 图标文字：emoji 原样放大展示，否则退回首字。 */
export function avatarGlyph(
  avatar: string | undefined,
  name: string | undefined,
): { glyph: string; isEmoji: boolean } {
  const raw = (avatar ?? name ?? "").trim();
  if (!raw) return { glyph: "?", isEmoji: false };
  const isEmoji = /\p{Extended_Pictographic}/u.test(raw);
  return {
    glyph: isEmoji ? raw : (name?.trim()?.[0] ?? raw[0] ?? "?"),
    isEmoji,
  };
}
