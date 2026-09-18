/**
 * 技能页（「全部技能」市场 / 「我安装的」）的视觉令牌。
 *
 * 与 `@/lib/cardSx` 的通用卡片不同，技能卡按参考样式**静止态不画描边**：
 * 靠 `background.paper` 与页面底色的微弱差表达「这是一张卡」，hover 时才显形描边并浮起。
 * 因此这里不能直接复用 `hoverCardSx`（它在静止态就带 divider 描边）。
 *
 * 注意：这些对象会作为 `sx={[...]}` 的数组元素使用，不能标注为 `SxProps`
 * （`SxProps` 自带数组分支，作为数组元素会报类型不匹配），保持字面量推断即可。
 */

/**
 * 技能网格：两个视图共用列宽策略。
 *
 * 220px 是按**实测**容器宽度反推的，不是估的：1280px 窗口下侧栏占掉 240px，
 * 页面容器 `maxWidth: 1100` + `p: 3` 之后网格可用宽度是 992px。
 * 4 列需要 `4w + 3×16 ≤ 992` → `w ≤ 236`；写成 240px 就会塌成 3 列
 * （正是参考样式与实现的差异所在）。取 220px 留出余量，
 * 同时保证窗口变宽时（容器封顶 1100 → 可用 1052px）仍然是 4 列而不是跳到 5 列。
 */
export const skillGridSx = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 2,
  // 市场卡 hover 会展开描述而变高：顶对齐，避免同排其他卡片被一起拉长
  alignItems: 'flex-start' as const,
};

/**
 * 卡片骨架。
 *
 * 静止态写的是**透明**描边而不是 `none`：hover 时描边显形不会引起 1px 的尺寸跳动。
 * `position: relative` 是为了让 hover 的 `zIndex` 生效（否则同排卡片的阴影会被后来者盖住）。
 */
export const skillCardBaseSx = {
  position: 'relative' as const,
  bgcolor: 'background.paper',
  border: '1px solid transparent',
  borderRadius: '12px',
  transition:
    'background-color .18s ease, border-color .18s ease, box-shadow .18s ease, opacity .18s ease',
  '&:hover': {
    bgcolor: 'var(--hover-surface)',
    borderColor: 'var(--hover-border)',
    boxShadow: 'var(--hover-shadow)',
    zIndex: 2,
  },
};

/**
 * 市场卡：整卡可点（打开详情），hover 时描述从 2 行展开为全文。
 *
 * 展开用 CSS `:hover` 直接改 `-webkit-line-clamp`，不进 React 状态：
 * 这是纯粹的视觉反馈，走状态会让每张卡在鼠标划过时各重渲染一次。
 */
export const skillMarketCardSx = {
  ...skillCardBaseSx,
  cursor: 'pointer',
  '&:hover .skill-desc': {
    WebkitLineClamp: 'unset' as const,
    display: 'block' as const,
  },
};

/** 已安装卡：整卡可点（打开详情），禁用态整体压暗但仍留在列表里（可再次启用）。 */
export const skillInstalledCardSx = {
  ...skillCardBaseSx,
  cursor: 'pointer',
  // 80px 足够放下「⋯ + 仅手动调用」两个 28px 按钮，留一点余量避免 hover 瞬时抖动
  '&:hover .skill-card-actions': {
    maxWidth: 80,
    opacity: 1,
    pointerEvents: 'auto' as const,
  },
  '&:focus-within .skill-card-actions': {
    maxWidth: 80,
    opacity: 1,
    pointerEvents: 'auto' as const,
  },
};

/**
 * 卡片右上角的次级操作区（⋯ / 仅手动调用）：静止态隐形，hover 或键盘聚焦才显形。
 *
 * 静止态必须**真的不占宽**（`maxWidth: 0`），只把 `opacity` 打到 0 是不够的 ——
 * 两个 28px 的按钮会一直吃掉名称那一行的宽度，结果是「没 hover 也显示成
 * `Agent...`」这种莫名截断（参考样式里未 hover 的卡片名称是完整的）。
 *
 * 用 `maxWidth` 折叠而不是 `display: none`：后者的节点不在 tab 序列里，
 * 键盘用户永远够不到菜单；`maxWidth: 0` + `overflow: hidden` 仍然可聚焦，
 * 配合 `:focus-within` 展开，可达性不被样式牺牲。
 *
 * 显隐规则写在卡片的 `sx`（`skillInstalledCardSx`）里，这里只管自身排版与过渡。
 */
