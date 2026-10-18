/**
 * 深链解析与投递（B4-02）。
 *
 * 这里钉的是「错了解析」的**静默失效**：链接被系统交给应用、窗口也弹出来了，
 * 但目标会话没打开，且没有任何报错。三条最容易漏的路径：
 *
 * 1. 两种 authority 写法（`nanowork://x` vs `nanowork:///x`）只认了一种；
 * 2. 第二个实例的 argv 被吞掉（只唤起窗口、不执行动作）；
 * 3. 渲染层尚未挂上监听时 `send` → 链接丢失。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createDeepLinkRouter,
  findDeepLinkArg,
  parseDeepLink,
} from '../../electron/deepLink';

describe('parseDeepLink', () => {
  it('解析 open-session（host 形式）', () => {
    expect(parseDeepLink('nanowork://open-session?id=abc')).toEqual({
      kind: 'open-session',
      sessionId: 'abc',
    });
  });

  it('解析 open-session（三斜杠 / path 形式）', () => {
    expect(parseDeepLink('nanowork:///open-session?id=abc')).toEqual({
      kind: 'open-session',
      sessionId: 'abc',
    });
  });

  it('scheme / host 大小写不敏感', () => {
    expect(parseDeepLink('NANOWORK://Open-Session?id=abc')).toEqual({
      kind: 'open-session',
      sessionId: 'abc',
    });
  });

  it('接受 sessionId / session_id 别名', () => {
    expect(parseDeepLink('nanowork://open-session?sessionId=abc')).toEqual({
      kind: 'open-session',
      sessionId: 'abc',
    });
    expect(parseDeepLink('nanowork://open-session?session_id=abc')).toEqual({
      kind: 'open-session',
      sessionId: 'abc',
    });
  });

  it('空 id 是坏链接，不是「打开首页」', () => {
    // 放行会让渲染层去选一个不存在的会话，表现为「点了没反应」。
    expect(parseDeepLink('nanowork://open-session')).toBeNull();
    expect(parseDeepLink('nanowork://open-session?id=')).toBeNull();
    expect(parseDeepLink('nanowork://open-session?id=%20')).toBeNull();
  });

  it('超长 id 拒绝（外部输入先限长）', () => {
    expect(parseDeepLink(`nanowork://open-session?id=${'a'.repeat(129)}`)).toBeNull();
  });

  it('解析 new-chat 并解码 prompt', () => {
    expect(parseDeepLink('nanowork://new-chat?prompt=hello%20world')).toEqual({
      kind: 'new-chat',
      prompt: 'hello world',
    });
  });

  it('空 prompt 合法：等价于打开一个空白新会话', () => {
    expect(parseDeepLink('nanowork://new-chat')).toEqual({
      kind: 'new-chat',
      prompt: '',
    });
  });

  it('prompt 超长截断到 4000', () => {
    const action = parseDeepLink(`nanowork://new-chat?prompt=${'x'.repeat(5000)}`);
    expect(action).toEqual({ kind: 'new-chat', prompt: 'x'.repeat(4000) });
  });

  it('非本应用的 scheme / 未知动作 / 非 URL 一律忽略', () => {
    expect(parseDeepLink('https://open-session?id=abc')).toBeNull();
    expect(parseDeepLink('nanowork://drop-database?id=1')).toBeNull();
    expect(parseDeepLink('nanowork://')).toBeNull();
    expect(parseDeepLink('not a url')).toBeNull();
    expect(parseDeepLink('')).toBeNull();
  });
});

describe('findDeepLinkArg', () => {
  it('在 argv 中找到深链', () => {
    const argv = ['nanowork.exe', '--foo', 'nanowork://open-session?id=abc'];
    expect(findDeepLinkArg(argv)).toBe('nanowork://open-session?id=abc');
  });

  it('scheme 大小写不敏感，并去掉系统包上的引号', () => {
    expect(findDeepLinkArg(['app', '"NANOWORK://new-chat?prompt=hi"'])).toBe(
      'NANOWORK://new-chat?prompt=hi',
    );
  });

  it('没有深链时返回 null', () => {
    expect(findDeepLinkArg(['nanowork.exe', '--foo'])).toBeNull();
    expect(findDeepLinkArg([])).toBeNull();
  });
});

describe('createDeepLinkRouter', () => {
  it('渲染层未就绪时排队，报到后按序 flush', () => {
    const sent: string[] = [];
    const router = createDeepLinkRouter((action) => sent.push(action.kind));

    router.push({ kind: 'open-session', sessionId: 'a' });
    router.push({ kind: 'new-chat', prompt: 'b' });
    // 未就绪：一条都不该发出去（发出去就是静默丢）。
    expect(sent).toEqual([]);

    router.markRendererReady();

    expect(sent).toEqual(['open-session', 'new-chat']);
  });

  it('就绪后直接投递，不再排队', () => {
    const sent: string[] = [];
    const router = createDeepLinkRouter((action) => sent.push(action.kind));

    router.markRendererReady();
    router.push({ kind: 'open-session', sessionId: 'a' });

    expect(sent).toEqual(['open-session']);
  });

  it('页面重载后重新排队', () => {
    const sent: string[] = [];
    const router = createDeepLinkRouter((action) => sent.push(action.kind));

    router.markRendererReady();
    router.resetRenderer();
    router.push({ kind: 'open-session', sessionId: 'a' });

    expect(sent).toEqual([]);
    router.markRendererReady();
    expect(sent).toEqual(['open-session']);
  });

  it('队列有上限：只保留最近的 8 条', () => {
    const sent: string[] = [];
    const router = createDeepLinkRouter((action) =>
      sent.push(action.kind === 'open-session' ? action.sessionId : ''),
    );

    for (let i = 0; i < 10; i += 1) {
      router.push({ kind: 'open-session', sessionId: String(i) });
    }
    router.markRendererReady();

    expect(sent).toEqual(['2', '3', '4', '5', '6', '7', '8', '9']);
  });
});
