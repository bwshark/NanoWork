import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentHash } from '@/lib/contentHash';
import { hashContent } from '@/lib/workspaceKey';

/** 剥掉 `sha256:` 前缀，便于与标准向量比对 */
function bare(value: string): string {
  return value.replace(/^sha256:/, '');
}

describe('contentHash：标准向量（J-A1）', () => {
  it('空串', () => {
    expect(bare(contentHash(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('abc', () => {
    expect(bare(contentHash('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('The quick brown fox jumps over the lazy dog', () => {
    expect(bare(contentHash('The quick brown fox jumps over the lazy dog'))).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('带 sha256: 前缀（与 djb2 的裸 hex 可区分）', () => {
    expect(contentHash('abc').startsWith('sha256:')).toBe(true);
    expect(contentHash('abc')).toHaveLength(7 + 64);
  });
});

describe('contentHash：与 node:crypto 逐字节一致', () => {
  /**
   * 覆盖三种块边界：< 55 字节（单块）、= 55/56 字节（填充临界）、> 64 字节（多块）。
   * 纯 TS 实现最容易错的就是填充与多块，这里用权威实现兜住。
   */
  const cases = [
    'a',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(63),
    'x'.repeat(64),
    'x'.repeat(65),
    'x'.repeat(200),
    '中文产物内容 with 混合 🎉 emoji',
    '<html><body>销售周报看板</body></html>',
    '```ts\nconst a = 1;\n```',
  ];

  for (const text of cases) {
    it(`长度 ${text.length}：与 node:crypto 一致`, () => {
      const expected = createHash('sha256').update(text, 'utf8').digest('hex');
      expect(bare(contentHash(text))).toBe(expected);
    });
  }
});

describe('contentHash：确定性（J-A2）', () => {
  it('同输入恒等，异输入必异', () => {
    expect(contentHash('同内容')).toBe(contentHash('同内容'));
    expect(contentHash('同内容')).not.toBe(contentHash('同内容 '));
  });

  it('UTF-8 编码：中文与 emoji 不被当成 latin1', () => {
    // 若按 latin1 / UTF-16 编码，这两个值必然与 node:crypto 的 utf8 结果不同
    const expected = createHash('sha256').update('中文🎉', 'utf8').digest('hex');
    expect(bare(contentHash('中文🎉'))).toBe(expected);
  });
});

describe('contentHash 与 hashContent（djb2）不得互换（J-A3）', () => {
  it('形态可区分：前者带前缀且 64 位，后者裸 8 位十六进制', () => {
    const djb2 = hashContent('abc');
    expect(djb2).not.toContain(':');
    expect(djb2.length).toBeLessThanOrEqual(8);
    expect(contentHash('abc')).not.toBe(djb2);
  });

  it('两者对同一输入给出不同值（不是同一算法的两种写法）', () => {
    expect(bare(contentHash('abc'))).not.toBe(hashContent('abc'));
  });
});
