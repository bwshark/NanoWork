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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDeepLinkRouter,
  findDeepLinkArg,
  parseDeepLink,
  shouldResetRendererOnNavigation,
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

/**
 * 就绪态重置的判据（2026-10-21 C.5 真机抓到）。
 *
 * 这里的每一条都对应一次**静默失效**：判定放宽 → 深链被排队 → 永不送达 →
 * 「窗口被唤起、目标会话不打开，且全程零报错」。
 */
describe('shouldResetRendererOnNavigation', () => {
  it('同文档导航（pushState / replaceState）**不**重置', () => {
    // ⚠️ 这是修复的核心。深链执行器里就有 `navigate(chatRoute)`，
    // 它走 React Router → `pushState` → 触发 `did-start-loading`。
    // 若据此重置，ready 永久为 false → 此后所有深链都送不出去。
    expect(
      shouldResetRendererOnNavigation({ isSameDocument: true, isMainFrame: true }),
    ).toBe(false);
  });

  it('真换文档（整页重载 / HMR / 刷新）必须重置', () => {
    expect(
      shouldResetRendererOnNavigation({ isSameDocument: false, isMainFrame: true }),
    ).toBe(true);
  });

  it('子框架导航不重置（与主窗口的深链通道无关）', () => {
    expect(
      shouldResetRendererOnNavigation({ isSameDocument: false, isMainFrame: false }),
    ).toBe(false);
    expect(
      shouldResetRendererOnNavigation({ isSameDocument: true, isMainFrame: false }),
    ).toBe(false);
  });

  it('参数位置接错（拿到废弃的 url 字符串）时**不**重置', () => {
    // ⚠️ Electron 31 的 `did-start-navigation` 第一个参数就是 details；
    // 若按「(event, details)」的习惯写，拿到的其实是废弃的 `url: string`，
    // `isSameDocument` 恒 undefined。此时必须落在「不重置」这一侧——
    // 宁可漏一次重置，也不能把深链通道永久打死（且不报任何错）。
    expect(
      shouldResetRendererOnNavigation({
        isSameDocument: undefined as unknown as boolean,
        isMainFrame: true,
      }),
    ).toBe(false);
  });
});

/**
 * 静态判据：`electron/main.ts` 的接线不许退回 `did-start-loading`。
 *
 * ## 为什么必须有这条
 *
 * 上面那三条行为判据钉的是**纯函数**的语义。但真正决定线上行为的是
 * `main.ts` 里**挂了哪个事件**——把 `did-start-navigation` 换成
 * `did-start-loading`，纯函数照样全绿，线上却又是「深链全部卡死」。
 *
 * 纯函数判据覆盖不到这一层，只能直接读源码。
 */
describe('electron/main.ts 的就绪态重置接线（静态判据）', () => {
  // ⚠️ jsdom 下 `import.meta.url` 是 http(s) 协议，`fileURLToPath` 会抛
  // 「The URL must be of scheme file」。改用 cwd 拼绝对路径。
  const repoRoot = process.cwd();
  const mainSource = readFileSync(join(repoRoot, 'electron', 'main.ts'), 'utf-8');

  it('不许用 did-start-loading 重置就绪态（同文档导航会误触发）', () => {
    // ⚠️ 只查**订阅形式**（`on('did-start-loading'`），不查裸字符串：
    // 注释里提到这个事件名是必要的（解释为什么不能用它），按裸字符串查会误报。
    const subscriptions = mainSource.match(/\.on\(\s*'did-start-loading'/g) ?? [];
    expect(
      subscriptions.length,
      'electron/main.ts 又订阅 did-start-loading 了——它会被 pushState 误触发，' +
        '导致就绪态永久为 false、所有深链卡在队列里。改用 did-start-navigation + isSameDocument。',
    ).toBe(0);
  });

  it('改用 did-start-navigation 并经由 shouldResetRendererOnNavigation 判据', () => {
    expect(mainSource).toContain("'did-start-navigation'");
    expect(mainSource).toContain('shouldResetRendererOnNavigation(details)');
    // 重置必须真的接上（别只 import 不调用）。
    expect(mainSource).toContain('deepLinkRouter.resetRenderer()');
  });

  it('渲染层在窗口获得焦点时会重新上报就绪（队列卡死可自愈）', () => {
    const appSource = readFileSync(join(repoRoot, 'src', 'App.tsx'), 'utf-8');
    expect(appSource).toContain("window.addEventListener('focus'");
    expect(appSource).toContain('platform.appRendererReady()');
  });
});
