import { describe, expect, it } from 'vitest';
// 高亮库真实使用的语法注册表：用来验证「归一化结果高亮库是否认得」，
// 而不是只验证我们自己的白名单里有没有抄了这个名字。
// 默认导入：该包是 `module.exports = refractor`（CJS），没有具名导出。
import refractor from 'refractor';
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

  /**
   * ⚠️ 2026-11-01 用户截图：`.html` 产物的「源码」页整屏白字。
   *
   * Prism 的语言表里**根本没有 `html` 这一项**（它叫 `markup`，`html` 只是别名），
   * 而别名表当时只有 `htm: 'html'` —— 于是 `htm` 映射到一个非注册名、`html` 直接
   * 掉进「不认识 → undefined → 纯文本」。高亮库不会报错，只会静默不着色。
   */
  it('⚠️ html / htm 必须映射到 Prism 注册名 markup（否则源码视图整屏白字）', () => {
    expect(normalizeCodeLanguage('html')).toBe('markup');
    expect(normalizeCodeLanguage('HTML')).toBe('markup');
    expect(normalizeCodeLanguage('language-html')).toBe('markup');
    expect(normalizeCodeLanguage('htm')).toBe('markup');
  });

  /**
   * 防漂移：`LANGUAGE_EXTENSION` 里列出的每个高亮语言都必须真能归一化出来，
   * 且归一化结果必须是高亮库**认得**的名字。
   *
   * 上一版的 `html: 'html'` 就是这么骗人的 —— 表里明明写着「支持 html」，
   * 归一化却不认它，而两处代码各自看都像对的。
   */
  it('扩展名表里列出的高亮语言，必须都能归一化并被 Prism 识别', () => {
    const mustHighlight = [
      // `html` / `htm` 放在这里才挡得住「别名表被删回去」的回归：
      // 它们不是 Prism 注册名，但产物面板会把扩展名（`html`）原样当 language 传。
      'html', 'htm', 'markup',
      'json', 'json5', 'jsonp', 'javascript', 'jsx', 'typescript', 'tsx',
      'python', 'bash', 'shell-session', 'powershell', 'markdown',
      'xml', 'css', 'scss', 'less', 'yaml', 'toml', 'ini', 'properties',
      'sql', 'graphql', 'diff', 'makefile', 'docker', 'mermaid', 'csv',
      'java', 'kotlin', 'swift', 'dart', 'go', 'rust', 'csharp', 'cpp', 'c',
      'php', 'ruby', 'lua', 'r', 'objectivec', 'matlab', 'protobuf', 'latex',
      'nginx', 'http', 'log',
    ];
    const notNormalized = mustHighlight.filter(
      (l) => normalizeCodeLanguage(l) === undefined,
    );
    expect(notNormalized, '这些语言被归一化成了纯文本').toEqual([]);

    const notInPrism = mustHighlight.filter(
      (l) => !refractor.registered(normalizeCodeLanguage(l) as string),
    );
    expect(notInPrism, '归一化结果不是 Prism 的注册名').toEqual([]);
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
