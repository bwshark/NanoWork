/**
 * 读文件为 base64（上传文件的前置一步）。
 *
 * 两个容易只在真机上炸、单测里看不见的点：
 * 1. **大文件分块**：`String.fromCharCode(...bytes)` 在 MB 级会撑爆参数栈
 *    （`RangeError: Maximum call stack size exceeded`），小样本永远测不出来；
 * 2. **必须是原始字节**：用 `File.text()` 会把二进制按 UTF-8 解码，`.docx` 直接废掉。
 */

import { describe, expect, it } from 'vitest';
import { arrayBufferToBase64, readFileAsBase64 } from '@/lib/artifact/fileBase64';

describe('arrayBufferToBase64', () => {
  it('与 Buffer 的编码结果一致（"abc" 是教科书值）', () => {
    const buffer = new Uint8Array([0x61, 0x62, 0x63]).buffer;
    expect(arrayBufferToBase64(buffer)).toBe('YWJj');
  });

  it('空 buffer → 空串（不是 undefined）', () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('');
  });

  it('超过单块大小的数据也正确（这条才是分块的意义）', () => {
    // 100k 个 0xff：一次性展开会 RangeError，分块实现则正常
    const bytes = new Uint8Array(100_000).fill(0xff);
    const encoded = arrayBufferToBase64(bytes.buffer);
    // 每 3 字节 "////"，100000 = 3*33333 + 1 → 末尾补 "//"
    expect(encoded.length).toBe(Math.ceil(100_000 / 3) * 4);
    expect(encoded.slice(0, 4)).toBe('////');
  });

  it('往返一致（解码回来逐字节相同）', () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
    const decoded = Uint8Array.from(atob(arrayBufferToBase64(original.buffer)), (char) =>
      char.charCodeAt(0),
    );
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
});

describe('readFileAsBase64', () => {
  it('读出来的不带 data: 前缀（带了服务端会说「不是合法 base64」）', async () => {
    const file = new File([new Uint8Array([0x61, 0x62, 0x63])], 'a.txt');
    const encoded = await readFileAsBase64(file);
    expect(encoded).toBe('YWJj');
    expect(encoded.startsWith('data:')).toBe(false);
  });
});
