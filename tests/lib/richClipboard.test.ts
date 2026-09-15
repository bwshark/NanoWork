import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearForTest,
  _sizeForTest,
  stashRichPayload,
  takeRichPayload,
} from '@/lib/richClipboard';

/**
 * richClipboard 单测：覆盖「复制降级链 × 粘贴命中缓存」这条核心链路的语义契约。
 *
 * 行为契约：
 * - stash 之后 take 应能拿到原 payload；
 * - take 之后再次 take 同文本应拿不到（一消费一）——避免「粘贴在多处」时附件错位；
 * - 同文本重复 stash 应覆盖最新一条；
 * - TTL/缓存上限用参数化时间与 _clearForTest 模拟，不依赖真实时间；
 * - 不缓存无 payload 的占位（输入一致但内容为空应当不会触发消费）。
 */
describe('richClipboard 命中与覆写', () => {
  beforeEach(() => {
    _clearForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    _clearForTest();
  });

  it('stash 后 take 能取到原 payload', () => {
    stashRichPayload('hello', '{"rich":"hello","attachments":[]}');
    expect(takeRichPayload('hello')).toBe('{"rich":"hello","attachments":[]}');
  });

  it('未命中时返回 null', () => {
    expect(takeRichPayload('not-stashed')).toBeNull();
  });

  it('take 是即取即删：同文本再次 take 应返回 null', () => {
    stashRichPayload('hello', '{"rich":"hello","attachments":[]}');
    expect(takeRichPayload('hello')).not.toBeNull();
    expect(takeRichPayload('hello')).toBeNull();
  });

  it('同文本重复 stash 后 take 取到的是最新版', () => {
    stashRichPayload('hello', '{"rich":"hello","attachments":[]}');
    stashRichPayload('hello', '{"rich":"hello","attachments":[{"id":"new"}]}');
    expect(_sizeForTest()).toBe(1);
    expect(takeRichPayload('hello')).toBe(
      '{"rich":"hello","attachments":[{"id":"new"}]}',
    );
  });

  it('不同文本的 stash 互不影响，各取各的', () => {
    stashRichPayload('A', '{"id":"a"}');
    stashRichPayload('B', '{"id":"b"}');
    expect(takeRichPayload('A')).toBe('{"id":"a"}');
    expect(takeRichPayload('B')).toBe('{"id":"b"}');
    expect(takeRichPayload('A')).toBeNull();
  });
});

describe('richClipboard TTL 与 LRU', () => {
  beforeEach(() => {
    _clearForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    _clearForTest();
  });

  it('超过 TTL（5 分钟）的条目 take 时返回 null', () => {
    stashRichPayload('hello', '{"rich":"hello"}');
    // 推进 5 分钟 + 1ms
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(takeRichPayload('hello')).toBeNull();
  });

  it('未超 TTL 时正常命中', () => {
    stashRichPayload('hello', '{"rich":"hello"}');
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(takeRichPayload('hello')).toBe('{"rich":"hello"}');
  });

  it('超出 LRU 上限（16）后旧条目被淘汰', () => {
    // stash 18 条不同文本
    for (let i = 0; i < 18; i += 1) {
      stashRichPayload(`text-${i}`, `{"i":${i}}`);
      vi.advanceTimersByTime(1); // 让时间戳递增，保证淘汰顺序稳定
    }
    expect(_sizeForTest()).toBeLessThanOrEqual(16);
    // 最先 stash 的两条应被淘汰
    expect(takeRichPayload('text-0')).toBeNull();
    expect(takeRichPayload('text-1')).toBeNull();
    // 后面的仍在
    expect(takeRichPayload('text-17')).toBe('{"i":17}');
  });
});
