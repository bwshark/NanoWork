/**
 * 「选中文本 → 添加到对话」的 store 侧行为。
 *
 * 三条边界值得单独守：
 *
 * 1. **重复添加必须幂等**：气泡跟着鼠标松开走，同一段文字被连点两次是常态
 *    （用户会以为第一次没生效），出现两枚一模一样的胶囊就没法解释了。
 * 2. **上限只约束同一个会话**：别的会话的引用在切回去之前一直有效，
 *    拿它们占额度会出现「在 A 里加满 → 回到 B 加不进去」这种怪事。
 * 3. **没有可清理的东西时不写 state**：MessageStream 在每次会话切换时都无条件
 *    调 `pruneQuotes`，每次都回一个新数组会让订阅它的组件白重渲染一轮
 *    —— 这条用「数组引用是否原样返回」来钉，功能上看不出来。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionUiStore } from '@/stores/sessionUiStore';

const quoteIn = (sessionId: string, text: string, messageId = 'm1') => ({
  sessionId,
  messageId,
  text,
});

beforeEach(() => {
  useSessionUiStore.setState({ quotes: [] });
});

describe('引用列表：增删改查', () => {
  it('新增一条引用会带上生成的 id', () => {
    useSessionUiStore.getState().addQuote(quoteIn('s1', '国庆节假期'));
    const quotes = useSessionUiStore.getState().quotes;
    expect(quotes).toHaveLength(1);
    expect(quotes[0].id).toBeTruthy();
    expect(quotes[0]).toMatchObject({
      sessionId: 's1',
      messageId: 'm1',
      text: '国庆节假期',
    });
  });

  it('同一条原文重复添加是幂等的（连点两次不该出现两枚胶囊）', () => {
    const { addQuote } = useSessionUiStore.getState();
    addQuote(quoteIn('s1', '国庆节假期'));
    addQuote(quoteIn('s1', '国庆节假期'));
    expect(useSessionUiStore.getState().quotes).toHaveLength(1);
  });

  it('同一段文字来自不同消息 / 不同会话时算两条', () => {
    const { addQuote } = useSessionUiStore.getState();
    addQuote(quoteIn('s1', '国庆节', 'm1'));
    addQuote(quoteIn('s1', '国庆节', 'm2'));
    addQuote(quoteIn('s2', '国庆节', 'm1'));
    expect(useSessionUiStore.getState().quotes).toHaveLength(3);
  });

  it('removeQuote 按 id 精确删除', () => {
    const { addQuote } = useSessionUiStore.getState();
    addQuote(quoteIn('s1', 'A'));
    addQuote(quoteIn('s1', 'B'));
    const [first] = useSessionUiStore.getState().quotes;

    useSessionUiStore.getState().removeQuote(first.id);

    const rest = useSessionUiStore.getState().quotes;
    expect(rest).toHaveLength(1);
    expect(rest[0].text).toBe('B');
  });

  it('clearQuotes 清空全部（发送成功后调用）', () => {
    const { addQuote } = useSessionUiStore.getState();
    addQuote(quoteIn('s1', 'A'));
    addQuote(quoteIn('s2', 'B'));
    useSessionUiStore.getState().clearQuotes();
    expect(useSessionUiStore.getState().quotes).toHaveLength(0);
  });
});

describe('引用列表：会话切换时的清理', () => {
  it('只保留目标会话的引用', () => {
    const { addQuote } = useSessionUiStore.getState();
    addQuote(quoteIn('s1', 'A'));
    addQuote(quoteIn('s2', 'B'));

    useSessionUiStore.getState().pruneQuotes('s2');

    const quotes = useSessionUiStore.getState().quotes;
    expect(quotes).toHaveLength(1);
    expect(quotes[0].sessionId).toBe('s2');
  });

  it('传 null（没有活跃会话）时清空', () => {
    useSessionUiStore.getState().addQuote(quoteIn('s1', 'A'));
    useSessionUiStore.getState().pruneQuotes(null);
    expect(useSessionUiStore.getState().quotes).toHaveLength(0);
  });

  it('没有可清理的东西时不写 state —— 数组引用必须原样返回', () => {
    useSessionUiStore.getState().addQuote(quoteIn('s1', 'A'));
    const before = useSessionUiStore.getState().quotes;

    useSessionUiStore.getState().pruneQuotes('s1');

    // 引用相等 = zustand 不会通知订阅者 → 不会白重渲染一轮
    expect(useSessionUiStore.getState().quotes).toBe(before);
  });

  it('空列表上清理也不写 state', () => {
    const before = useSessionUiStore.getState().quotes;
    useSessionUiStore.getState().pruneQuotes('s1');
    expect(useSessionUiStore.getState().quotes).toBe(before);
  });
});

describe('引用列表：单会话条数上限', () => {
  it('超过上限时丢最旧的，只影响当前会话', () => {
    const { addQuote } = useSessionUiStore.getState();
    // 另一个会话的引用不该被这次溢出挤掉
    addQuote(quoteIn('other', '别的会话'));
    for (let i = 0; i < 25; i += 1) addQuote(quoteIn('s1', `第 ${i} 条`));

    const quotes = useSessionUiStore.getState().quotes;
    expect(quotes.filter((q) => q.sessionId === 's1')).toHaveLength(20);
    expect(quotes.filter((q) => q.sessionId === 'other')).toHaveLength(1);
    // 最旧的几条被丢掉，最新的还在
    expect(quotes.some((q) => q.text === '第 0 条')).toBe(false);
    expect(quotes.some((q) => q.text === '第 24 条')).toBe(true);
  });
});
