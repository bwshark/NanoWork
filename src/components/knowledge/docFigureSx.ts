/**
 * 图片与图注的样式，**编辑器与阅读端共用一份**（与 `docTableSx` 同一套理由）。
 *
 * ## 为什么必须共用
 *
 * 图注现在是正文里的一行字（`<figcaption>`），不是藏在 `alt` 里的元数据。
 * 两端字号/对齐只要有一处不一致，用户就会以为「保存之后图注被改了样」——
 * 而真正的问题只是两份 CSS 各自维护。
 *
 * ## 三个刻意的决定
 *
 * 1. **空图注也要有高度**：`<figcaption></figcaption>` 没有内容时高度为 0，
 *    鼠标点不进去 —— 而「点进去写一句」正是这个功能的入口。
 * 2. **占位文字用 CSS `:empty::before`**，不写进 DOM：写进 DOM 就会被序列化进
 *    Markdown（`![点这里写一句图注](asset:x)`），图片瞬间多出一句假图注。
 * 3. **圆角写字符串**：`sx` 里的数字按 spacing 换算（`4` 实测会变成 40px）。
 *
 * 阅读端（`MarkdownRenderer`）用的是 `<span>` 包裹 + 内联样式，因为 react-markdown
 * 把图片放在 `<p>` 里，`<figure>` 嵌在 `<p>` 里是非法结构（浏览器会拆开）。
 * 那条路径只需要这里的**字号**常量，不必套这组选择器。
 */

/** 图注字号：与正文 14.5 拉开一档，读起来像"说明"而不是"下一段"。 */
export const FIGURE_CAPTION_FONT_SIZE = 12;

/** `scope` 是选择器前缀：编辑器用 `'&'`。 */
export function docFigureSx(scope: string) {
  return {
    [`${scope} figure`]: { my: 2, mx: 0, textAlign: 'center' },
    [`${scope} figure img`]: {
      maxWidth: '100%',
      height: 'auto',
      borderRadius: '6px',
      display: 'block',
      mx: 'auto',
    },
    [`${scope} figcaption`]: {
      mt: 0.75,
      fontSize: FIGURE_CAPTION_FONT_SIZE,
      lineHeight: 1.7,
      color: 'text.secondary',
      textAlign: 'center',
      // 空图注也有可点的位置（见文件头第 1 条）
      minHeight: '1.6em',
      outline: 'none',
    },
    ...(scope === '&'
      ? {
          [`${scope} figcaption:empty::before`]: {
            content: '"点这里写一句图注（会参与检索）"',
            color: 'text.disabled',
          },
        }
      : {}),
  };
}
