import { describe, expect, it } from 'vitest';
import {
  downloadSpecFor,
  extensionForLanguage,
  mimeForExtension,
  normalizeCodeLanguage,
} from '@/lib/artifact/fileType';
import type { Artifact } from '@/types';

/**
 * 围栏语言归一化 + 下载命名。
 *
 * 两个 bug 各锁几条：`nanowork-expert` 围栏（内容是 JSON）不着色、
 * 所有产物下载都变成 `.txt`。
 */

const JSON_BODY = '{\n  "kind": "agent",\n  "name": "Web GIS"\n}';

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: 'a1',
    type: 'code',
    title: '代码块 (json) 1',
    content: JSON_BODY,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

describe('normalizeCodeLanguage：围栏语言 → Prism 注册名', () => {
  it('常见简写走别名表', () => {
    expect(normalizeCodeLanguage('ts')).toBe('typescript');
    expect(normalizeCodeLanguage('yml')).toBe('yaml');
    expect(normalizeCodeLanguage('py')).toBe('python');
    expect(normalizeCodeLanguage('sh')).toBe('bash');
    expect(normalizeCodeLanguage('language-js')).toBe('javascript');
  });

  it('产品围栏（模型写的自造名字）按约定映射到 json', () => {
    // 名字不是任何高亮器认识的语法，但内容 schema 就是 JSON
    expect(normalizeCodeLanguage('nanowork-expert', JSON_BODY)).toBe('json');
    expect(normalizeCodeLanguage('nanowork-expert-team', '{"name":"团"}')).toBe('json');
  });

  it('Prism 已注册的名字原样通过（大小写不敏感）', () => {
    expect(normalizeCodeLanguage('json')).toBe('json');
    expect(normalizeCodeLanguage('Rust')).toBe('rust');
    expect(normalizeCodeLanguage('markdown')).toBe('markdown');
  });

  it('完全不认识的名字：能 JSON.parse 就按 json，否则退回纯文本', () => {
    expect(normalizeCodeLanguage('xx-config', JSON_BODY)).toBe('json');
    expect(normalizeCodeLanguage('xx-config', '# 标题\n正文')).toBeUndefined();
    // 只「像」JSON 但解析不了 → 不能强行着色成 json（会得到一串语法错误标记）
    expect(normalizeCodeLanguage('xx-config', '{ 半截')).toBeUndefined();
  });

  it('无语言围栏同样按内容嗅探；明确写 text 的一律纯文本', () => {
    expect(normalizeCodeLanguage(undefined, JSON_BODY)).toBe('json');
    expect(normalizeCodeLanguage(undefined, 'hello')).toBeUndefined();
    expect(normalizeCodeLanguage('text', JSON_BODY)).toBeUndefined();
    expect(normalizeCodeLanguage('plaintext', JSON_BODY)).toBeUndefined();
  });
});

describe('extensionForLanguage / mimeForExtension', () => {
  it('语言 → 扩展名（含产品围栏的兜底）', () => {
    expect(extensionForLanguage('json')).toBe('json');
    expect(extensionForLanguage('typescript')).toBe('ts');
    expect(extensionForLanguage('markdown')).toBe('md');
    expect(extensionForLanguage('yaml')).toBe('yml');
    // 旧版本落库的产物存的是原始围栏名，也要能推出 .json
    expect(extensionForLanguage('nanowork-expert', JSON_BODY)).toBe('json');
    expect(extensionForLanguage(undefined, JSON_BODY)).toBe('json');
    // 实在认不出来：纯文本
    expect(extensionForLanguage('whatever', '纯文本')).toBe('txt');
  });

  it('MIME 不认识时保守回落 text/plain', () => {
    expect(mimeForExtension('json')).toBe('application/json');
    expect(mimeForExtension('svg')).toBe('image/svg+xml');
    expect(mimeForExtension('txt')).toBe('text/plain');
    expect(mimeForExtension('weird')).toBe('text/plain');
  });
});

describe('downloadSpecFor：按类型给扩展名', () => {
  it('代码产物：标题 + 语言扩展名（不再是 .txt）', () => {
    expect(downloadSpecFor(artifact({ language: 'json' }))).toEqual({
      fileName: '代码块 (json) 1.json',
      mimeType: 'application/json',
    });
    // 落库时 language 还是原始围栏名（旧数据）→ 靠内容嗅探仍是 .json
    expect(downloadSpecFor(artifact({ language: 'nanowork-expert' })).fileName).toBe(
      '代码块 (json) 1.json',
    );
  });

  it('渲染类别各自固定扩展名：html / svg / markdown / mermaid', () => {
    const ext = (a: Partial<Artifact>) => downloadSpecFor(artifact(a)).fileName.split('.').pop();
    expect(ext({ type: 'html', title: 'HTML 片段 1' })).toBe('html');
    expect(ext({ type: 'svg', title: 'SVG 图形 1' })).toBe('svg');
    expect(ext({ type: 'markdown', title: 'Markdown 文档 1' })).toBe('md');
    expect(ext({ type: 'mermaid', title: '流程图 1' })).toBe('mmd');
  });

  it('标题已带同名扩展名时不重复追加', () => {
    expect(downloadSpecFor(artifact({ type: 'html', title: 'snake.html' })).fileName).toBe(
      'snake.html',
    );
  });

  it('文件产物用磁盘上的真名，扩展名以路径为准', () => {
    expect(
      downloadSpecFor(
        artifact({ type: 'file', title: '报告', path: 'D:/aa/报告.md', language: 'markdown' }),
      ),
    ).toEqual({ fileName: '报告.md', mimeType: 'text/markdown' });
  });

  it('标题里的非法字符（路径分隔符、冒号、问号…）被换成短横', () => {
    expect(downloadSpecFor(artifact({ title: 'a/b:c*?"<>|d' })).fileName).toBe('a-b-c-d.json');
  });

  it('图片 / 视频按外链扩展名，缺省给 png / mp4', () => {
    expect(
      downloadSpecFor(artifact({ type: 'image', title: '图 1', url: 'https://x/y.webp' })).fileName,
    ).toBe('图 1.webp');
    expect(downloadSpecFor(artifact({ type: 'video', title: '视频 1' })).fileName).toBe('视频 1.mp4');
  });
});
