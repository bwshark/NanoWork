/**
 * 对话页的「内容列」几何。
 *
 * 消息流、输入框、快捷标签行**必须共用同一份**：它们在同一条竖轴上居中，
 * 各自写死 maxWidth / px 时，三条右边界会互相对不齐（实测 900+16、960+12、
 * 960+16 三种组合并存，最宽处差 18px），而用户气泡靠右对齐，右边界就是列右边界
 * ——于是助手内容旁边会空出一条竖带，看起来像没铺满。
 *
 * `px` 放在列容器上（而不是外层滚动容器上）也是刻意的：外层留白不参与居中计算，
 * 窄窗口下内容才不会比输入框多缩进一层。
 */
export const CHAT_COLUMN_MAX_WIDTH = 960;

/** 列容器左右内边距（MUI spacing 单位） */
export const CHAT_COLUMN_PX = 2;

/** 直接展开进 MUI `sx`：`sx={{ ...chatColumnSx, py: 1.5 }}` */
export const chatColumnSx = {
  width: '100%',
  maxWidth: CHAT_COLUMN_MAX_WIDTH,
  mx: 'auto',
  px: CHAT_COLUMN_PX,
} as const;
