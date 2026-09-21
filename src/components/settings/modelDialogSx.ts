/**
 * 「添加 / 编辑模型」对话框的样式件。
 *
 * 抽出来的理由与 `SettingsPrimitives` 一致：字段标签、档位按钮在同一个弹窗里各出现
 * 好几次，每处各写一遍 `sx` 必然长歪（间距、字号、选中态各写各的）。
 *
 * **配色一律走 MUI palette / CSS 变量**，不硬编码：参考图是另一个应用（WorkBuddy 的
 * 纸面是 `#1f1f1f`、本项目深色纸面是 `#171a21`），照抄色值会在换主题时瞎掉。
 *
 * ⚠️ 这些对象会作为 `sx={[...]}` 的数组元素使用，**不能标注为 `SxProps`**
 * （`SxProps` 自带数组分支，作为数组元素会报类型不匹配），保持字面量推断即可
 * ——与 `@/components/skills/skillCardSx` 同一条约定。
 *
 * 版式对齐参考图（「供应商」与「完全自定义」两种情况共用一套外壳）：
 * 字段标签在控件**上方**、说明跟在标签同一行；「输入 / 输出」两个 token 字段**并排**
 * 各占一列、档位按钮贴在各自输入框下方；「高级配置」的四个勾选项排成一行。
 */

/**
 * 弹窗纸张：三段式外壳（头部钉住 / 正文滚动 / 底部钉住）。
 *
 * ⚠️ 这几条必须写在 `&.MuiDialog-paperScrollPaper` 里（特指度 0,2,0），不能裸写在 `sx` 上：
 * MUI 的 `MuiDialog-paperScrollPaper` 自带 `overflow-y: auto; max-height: calc(100% - 64px)`，
 * 与裸 `sx` 同为 (0,1,0)，谁生效取决于样式表先后——不可靠。`overflow: hidden` 是必须的，
 * 否则长内容会退化成整个弹窗一起滚（滚到标题都不见）。
 *
 * 90vh 而不是 86vh：这个表单是「一屏装得下就别滚」的形态，差的这 4vh 往往正好是
 * 「要不要多出一条滚动条」的分界。
 */
export const modelDialogPaperSx = {
  borderRadius: 2.5,
  '&.MuiDialog-paperScrollPaper': {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    maxHeight: '90vh',
  },
};

/** 头部：标题 + 右上角关闭 */
export const modelDialogHeadSx = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 1,
  px: 3,
  pt: 1.5,
  pb: 1,
};

/**
 * 正文：**唯一可滚动**的区域。
 *
 * `minHeight: 0` 是必需项且最常被漏：flex 子项默认 `min-height: auto`，会被内容高度撑破，
 * 于是滚动区不滚、整个弹窗反而溢出。
 */
export const modelDialogBodySx = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  px: 3,
  pb: 0.5,
};

/**
 * 底部：一行放「保存后设为默认」+ 取消 / 保存。
 *
 * 把勾选项放到底部而不是正文里另起一行：它是**保存这个动作的选项**（问的是「这次保存
 * 顺带设成默认吗」），贴着保存按钮才好读；顺带省下一整行的高度——这一行在正文里就是
 * 压出滚动条的那一点点。
 */
export const modelDialogFootSx = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 1,
  px: 3,
  pt: 1.25,
  pb: 2,
};

/**
 * 字段标签：位于控件**上方**。
 *
 * 不沿用「标签浮在输入框里」的写法：空值时标签与占位符长得一模一样，用户在
 * 「这个框要填什么」和「这里已经填了什么」之间没有区别可依据。
 */
export const fieldLabelSx = {
  fontSize: 12.5,
  fontWeight: 600,
  lineHeight: 1.4,
};

/**
 * 字段说明（比标签小一号、更淡），**与标签同一行**、靠右接在后面。
 *
 * 早期把它放在控件下方（贴着它注解的那个控件读），但那样每个字段要独占两行；
 * 这份表单有六项字段、每项都带一句说明，六行足以把弹窗压出滚动条。放在标签行里
 * 「标签 · 说明」读起来同样成立（说明本来就是「这个字段是什么意思」），
 * 一行装不下时 `flexWrap` 会自己折行，退回原来的形态。
 */
export const fieldHintSx = {
  fontSize: 12,
  color: 'text.secondary',
  lineHeight: 1.4,
};

/**
 * 标签行：标签 + 同行说明 + 行尾动作（「查看文档」）。
 *
 * 动作用 `ml: 'auto'` 顶到最右，而不是把整行改成 `space-between`：这样标签与说明
 * 仍然紧挨着（说明是标签的注解，被推到两头就断了关系），只有动作靠边。
 */
export const fieldLabelRowSx = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 0.75,
  flexWrap: 'wrap',
};

/**
 * 标签行尾的外链动作（「查看文档 ↗」）。
 *
 * 做成一颗**无边框的小按钮**而不是 `<a>`：桌面端点它要经主进程 `shell.openExternal`
 * 打开系统浏览器（渲染层 `<a target="_blank">` 在 Electron 里会开出一个新窗口，
 * 或者什么也不做），走 `platform.openUrl` 才有统一的成功/失败反馈。
 */
