import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearForTest,
  _sizeForTest,
  peekRichPayload,
  stashRichPayload,
} from '@/lib/richClipboard';

/**
 * richClipboard 单测：覆盖「复制降级链 × 粘贴命中缓存」这条核心链路的语义契约。
 *
 * 行为契约：
 * - stash 之后 peek 应能拿到原 payload；
 * - peek 是非消费型：同文本可反复取出（剪贴板本身可重复粘贴，应用层缓存语义与之对齐），
 *   条目生命周期只由 TTL / LRU / 同文本覆写管理；
 * - 同文本重复 stash 应覆盖最新一条；
 * - TTL/缓存上限用参数化时间与 _clearForTest 模拟，不依赖真实时间；
 * - 未 stash、或已被 TTL/LRU 淘汰的文本返回 null。
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

  it('stash 后 peek 能取到原 payload', () => {
    stashRichPayload('hello', '{"rich":"hello","attachments":[]}');
    expect(peekRichPayload('hello')).toBe('{"rich":"hello","attachments":[]}');
  });

  it('未命中时返回 null', () => {
    expect(peekRichPayload('not-stashed')).toBeNull();
  });

  it('peek 非消费型：同文本可反复取出同样的 payload，条目不被移除', () => {
    stashRichPayload('hello', '{"rich":"hello","attachments":[]}');
    expect(peekRichPayload('hello')).toBe('{"rich":"hello","attachments":[]}');
    expect(peekRichPayload('hello')).toBe('{"rich":"hello","attachments":[]}');
    expect(_sizeForTest()).toBe(1);
  });

  it('同文本重复 stash 后 peek 取到的是最新版', () => {
    stashRichPayload('hello', '{"rich":"hello","attachments":[]}');
    stashRichPayload('hello', '{"rich":"hello","attachments":[{"id":"new"}]}');
    expect(_sizeForTest()).toBe(1);
    expect(peekRichPayload('hello')).toBe(
      '{"rich":"hello","attachments":[{"id":"new"}]}',
    );
  });

  it('不同文本的 stash 互不影响，各取各的', () => {
    stashRichPayload('A', '{"id":"a"}');
    stashRichPayload('B', '{"id":"b"}');
    expect(peekRichPayload('A')).toBe('{"id":"a"}');
    expect(peekRichPayload('B')).toBe('{"id":"b"}');
    // 取出 B 不影响 A：再次取 A 仍命中
    expect(peekRichPayload('A')).toBe('{"id":"a"}');
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

  it('超过 TTL（5 分钟）的条目 peek 时返回 null', () => {
    stashRichPayload('hello', '{"rich":"hello"}');
    // 推进 5 分钟 + 1ms
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(peekRichPayload('hello')).toBeNull();
  });

  it('未超 TTL 时正常命中', () => {
    stashRichPayload('hello', '{"rich":"hello"}');
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(peekRichPayload('hello')).toBe('{"rich":"hello"}');
  });

  it('超出 LRU 上限（16）后旧条目被淘汰', () => {
    // stash 18 条不同文本
    for (let i = 0; i < 18; i += 1) {
      stashRichPayload(`text-${i}`, `{"i":${i}}`);
      vi.advanceTimersByTime(1); // 让时间戳递增，保证淘汰顺序稳定
    }
    expect(_sizeForTest()).toBeLessThanOrEqual(16);
    // 最先 stash 的两条应被淘汰
    expect(peekRichPayload('text-0')).toBeNull();
    expect(peekRichPayload('text-1')).toBeNull();
    // 后面的仍在
    expect(peekRichPayload('text-17')).toBe('{"i":17}');
  });
});
