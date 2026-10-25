/**
 * 知识库页顶部说明文字（FR-4.7 向量检索）。
 *
 * 这句话原本是写死的，开了 embedder 就开始说谎。抽成纯函数之后，这里钉住的是
 * 「四种状态必须说出四句不同的话」——尤其 `hash` 那档必须写明**非语义**，
 * 否则它会被当成语义检索来用，然后「同义词搜不到」被当成 bug 报上来。
 */

import { describe, expect, it } from 'vitest';
import { KB_CAPTION_BASE, describeRetrieval } from '@/lib/kb/kbRetrievalCaption';
import type { KbRetrievalInfo } from '@/lib/kb/kbClient';

function info(overrides: Partial<KbRetrievalInfo> = {}): KbRetrievalInfo {
  return {
    mode: 'lexical',
    embedder: 'off',
    model: '',
    dim: 0,
    chunks: 10,
    indexed: 0,
    stale: false,
    error: '',
    ...overrides,
  };
}

describe('describeRetrieval', () => {
  it('还没拿到状态：只说与实现无关的部分，不猜引擎', () => {
    const caption = describeRetrieval(null);
    expect(caption.text).toBe(KB_CAPTION_BASE);
    expect(caption.text).not.toContain('向量');
    expect(caption.warning).toBe(false);
  });

  it('词法：明说未启用向量检索', () => {
    const caption = describeRetrieval(info());
    expect(caption.text).toContain('当前词法检索，向量检索未启用');
    expect(caption.warning).toBe(false);
  });

  it('哈希向量：必须写明「非语义，只认字面重合」', () => {
    const caption = describeRetrieval(
      info({ mode: 'hybrid', embedder: 'hash', model: 'hash:64', dim: 64, indexed: 10, stale: false }),
    );
    expect(caption.text).toContain('本地哈希向量（非语义，只认字面重合）');
    expect(caption.text).toContain('已索引 10/10 块');
    expect(caption.warning).toBe(false);
  });

  it('远程模型：用模型名，并给出覆盖率', () => {
    const caption = describeRetrieval(
      info({
        mode: 'hybrid',
        embedder: 'openai',
        model: 'text-embedding-v3',
        dim: 1024,
        chunks: 8,
        indexed: 8,
      }),
    );
    expect(caption.text).toContain('text-embedding-v3');
    expect(caption.text).toContain('已索引 8/8 块');
  });

  it('有块没建索引：给出待建块数并标记为需要注意', () => {
    const caption = describeRetrieval(
      info({ mode: 'hybrid', embedder: 'hash', model: 'hash:64', chunks: 10, indexed: 4, stale: true }),
    );
    expect(caption.text).toContain('有 6 块待建索引');
    expect(caption.warning).toBe(true);
  });

  it('配置有误：整句改成警示，且不再声称在做向量检索', () => {
    const caption = describeRetrieval(
      info({ embedder: 'openai', model: '', error: '缺 NANOWORK_KB_EMBED_BASE_URL' }),
    );
    expect(caption.text).toContain('检索配置有误');
    expect(caption.text).toContain('退回词法检索');
    expect(caption.text).not.toContain('已索引');
    expect(caption.warning).toBe(true);
  });

  it('indexed 大于 chunks（统计口径漂移）时不显示负数待建块', () => {
    const caption = describeRetrieval(
      info({ mode: 'hybrid', embedder: 'hash', model: 'hash:64', chunks: 2, indexed: 5, stale: false }),
    );
    expect(caption.text).not.toContain('-3');
    expect(caption.text).toContain('已索引 5/2 块');
  });
});