export const fieldActionSx = {
  ml: 'auto',
  flexShrink: 0,
  minWidth: 0,
  p: '2px 4px',
  borderRadius: '6px',
  fontSize: 12.5,
  fontWeight: 500,
  lineHeight: 1.4,
  textTransform: 'none',
  color: 'text.secondary',
  '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
};

/**
 * 供应商字标（参考图里那个「K」的形态）：18px 圆角方块 + 居中首字母。
 *
 * 不画各家 logo：目录里三十多家供应商，逐个维护品牌图标不可能保真，也活不过一次
 * 换主题。字标是从展示名推出来的，永远与标签一致（见 `providerMonogram`）。
 */
export const providerBadgeSx = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '18px',
  height: '18px',
  mr: 1,
  borderRadius: '5px',
  bgcolor: 'action.selected',
  color: 'text.primary',
  fontSize: 11,
  fontWeight: 700,
  lineHeight: 1,
};

/**
 * 输入控件的紧凑档（`TextField` / `Select` 共用）。
 *
 * MUI 的 `size="small"` 是 40px 高，六个控件就是 240px；把上下内边距从 8.5 收到 6、
 * 字号压到 13.5 之后降到 ~35px，视觉上仍是常规输入框，但省下的 30px 正好是
 * 「矮窗口下会不会多出一条滚动条」的分界（实测 700px 视口）。
 *
 * ⚠️ 内边距必须写成**带单位的字符串**：`sx` 里的裸数字是 spacing 倍数
 * （`paddingTop: 6` → `48px`），实测把输入框撑到 119px 高、整页多出一条滚动条。
 * 字号不受这条规则影响（`fontSize` 是字面量），但一起写成显式值更不容易读错。
 */
export const denseFieldSx = {
  '& .MuiOutlinedInput-input': {
    paddingTop: '6px',
    paddingBottom: '6px',
    fontSize: '13.5px',
  },
  '& .MuiSelect-select': {
    paddingTop: '6px',
    paddingBottom: '6px',
    paddingLeft: '12px',
    fontSize: '13.5px',
  },
};

/**
 * 输入框内的图标按钮（密码框的显示 / 隐藏）。
 *
 * MUI 的 `endAdornment` 自带 14px 右内边距，而它右侧一般还贴着别的东西（图里是
 * 「测试连接」），负外边距把这点视觉空隙收回来，免得窄窗口下挤掉输入文本的宽度。
 */
export const fieldAdornmentSx = {
  p: '2px',
  mr: '-2px',
  color: 'text.secondary',
  '&:hover': { color: 'text.primary' },
};

/** 区块标签（「高级配置」这一层），与字段标签同形但带下间距 */
export const sectionLabelSx = {
  ...fieldLabelSx,
  mb: 0.25,
};

/** 勾选行（复选框 + 文案）：`Checkbox` 图标 20px + 上下各 4 内边距，一行恒为 28 */
export const checkRowSx = {
  ml: 0,
  // 标签用 Typography 控制字号，这里只负责对齐与让出复选框那点内边距
  mr: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 0.5,
};

/** 勾选项文案（比字段标签轻一档：它是选项，不是字段名） */
export const checkLabelSx = {
  fontSize: 13.5,
  lineHeight: 1.5,
};

/**
 * 能力勾选行：四个勾选项排成一行（参考图版式）。
 *
 * 用 `flexWrap` + `columnGap` 而不是 `Grid`：这一行的项数将来可能增减，换行时
 * 行间距由 `rowGap` 单独控（`gap` 简写会把两者绑成同一个值，换行后行距会偏大）。
 */
export const capabilityRowSx = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: 1.5,
  rowGap: 0.25,
};

/**
 * 「输入 / 输出」两列：等宽并排，各自「标签 + 输入框 + 档位」一组。
 *
 * 并排而不是上下堆两行：两者的读数方式本来就是对照着看的（窗口与输出的比例），
 * 竖着排要来回扫视；顺带省下一半高度——这正是自定义分支里最占地方的一块。
 */
export const tokenGridSx = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  columnGap: 2,
  rowGap: 1,
};

/** 档位按钮行（贴在对应输入框下方） */
export const tokenChipRowSx = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 0.5,
  mt: 0.5,
};

/**
 * 档位按钮（裸文字形态，选中靠「加粗 + 底色」而不是边框，避免按钮宽度随状态跳动）。
 *
 * 选中态是**单选**：点已选中的档位不做事（取消选中只能靠清空输入框），
 * 这样「当前是什么」永远只有一处读得出来——输入框里的数字。
 */
export const tokenOptionSx = {
  minWidth: 0,
  minHeight: 26,
  px: 1,
  py: 0.25,
  borderRadius: '6px',
  fontSize: 12.5,
  fontWeight: 500,
  lineHeight: 1.4,
  color: 'text.secondary',
  '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
  '&[aria-pressed="true"]': {
    color: 'text.primary',
    fontWeight: 700,
    bgcolor: 'action.selected',
  },
};