export const skillCardActionsSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.125,
  maxWidth: 0,
  overflow: 'hidden',
  opacity: 0,
  pointerEvents: 'none' as const,
  transition: 'max-width .18s ease, opacity .16s ease',
};

/** 卡片右上角的小图标按钮（⋯ / 仅手动调用 / 安装 +）：低对比，hover 提亮。 */
export const skillCardIconButtonSx = {
  p: 0.5,
  color: 'text.secondary',
  transition: 'color .18s ease, background-color .18s ease',
  '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
};

/** 安装「+」：与卡片同族的圆角方形描边按钮，hover 时描边提亮。 */
export const skillInstallButtonSx = {
  p: 0.5,
  width: 28,
  height: 28,
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: '9px',
  color: 'text.secondary',
  transition: 'border-color .18s ease, color .18s ease, background-color .18s ease',
  '&:hover': {
    borderColor: 'var(--hover-border)',
    color: 'text.primary',
    bgcolor: 'action.hover',
  },
};

/**
 * 「仅手动调用」按钮的激活态。
 *
 * 中间档（模型不可见、用户可挂载）是一个**用开关表达不出来**的状态，
 * 开关只能说明「能不能用」；不给它一个独立且显眼的位置，用户就会以为只有两档。
 * 因此激活时用语义色 + 浅底，和「开关仍开着」形成可区分的组合信号。
 */
export const skillManualOnlyActiveSx = {
  color: 'secondary.main',
  bgcolor: 'action.selected',
  '&:hover': { color: 'secondary.main', bgcolor: 'action.selected' },
};

/**
 * 自动触发开关。
 *
 * 尺寸按参考图**实测**反推：参考截图里开关轨道是 51×30 物理像素，
 * 同一张图里的 64px 图标量到 102 物理像素（缩放 1.6），换算下来约 32×19。
 * MUI `size="small"` 的 40×24 比它大一圈，在卡片右上角会显得笨重，
 * 所以这里连尺寸一起覆盖（滑块 16px、内边距 2px、checked 位移 14px）。
 *
 * checked 态把滑块改成白色、轨道改成实心 success —— MUI 默认的轨道半透明会让
 * 「开着」在深色卡片上糊成一团浅绿，看不出是个开关。
 */
export const skillSwitchSx = {
  mr: -0.25,
  width: 34,
  height: 20,
  p: 0,
  // 显式盖掉 `MuiSwitch-sizeSmall` 的宽高（同权重选择器谁在后面谁赢，不能靠运气）
  '&.MuiSwitch-sizeSmall': { width: 34, height: 20, p: 0 },
  '& .MuiSwitch-switchBase': {
    p: '2px',
    '&.Mui-checked': { transform: 'translateX(14px)', color: '#fff' },
  },
  '& .MuiSwitch-thumb': { width: 16, height: 16, boxShadow: 'none' },
  '& .MuiSwitch-track': { borderRadius: 10, opacity: 1 },
  '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': {
    bgcolor: 'success.main',
    opacity: 1,
  },
};

/** 描述文本：默认 2 行截断；行高锁死，hover 展开时文字不会上下抖动 */
export const skillDescSx = {
  mt: 1,
  fontSize: 12.5,
  lineHeight: 1.6,
  minHeight: 40,
  color: 'text.secondary',
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical' as const,
};

/** 无描边胶囊搜索框（参考图里比卡片底色更暗一档） */
export const skillSearchSx = {
  width: 220,
  '& .MuiOutlinedInput-root': {
    height: 34,
    borderRadius: '999px',
    bgcolor: 'action.hover',
    '& fieldset': { border: 'none' },
    '&:hover fieldset': { border: 'none' },
    '&.Mui-focused fieldset': { border: 'none' },
  },
  '& input': { fontSize: 13, py: 0.5 },
  '& .MuiInputAdornment-root': { color: 'text.secondary' },
};

/** 「我安装的 95」里的数量徽标 */
export const skillCountBadgeSx = {
  px: 1,
  py: 0.25,
  borderRadius: '999px',
  bgcolor: 'action.hover',
  color: 'text.secondary',
  fontSize: 12.5,
  fontWeight: 600,
  lineHeight: 1.6,
};

/** 小元信息标签（来源层级 / 不可手动调用）：只在市场弹窗用，卡片上是纯文字元信息 */
export const skillMetaChipSx = {
  height: 19,
  fontSize: 10.5,
  borderRadius: '6px',
  color: 'text.secondary',
  borderColor: 'divider',
  '& .MuiChip-label': { px: 0.75 },
};

