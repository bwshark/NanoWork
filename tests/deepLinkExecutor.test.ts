/**
 * 深链执行器（B4-02）的行为用例。
 *
 * 补这一层的理由：原先这段逻辑内联在 `App.tsx` 的 useEffect 里，渲染层整段
 * 「动作 → 选/建会话 → 预填」**零覆盖**（`deepLinkPrompt` 在 tests/ 里零命中）。
 * 于是键名一旦两边漂移，症状是「点深链接开了新会话，但输入框是空的」，
 * 而全量测试依然全绿——典型的静默失效。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createDeepLinkExecutor,
  deepLinkSessionTitle,
  type DeepLinkExecutorDeps,
} from '@/lib/core/deepLinkExecutor';
import {
  DEEP_LINK_PROMPT_KEY,
  readDeepLinkPrompt,
  type DeepLinkRouteState,
} from '@/types/deepLink';

function harness(chatRoute = '/chat') {
  const selected: string[] = [];
  const created: Array<{ session: undefined; title: string }> = [];
  const navigations: Array<{ to: string; state?: DeepLinkRouteState }> = [];
  const deps: DeepLinkExecutorDeps = {
    getSessions: () => ({
      selectSession: (id: string) => selected.push(id),
      createSession: (session: undefined, title: string) => created.push({ session, title }),
    }),
    navigate: (to: string, options?: { state?: DeepLinkRouteState }) =>
      navigations.push({ to, state: options?.state }),
    chatRoute,
  };
  const run = createDeepLinkExecutor(deps);
  return { run, selected, created, navigations };
}

describe('open-session', () => {
  it('选中目标会话并跳到聊天页', () => {
    const { run, selected, created, navigations } = harness();

    run({ kind: 'open-session', sessionId: 'sess-42' });

    expect(selected).toEqual(['sess-42']);
    // 打开既有会话不该顺手再建一条
    expect(created).toEqual([]);
    expect(navigations).toEqual([{ to: '/chat', state: undefined }]);
  });

  it('会话 id 为空也照样把 route 走完（坏链接不炸应用）', () => {
    const { run, selected, navigations } = harness();

    run({ kind: 'open-session', sessionId: '' });

    expect(selected).toEqual(['']);
    expect(navigations).toHaveLength(1);
  });
});

describe('new-chat', () => {
  it('建会话并把 prompt 经路由 state 传给聊天页', () => {
    const { run, selected, created, navigations } = harness();

    run({ kind: 'new-chat', prompt: '帮我看下昨天的数据' });

    expect(selected).toEqual([]);
    expect(created).toEqual([{ session: undefined, title: '帮我看下昨天的数据' }]);
    expect(navigations).toEqual([
      { to: '/chat', state: { [DEEP_LINK_PROMPT_KEY]: '帮我看下昨天的数据' } },
    ]);
  });

  it('prompt 为空串时标题回落「新会话」，且 state 仍带空串', () => {
    const { run, created, navigations } = harness();

    run({ kind: 'new-chat', prompt: '   ' });

    expect(created[0]?.title).toBe('新会话');
    expect(navigations[0]?.state).toEqual({ [DEEP_LINK_PROMPT_KEY]: '   ' });
  });

  it('prompt 超长时标题截到 24 字', () => {
    const { run, created } = harness();
    const long = 'x'.repeat(80);

    run({ kind: 'new-chat', prompt: long });

    expect(created[0]?.title).toBe(long.trim().slice(0, 24));
    expect(created[0]?.title).toHaveLength(24);
  });

  it('用的 chatRoute 由注入决定', () => {
    const { run, navigations } = harness('/index.html#/chat');

    run({ kind: 'open-session', sessionId: 'a' });

    expect(navigations[0]?.to).toBe('/index.html#/chat');
  });
});

describe('每次执行都取最新 store', () => {
  it('替换 getSessions 后新动作走新实现（不持有闭包快照）', () => {
    const selectedA: string[] = [];
    const selectedB: string[] = [];
    let useSecond = false;
    const run = createDeepLinkExecutor({
      getSessions: () =>
        useSecond
          ? { selectSession: (id: string) => selectedB.push(id), createSession: vi.fn() }
          : { selectSession: (id: string) => selectedA.push(id), createSession: vi.fn() },
      navigate: vi.fn(),
      chatRoute: '/chat',
    });

    run({ kind: 'open-session', sessionId: 'first' });
    useSecond = true;
    run({ kind: 'open-session', sessionId: 'second' });

    expect(selectedA).toEqual(['first']);
    expect(selectedB).toEqual(['second']);
  });
});

describe('路由 state 的读写契约', () => {
  it('App 写进去的值能被 ChatPage 读出来（键名同源）', () => {
    // 把执行器当成「写方」，readDeepLinkPrompt 当成「读方」，跑一次闭环，
    // 保证两侧不会因为字面量漂移而静默失配。
    const { run, navigations } = harness();
    const prompt = '深链带来的提示词';

    run({ kind: 'new-chat', prompt });

    const state = navigations[0]?.state;
    expect(readDeepLinkPrompt(state)).toBe(prompt);
  });

  it('非字符串或缺失一律按「没有」处理，不抛错', () => {
    expect(readDeepLinkPrompt(null)).toBeUndefined();
    expect(readDeepLinkPrompt(undefined)).toBeUndefined();
    expect(readDeepLinkPrompt('not an object')).toBeUndefined();
    expect(readDeepLinkPrompt({ [DEEP_LINK_PROMPT_KEY]: 42 })).toBeUndefined();
    expect(readDeepLinkPrompt({ [DEEP_LINK_PROMPT_KEY]: undefined })).toBeUndefined();
    expect(readDeepLinkPrompt({})).toBeUndefined();
  });

  it('空字符串仍是有效 prompt（等价于空白新会话）', () => {
    expect(readDeepLinkPrompt({ [DEEP_LINK_PROMPT_KEY]: '' })).toBe('');
  });
});

describe('deepLinkSessionTitle', () => {
  it('trim 后取前 24 字；全空白回落「新会话」', () => {
    expect(deepLinkSessionTitle('  短标题  ')).toBe('短标题');
    expect(deepLinkSessionTitle('')).toBe('新会话');
    expect(deepLinkSessionTitle('   ')).toBe('新会话');
    expect(deepLinkSessionTitle('y'.repeat(30))).toBe('y'.repeat(24));
  });
});
