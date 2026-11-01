/**
 * 扩展 UI 地址换算（`src/lib/extension/extensionUrl.ts`）。
 *
 * 这段换算被主进程与渲染层**共用**（所以放在 `src/lib`）。它错一次的代价是
 * "界面请求的路径"与"主进程认的路径"不一致——两边各自都自洽，只有打开扩展时白屏，
 * 而这个模块本身不会报任何错。
 */

import { describe, expect, it } from 'vitest';
import {
  isExtensionHttpUrl,
  isExtensionSchemeUrl,
  toExtensionUrl,
} from '@/lib/extension/extensionUrl';

describe('toExtensionUrl', () => {
  it('包内相对路径变成协议 URL', () => {
    expect(toExtensionUrl('hello', './ui/index.html')).toBe('nanowork-ext://hello/ui/index.html');
  });

  it('去掉 `./` 前缀（否则两边可能解析出不同 pathname）', () => {
    expect(toExtensionUrl('hello', 'ui/index.html')).toBe('nanowork-ext://hello/ui/index.html');
  });

  it('反斜杠统一成正斜杠（Windows 上写清单很容易带 `\\`）', () => {
    expect(toExtensionUrl('hello', 'ui\\index.html')).toBe('nanowork-ext://hello/ui/index.html');
  });

  it('http(s) 地址原样返回（用户自己托管的界面不过协议）', () => {
    expect(toExtensionUrl('hello', 'https://example.com/app')).toBe('https://example.com/app');
    expect(toExtensionUrl('hello', 'http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/');
  });
});

describe('判定函数', () => {
  it('isExtensionHttpUrl 只认 http(s)', () => {
    expect(isExtensionHttpUrl('https://a')).toBe(true);
    expect(isExtensionHttpUrl('HTTP://a')).toBe(true);
    expect(isExtensionHttpUrl('nanowork-ext://a/b')).toBe(false);
    expect(isExtensionHttpUrl('./a.html')).toBe(false);
  });

  it('isExtensionSchemeUrl 用来决定要不要挂 postMessage 桥', () => {
    expect(isExtensionSchemeUrl('nanowork-ext://hello/index.html')).toBe(true);
    expect(isExtensionSchemeUrl('https://example.com')).toBe(false);
  });
});