/**
 * 分类胶囊。选中项靠一层浅底表达（参考图里没有下划线式 Tab），
 * 未选中项保持透明 —— 用底色而不是字重来做「当前项」的强信号。
 */
export function skillCategorySx(active: boolean) {
  return {
    minWidth: 0,
    px: 1.25,
    py: 0.5,
    fontSize: 13,
    fontWeight: active ? 600 : 500,
    lineHeight: 1.6,
    borderRadius: '8px',
    color: active ? 'text.primary' : 'text.secondary',
    bgcolor: active ? 'action.selected' : 'transparent',
    textTransform: 'none' as const,
    transition: 'background-color .16s ease, color .16s ease',
    '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
  };
}

/** 顶栏上的次级按钮（我安装的 / 批量管理）：弱底、无描边，不和主操作抢注意力 */
export const skillTopBarButtonSx = {
  textTransform: 'none' as const,
  color: 'text.secondary',
  px: 1,
  '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
};

/** 详情弹窗的纸面：比卡片更圆、去掉 hover 反馈（弹窗不需要浮起） */
export const skillDetailPaperSx = {
  borderRadius: '14px',
  border: '1px solid',
  borderColor: 'divider',
  backgroundImage: 'none',
  p: 3,
};

/** 详情弹窗里的信息面板（基本信息那一块）：比弹窗底色再暗一档的内嵌面板 */
export const skillInfoPanelSx = {
  borderRadius: '10px',
  bgcolor: 'action.hover',
  px: 2,
  py: 1.25,
};

/** 信息面板里的一行：定宽标签 + 可换行的取值 */
export const skillInfoRowSx = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 2,
  py: 0.625,
  '& + &': { borderTop: '1px solid', borderColor: 'divider' },
};

/** 信息行的标签列：固定宽度，保证多行取值左侧对齐 */
export const skillInfoLabelSx = {
  flexShrink: 0,
  width: 76,
  fontSize: 12.5,
  lineHeight: 1.7,
  color: 'text.secondary',
};

/** 信息行的取值列 */
export const skillInfoValueSx = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  lineHeight: 1.7,
  wordBreak: 'break-word' as const,
};

/* ------------------------------------------------------------------ *
 * 已安装技能的详情**窗口**（参考样式：居中浮层 + 固定头部 + 概述区独立滚动）
 * ------------------------------------------------------------------ */

/**
 * 窗口纸面。
 *
 * 与市场详情弹窗（`skillDetailPaperSx`）的区别不在大小，而在**滚动结构**：
 * 市场弹窗内容短，整张纸跟着滚就行；这个窗口里装的是 SKILL.md 全文，
 * 头部（图标 / 去试试 / 开关 / 关闭）与基本信息必须钉住不动，只有概述区自己滚 ——
 * 否则用户滚到代码块中段时，关窗和开关都找不到了。
 *
 * 高度用 `maxHeight` 而不是写死 `height`：没有正文的技能不该撑出一扇 730px 的空窗。
 * `overflow: hidden` 是让内部那个滚动区**自己**成立，否则纸面会先滚一层、
 * 概述区再滚一层，出现双层滚动条。
 *
 * 没有画描边：参考图里窗口与遮罩的亮度差（#1f1f1f vs #040404）已经足够分界，
 * 再加一条亮边会让浮层看起来像个内嵌面板。边界感交给 Dialog 自带的投影。
 */
export const skillWindowPaperSx = {
  display: 'flex',
  flexDirection: 'column' as const,
  p: 0,
  borderRadius: '16px',
  backgroundImage: 'none',
  overflow: 'hidden',
  maxHeight: 'min(730px, 88vh)',
};

/** 窗口头部：固定区（不参与滚动），左右内边距与正文对齐 */
export const skillWindowHeadSx = {
  flexShrink: 0,
  px: 3,
  pt: 3,
};

/** 头部正文（描述 + 基本信息 + 概述标题）：同样固定，只有概述正文滚 */
export const skillWindowBodySx = {
  flexShrink: 0,
  px: 3,
};

/**
 * 头部的次操作按钮（⋯）：常驻浅底圆角方块。
 *
 * 与卡片上的「⋯」刻意不同 —— 卡片是 hover 才显形（静止态要保持干净），
 * 这里常驻：窗口里它是**唯一**能进「编辑 / 打开文件夹 / 卸载」的入口，
 * 藏起来会让用户以为窗口里没有这些操作。
 */
