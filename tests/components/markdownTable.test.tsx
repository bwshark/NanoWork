/**
 * 只读路径的表格渲染。
 *
 * 编辑器那条路（`richText.markdownToHtml`）已经单独测过；这一条管的是**另一半**：
 * 没有写权限的成员走 `MarkdownView`（react-markdown + remark-gfm），那里如果没开
 * GFM，表格会渲染成一行带竖线的文字 —— 读的人完全看不出那是一张表。
 */

import { describe, expect, it } from 'vitest';
import { MarkdownView } from '@/components/MarkdownView';
import { mount, waitForSettled } from '../helpers/reactMount';

describe('只读路径的表格渲染', () => {
  it('GFM 表格渲染成真表格', async () => {
    const host = mount(
      <MarkdownView content={'| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 30 |'} />,
    );
    // MarkdownView 是懒加载边界：要等真实的 import() 落地，不能用固定轮次的 flush
    await waitForSettled(() => host.querySelector('table') !== null);

    expect(host.querySelector('table')).toBeTruthy();
    expect(host.querySelectorAll('th').length).toBe(2);
    expect(host.querySelectorAll('td').length).toBe(2);
    expect(host.textContent).toContain('张三');
    // 不是「一行带竖线的文字」
    expect(host.textContent).not.toContain('| --- |');
  });
});
