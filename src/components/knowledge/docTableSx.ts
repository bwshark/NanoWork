/**
 * 文档表格的样式，**阅读端与编辑器共用一份**。
 *
 * ## 为什么必须共用
 *
 * 表格的可见性全靠几个被全局 reset 去掉的属性（`border-collapse`、边框、内边距）。
 * 这两处只要有一处漏了，那一处就变成「一堆没有边框的文字」—— 而另一处看着是好的，
 * 改的人会以为问题出在别处。写成函数让两处取同一份，漏不掉。
 *
 * ## 两个刻意的决定
 *
 * 1. **不设 `th` 的默认 `text-align`**：只读路径由 `remark-gfm` 输出 `align` 属性，
 *    而 `align` 是「表现提示」，优先级低于任何 CSS 声明 —— 这里写一句
 *    `text-align: left` 就会把只读路径的所有居中/右对齐全部抹掉。
 *    对齐只对 `[data-align]` 生效（那是编辑器自己的标记）。
 * 2. **空单元格给高度**：`<td></td>` 没有内容时行高为 0，鼠标点不进去，
 *    用户想填内容却找不到可点的位置。
 */

/** `scope` 是选择器前缀：编辑器用 `'&'`，阅读端用 `'& .md-body'`。 */
export function docTableSx(scope: string) {
  const cell = `${scope} th, ${scope} td`;
  return {
    [`${scope} table`]: {
      borderCollapse: 'collapse',
      width: '100%',
      my: 2,
      fontSize: 13,
    },
    [cell]: {
      border: '1px solid',
      borderColor: 'divider',
      px: 1,
      py: 0.5,
      minWidth: 64,
      verticalAlign: 'top',
    },
    [`${scope} th`]: { bgcolor: 'action.hover', fontWeight: 600 },
    [`${scope} td[data-align="center"], ${scope} th[data-align="center"]`]: {
      textAlign: 'center',
    },
    [`${scope} td[data-align="right"], ${scope} th[data-align="right"]`]: { textAlign: 'right' },
    // 空单元格：编辑器里内容包在 `<div>` 里，只读路径（remark-gfm）没有这层 ——
    // 两种形态都得给高度，否则那一格塌成 0 高，鼠标点不进去
    [`${scope} td:empty, ${scope} th:empty`]: { height: '1.6em' },
    [`${scope} td > div, ${scope} th > div`]: { minHeight: '1.4em' },
  };
}