export const skillWindowIconButtonSx = {
  width: 28,
  height: 28,
  borderRadius: '8px',
  color: 'text.secondary',
  bgcolor: 'action.hover',
  transition: 'color .18s ease, background-color .18s ease',
  '&:hover': { color: 'text.primary', bgcolor: 'action.selected' },
};

/** 头部的「关闭 ×」：无底色。关窗是「离开」，不该跟 ⋯ 一样有个实心块抢注意力 */
export const skillWindowPlainIconButtonSx = {
  width: 28,
  height: 28,
  borderRadius: '8px',
  color: 'text.secondary',
  transition: 'color .18s ease, background-color .18s ease',
  '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
};

/**
 * 窗口里的描述：默认 2 行截断。
 *
 * 描述是摘要，正文在下面的概述里；不截断会让「基本信息 / 概述」被一段长描述推到
 * 窗口底部之外。超长时才出现「展开」，短描述不会多出一个可点区域。
 */
export const skillWindowDescSx = {
  mt: 2.5,
  fontSize: 13.5,
  lineHeight: 1.75,
  whiteSpace: 'pre-wrap' as const,
};

/** 基本信息网格里的取值列：加粗。参考样式里取值比标签更醒目（标签是问句，取值才是答案） */
export const skillInfoGridValueSx = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  lineHeight: 1.7,
  fontWeight: 600,
  wordBreak: 'break-word' as const,
};

/**
 * 概述滚动区。
 *
 * 与窗口同宽的浅底面板，是窗口里**唯一**会滚的地方（`flex: 1` + `minHeight: 0`
 * 让它在内容超高时收下剩余空间，内容短时按自身高度收住，不会把窗口撑满）。
 */
export const skillOverviewBoxSx = {
  flex: 1,
  minHeight: 0,
  mx: 3,
  mb: 3,
  mt: 1.5,
  px: 2.5,
  py: 2,
  borderRadius: '12px',
  border: '1px solid',
  borderColor: 'divider',
  bgcolor: 'action.hover',
  overflowY: 'auto' as const,
};

/** 概述标题行里的搜索条（展开态）：与头部搜索同款的胶囊输入 + 计数 + 上下箭头 */
export const skillOverviewSearchSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.25,
  height: 28,
  width: 200,
  pl: 1,
  pr: 0.5,
  borderRadius: '8px',
  border: '1px solid',
  borderColor: 'divider',
  bgcolor: 'action.hover',
};

/** 窗口里的区块标题（「基本信息」「概述」）：图标 + 文字，与市场弹窗内同款 */
export const skillSectionTitleSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.75,
  mt: 3,
  mb: 1.25,
};

/**
 * 基本信息的两列网格。
 *
 * 一列一项太浪费横向空间（窗口宽 600，参考样式也是一行两个字段）；
 * 窄屏塌成一列。字段已收窄成版本 / 来源 / 分类三项（都是短值），
 * 所以 sm 断点下必定是「版本|来源」+「分类|（空）」两行。
 *
 * 不沿用 `skillInfoRowSx` 的分隔线：那条 `& + &` 是为了纵向堆叠时画中间横线，
 * 放进网格会给每行第二列也画一条，看起来像少了一格。
 */
export const skillInfoGridSx = {
  display: 'grid',
  gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
  columnGap: 4,
};

/** 网格里的一行：沿用弹窗的定宽标签，去掉分隔线 */
export const skillInfoGridRowSx = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 2,
  py: 0.5,
};

/** 概述正文排版：首末元素去掉外边距，避免滚动区上下多出一截空白 */
export const skillOverviewSx = {
  fontSize: 13,
  lineHeight: 1.75,
  color: 'text.primary',
  '& > :first-of-type': { mt: 0 },
  '& > :last-child': { mb: 0 },
};

/**
 * 详情页头部的主操作（去试试）：**浅色实底**，窗口里唯一的实心按钮。
 *
 * 参考样式里它是浅底深字，不是描边 —— 描边按钮在深色纸面上会被读成"和背景分离的
 * 一块"，而实底把它明确标成主操作。取色走 `--btn-strong-*` 变量（深色主题下反色）。
 */
export const skillTryButtonSx = {
  textTransform: 'none' as const,
  height: 28,
  px: 1.5,
  borderRadius: '8px',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--btn-strong-fg)',
  bgcolor: 'var(--btn-strong-bg)',
  '&:hover': { bgcolor: 'var(--btn-strong-bg-hover)' },
  // 停用态必须可辨：`去试试` 禁用是「技能停用了」的信号，不能只是淡淡地暗一点
  '&.Mui-disabled': { color: 'text.disabled', bgcolor: 'action.disabledBackground' },
};

