/**
 * 图注（图片下方那行可编辑的说明）。
 *
 * 这一条功能的价值全在**「能改」和「改完还在」**上：图注是图片在检索里唯一的信号
 * （图片本体不进切块、不进向量），而它原来藏在 `alt` 里 —— 用户看不见，自然也
 * 改不了。所以这里测的不是「有个标签」，而是：
 *
 * 1. 编辑器把图片渲染成 `<figure>`，图注是**正文里一行字**；
 * 2. 改那一行之后，序列化出来的 Markdown 里图注真的变了（不是只改了 DOM）；
 * 3. 没有写权限的人（只读路径）也**看得见**图注 —— 否则同一个人换个身份就
 *    以为图注丢了。
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocEditor } from '@/components/knowledge/DocEditor';
import { MarkdownView } from '@/components/MarkdownView';
import { mount, unmount, waitForSettled } from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
});

/** 在编辑器里「打字」：改掉图注的文本，再派发 input（编辑器就是靠它同步的）。 */
function typeCaption(host: HTMLElement, text: string): void {
  const caption = host.querySelector('figcaption');
  expect(caption).toBeTruthy();
  act(() => {
    caption!.textContent = text;
    caption!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('编辑器里的图注', () => {
  it('图片渲染成 figure + figcaption（图注看得见、点得进去）', () => {
    const host = mount(
      <DocEditor
        docKey="doc-1"
        markdown={'前一段\n\n![系统架构](asset:abc123)\n\n后一段'}
        onChange={() => {}}
      />,
    );

    const figure = host.querySelector('figure');
    expect(figure).toBeTruthy();
    expect(figure!.querySelector('img')?.getAttribute('src')).toBe('asset:abc123');
    expect(figure!.querySelector('figcaption')?.textContent).toBe('系统架构');
  });

  it('改完图注，onChange 收到的是新图注（不是只改了 DOM）', () => {
    const onChange = vi.fn();
    const host = mount(
      <DocEditor docKey="doc-1" markdown={'![系统架构](asset:abc123)'} onChange={onChange} />,
    );

    typeCaption(host, '系统架构（2026 年改版）');

    expect(onChange).toHaveBeenLastCalledWith('![系统架构（2026 年改版）](asset:abc123)');
  });

  it('图注清空后正文里不留空壳（图还在，说明没了）', () => {
    const onChange = vi.fn();
    const host = mount(
      <DocEditor docKey="doc-1" markdown={'![系统架构](asset:abc123)'} onChange={onChange} />,
    );

    typeCaption(host, '');

    expect(onChange).toHaveBeenLastCalledWith('![](asset:abc123)');
  });

  it('句子中间的图片不进 figure（那里没有「下方」这个位置）', () => {
    const host = mount(
      <DocEditor docKey="doc-1" markdown={'看图 ![架构](asset:abc) 就懂'} onChange={() => {}} />,
    );

    expect(host.querySelector('figure')).toBeNull();
    expect(host.querySelector('img')).toBeTruthy();
  });
});

describe('只读路径的图注', () => {
  it('打开 showImageCaptions 时图注显示在图片下方', async () => {
    const host = mount(
      <MarkdownView
        content={'![系统架构](blob:http://localhost/1)'}
        allowBlobUrls
        showImageCaptions
      />,
    );
    // MarkdownView 是懒加载边界：要等真实的 import() 落地
    await waitForSettled(() => host.querySelector('img') !== null);

    expect(host.textContent).toContain('系统架构');
  });

  it('默认不显示（对话消息里的 alt 多半是文件名，显示出来只是噪声）', async () => {
    const host = mount(<MarkdownView content={'![IMG_20260101.png](https://e.com/a.png)'} />);
    await waitForSettled(() => host.querySelector('img') !== null);

    expect(host.querySelector('img')).toBeTruthy();
    expect(host.textContent).not.toContain('IMG_20260101');
  });
});
