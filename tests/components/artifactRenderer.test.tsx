import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { click, mount, unmount } from '../helpers/reactMount';
import { ArtifactRenderer } from '@/components/ArtifactRenderer';
import type { Artifact } from '@/types';

/**
 * 产物渲染器的「预览 / 源码」双视图（html / markdown / mermaid 共用同一套容器）。
 *
 * 三类产物都只差「预览体」是什么，切换交互与源码高亮完全一致；断言里同时锁住
 * 「上游误判」的两种情况：非 html 的文件产物不该被当成页面、
 * 页面视图的 iframe 不该给 `allow-same-origin`（正文来自模型 / 文件）。
 */

const HTML_BODY = '<!DOCTYPE html><h1>贪吃蛇</h1>';

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: 'h1',
    type: 'html',
    title: 'snake.html',
    content: HTML_BODY,
    createdAt: '2026-09-30T00:00:00.000Z',
    ...over,
  };
}

afterEach(unmount);

describe('HTML 产物：页面 / 源码', () => {
  it('默认给页面：iframe 用 srcDoc 渲染正文，且不给 allow-same-origin', () => {
    const host = mount(<ArtifactRenderer artifact={artifact()} header={false} />);
    const frame = host.querySelector('iframe');
    expect(frame?.getAttribute('srcdoc')).toContain('贪吃蛇');
    // 只给 allow-scripts：正文来自模型，不能让它摸到父页面 DOM
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('点「源码」把页面换成高亮正文，再切回页面', () => {
    const host = mount(<ArtifactRenderer artifact={artifact()} header={false} />);

    act(() => {
      click(host.querySelector('[aria-label="源码"]'));
    });
    expect(host.querySelector('iframe')).toBeNull();
    // 高亮渲染器把源码明文放在 DOM 里
    expect(host.textContent).toContain('贪吃蛇');
    expect(host.textContent).toContain('<!DOCTYPE html>');

    act(() => {
      click(host.querySelector('[aria-label="预览"]'));
    });
    expect(host.querySelector('iframe')).toBeTruthy();
  });

  it('.html 文件产物走同一套视图（只差正文来源）', () => {
    const host = mount(
      <ArtifactRenderer
        artifact={artifact({ id: 'f1', type: 'file', language: 'html', path: 'D:/aa/snake.html' })}
        header={false}
      />,
    );
    expect(host.querySelector('iframe')).toBeTruthy();
    expect(host.querySelector('[aria-label="源码"]')).toBeTruthy();
  });

  it('其它语言的文件产物仍是纯代码高亮（不被误当成页面，也不给切换）', () => {
    const host = mount(
      <ArtifactRenderer
        artifact={artifact({ id: 'f2', type: 'file', language: 'typescript', content: 'const a = 1;' })}
        header={false}
      />,
    );
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('[aria-label="源码"]')).toBeNull();
  });
});

describe('markdown / mermaid：同样有「预览 / 源码」', () => {
  const MD = '# 标题\n\n- 一\n- 二\n';

  it('markdown 默认渲染文档，切「源码」显示原文（围栏与 .md 文件一致）', () => {
    const host = mount(
      <ArtifactRenderer artifact={artifact({ id: 'm1', type: 'markdown', content: MD })} header={false} />,
    );
    // 预览：MarkdownView 把 `# 标题` 渲染成标题元素，正文里不会出现 `#`
    expect(host.textContent).toContain('标题');
    expect(host.textContent).not.toContain('# 标题');

    act(() => {
      click(host.querySelector('[aria-label="源码"]'));
    });
    expect(host.textContent).toContain('# 标题');
  });

  it('.md 文件产物走同一套（语言为 markdown）', () => {
    const host = mount(
      <ArtifactRenderer
        artifact={artifact({ id: 'm2', type: 'file', language: 'markdown', content: MD })}
        header={false}
      />,
    );
    expect(host.querySelector('[aria-label="源码"]')).toBeTruthy();
    act(() => {
      click(host.querySelector('[aria-label="源码"]'));
    });
    expect(host.textContent).toContain('# 标题');
  });

  it('mermaid 默认给图（渲染态），可切源码排查语法', () => {
    const code = 'graph TD; A-->B;';
    const host = mount(
      <ArtifactRenderer artifact={artifact({ id: 'mm1', type: 'mermaid', content: code })} header={false} />,
    );
    // 预览态不是 Prism 的源码块（mermaid 在异步渲染，这里只断言「不是源码态」）
    expect(host.textContent).not.toContain('graph TD');

    act(() => {
      click(host.querySelector('[aria-label="源码"]'));
    });
    expect(host.textContent).toContain('graph TD');
  });
});
