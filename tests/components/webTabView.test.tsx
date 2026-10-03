import { describe, expect, it } from 'vitest';
import { normalizeUrlInput, toFileUrl, urlHostLabel } from '@/components/artifacts/WebTabView';

/**
 * 网页标签的地址归一化。
 *
 * 这层很薄但**必须**测：它决定了「用户敲进来的东西能不能被加载」，而错法只有两种——
 * 少补协议（必然打不开）或放行 `javascript:`（等于让面板执行任意代码）。
 */
describe('normalizeUrlInput：地址栏输入 → 可加载 URL', () => {
  it('裸域名补 https', () => {
    expect(normalizeUrlInput('example.com')).toBe('https://example.com');
    expect(normalizeUrlInput('  example.com/a?b=1  ')).toBe('https://example.com/a?b=1');
  });

  it('本地地址补 http（补 https 必然连不上）', () => {
    expect(normalizeUrlInput('localhost:5176')).toBe('http://localhost:5176');
    expect(normalizeUrlInput('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
    expect(normalizeUrlInput('[::1]:3000')).toBe('http://[::1]:3000');
  });

  it('Windows 盘符路径转 file://（要早于「补 https」判断，否则被当成域名）', () => {
    expect(normalizeUrlInput('D:\\aa\\snake.html')).toBe('file:///D:/aa/snake.html');
    expect(normalizeUrlInput('D:/aa/snake.html')).toBe('file:///D:/aa/snake.html');
  });

  it('已带协议的 http / https / file 原样保留', () => {
    expect(normalizeUrlInput('https://a.com/x')).toBe('https://a.com/x');
    expect(normalizeUrlInput('http://a.com')).toBe('http://a.com');
    expect(normalizeUrlInput('file:///C:/x.html')).toBe('file:///C:/x.html');
  });

  it('拒绝 javascript: / data: 等协议（空串 = 不加载）', () => {
    expect(normalizeUrlInput('javascript:alert(1)')).toBe('');
    expect(normalizeUrlInput('data:text/html,<script>x</script>')).toBe('');
    expect(normalizeUrlInput('vbscript:msgbox(1)')).toBe('');
  });

  it('空串 / 全空白 → 空串', () => {
    expect(normalizeUrlInput('')).toBe('');
    expect(normalizeUrlInput('   ')).toBe('');
  });
});

describe('toFileUrl：本地绝对路径 → file://', () => {
  it('Windows 盘符（两种分隔符）与已有的 file: 都认', () => {
    expect(toFileUrl('D:\\aa\\snake.html')).toBe('file:///D:/aa/snake.html');
    expect(toFileUrl('D:/aa/snake.html')).toBe('file:///D:/aa/snake.html');
    expect(toFileUrl('file:///D:/aa/snake.html')).toBe('file:///D:/aa/snake.html');
  });

  it('Unix 绝对路径', () => {
    expect(toFileUrl('/home/u/a.html')).toBe('file:///home/u/a.html');
  });

  it('相对路径 / 空串 → 空串（没有「相对于谁」的答案，硬转会指向不明目录）', () => {
    expect(toFileUrl('aa/snake.html')).toBe('');
    expect(toFileUrl('   ')).toBe('');
  });
});

describe('urlHostLabel：标签上显示哪一段', () => {
  it('取主机名（含端口），丢掉路径 / 查询', () => {
    expect(urlHostLabel('https://example.com/a?b=1')).toBe('example.com');
    expect(urlHostLabel('http://localhost:5176/#/x')).toBe('localhost:5176');
  });

  it('不是 URL 时原样返回（空标签不会走到这里）', () => {
    expect(urlHostLabel('just-text')).toBe('just-text');
  });
});
