/**
 * `nanowork://` 深链的解析与投递（B4-02）。
 *
 * 只做两件事，且都不碰 Electron：
 *
 * 1. :func:`parseDeepLink` —— 把外部传入的 URL 收敛成**受控动作**。外部输入不可信
 *    （任何网页都能 `location.href = 'nanowork://…'`），所以这里只认两个 kind、
 *    两三个参数名，其余一律 `null`。**不认识就是忽略**，绝不把它当普通路径塞进路由。
 * 2. :func:`createDeepLinkRouter` —— 处理「动作比渲染层就绪更早」的竞态。
 *    冷启动 / 第二个实例唤起时，React 还没挂上监听；直接 `webContents.send` 会丢。
 *    这里的做法是先排队，等渲染层显式报告 ready 再 flush。
 *
 * 为什么抽成纯模块：`main.ts` 顶层跑不到单测（要起真 Electron）。而「深链解析错了」
 * 的后果是**静默无反应**——最需要用例钉住的一类缺陷。
 */

import type { DeepLinkAction } from '../src/types/deepLink';

/** 协议名。与 `builder.config.json` 的 `protocols.schemes` 必须一致。 */
export const DEEP_LINK_SCHEME = 'nanowork';

/** 会话 id / 提示词的长度上限：外部输入，先截断再进业务层。 */
const MAX_SESSION_ID = 128;
const MAX_PROMPT = 4000;

/** 未就绪时的排队上限。超了丢最旧的——深链是「一次性意图」，囤着没有意义。 */
const MAX_PENDING = 8;

function firstParam(
  params: URLSearchParams,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = params.get(name);
    if (value !== null) return value;
  }
  return null;
}

/**
 * 解析一条深链。不是本应用的合法动作时返回 `null`（调用方应静默忽略）。
 *
 * 支持两种 authority 写法，因为不同系统/工具给出的形式不一样：
 *
 * - `nanowork://open-session?id=abc`  → `hostname = "open-session"`
 * - `nanowork:///open-session?id=abc` → `hostname = ""`、`pathname = "/open-session"`
 */
export function parseDeepLink(raw: string): DeepLinkAction | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // 不是 URL（比如用户把 `nanowork://` 当普通参数传进来）→ 忽略。
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;

  // host 优先，path 兜底；两者都小写，避免 `NanoWork://Open-Session` 之类的大小写漂移。
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/^\/+/, '').toLowerCase();
  const kind = host || path;

  if (kind === 'open-session') {
    const id = (
      firstParam(url.searchParams, ['id', 'sessionId', 'session_id']) ?? ''
    ).trim();
    // 空 id 不是「打开首页」，而是**一条坏链接**：放行会让渲染层去选一个不存在的
    // 会话，表现为「点了没反应」——不如直接判非法。
    if (!id || id.length > MAX_SESSION_ID) return null;
    return { kind: 'open-session', sessionId: id };
  }

  if (kind === 'new-chat') {
    const prompt = (
      firstParam(url.searchParams, ['prompt', 'text']) ?? ''
    ).slice(0, MAX_PROMPT);
    // 空 prompt 合法：等价于「打开一个空白新会话」。
    return { kind: 'new-chat', prompt };
  }

  // 未知 kind：**静默忽略**。新增动作必须显式加在这里，不能让外部输入自由扩展路由。
  return null;
}

/**
 * 从 `process.argv` 里找第一条深链。
 *
 * Windows / Linux 把协议 URL 作为普通参数交给进程；macOS 走 `open-url` 事件
 * （见 `main.ts`），不走这里。第二实例唤醒主实例时，参数同样在 argv 里。
 */
export function findDeepLinkArg(argv: readonly string[]): string | null {
  const prefix = `${DEEP_LINK_SCHEME}:`;
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    const trimmed = arg.trim().replace(/^["']|["']$/g, '');
    if (trimmed.toLowerCase().startsWith(prefix)) return trimmed;
  }
  return null;
}

export interface DeepLinkRouter {
  /** 收到一条深链。渲染层就绪则立即投递，否则排队。 */
  push(action: DeepLinkAction): void;
  /** 渲染层报告「监听已挂上」：把排队动作按序 flush 出去。 */
  markRendererReady(): void;
  /** 页面开始重载：从此刻起新动作重新排队，避免发给即将销毁的旧页面。 */
  resetRenderer(): void;
}

/**
 * 一次导航事件里，**是否应当重置「渲染层已就绪」状态**。
 *
 * ## 为什么必须有这个判据（2026-10-21 C.5 真机抓到）
 *
 * 原先的接线是 `win.webContents.on('did-start-loading', () => resetRenderer())`。
 * 看起来合理——「页面开始加载了，旧监听要作废」——但 **`did-start-loading` 并不
 * 只在「换文档」时触发**。Electron 文档对它���描述是「对应标签页加载转圈的时点」，
 * 而 **同文档导航（`history.pushState` / `replaceState`）同样会触发它**。
 *
 * 后果是一条**静默失效**的链路：
 *
 * 1. 深链执行 → `navigate(chatRoute)` → React Router 调 `pushState`；
 * 2. `did-start-loading` 触发 → `resetRenderer()` → ready 变 false；
 * 3. 但页面**并没有真的重载**（同一个 document），渲染层的监听还活着，
 *    也就**不会**再次调用 `appRendererReady()`；
 * 4. ready 永久停在 false → 此后**所有**深链都堆在队列里送不出去。
 *
 * 症状是「窗口被唤起、目标会话不打开，且全程零报错」——最难自查的一类问题。
 *
 * ## 正确判据
 *
 * 用 `did-start-navigation` 的 `isSameDocument`：
 *
 * - `isSameDocument === false` → 真的换了文档（整页重载 / HMR / 刷新）→
 *   旧监听即将作废，**必须重置**；
 * - `isSameDocument === true` → 同文档导航（`pushState` / `replaceState` /
 *   锚点跳转）→ 监听一直活着，**不能重置**。
 *
 * 只重置「真换文档」这一种情况，既保住 HMR 期的安全性，又不误伤 SPA 内部路由。
 */
export function shouldResetRendererOnNavigation(details: {
  isSameDocument: boolean;
  isMainFrame: boolean;
}): boolean {
  // 子框架的导航与主窗口的深链通道无关；主框架才决定「渲染层还是不是原来那个」。
  if (!details.isMainFrame) return false;
  // ⚠️ **必须显式判 true**，不能写 `!details.isSameDocument`：
  // 若调用方把 Electron 回调的**参数位置**搞错（拿到的是废弃的 `url: string`），
  // `isSameDocument` 会是 undefined → `!undefined === true` → 判据恒为「要重置」
  // → 退化成修复前的行为，且**不报任何错**。显式判 true 让这种接错用法
  // 落到「不重置」这一侧（宁可漏重置，也不能把深链永久打死）。
  return details.isSameDocument === false;
}

/**
 * 让「导航到哪」与「什么时候能导航」解耦。
 *
 * @param send 真正投递给渲染层的方式（生产环境是 `webContents.send`）
 */
export function createDeepLinkRouter(
  send: (action: DeepLinkAction) => void,
): DeepLinkRouter {
  let ready = false;
  const pending: DeepLinkAction[] = [];

  return {
    push(action) {
      if (ready) {
        send(action);
        return;
      }
      if (pending.length >= MAX_PENDING) pending.shift();
      pending.push(action);
    },
    markRendererReady() {
      ready = true;
      // 按到达顺序 flush：两条深链连续到达时，用户期望的是「先打开 A，再打开 B」。
      while (pending.length > 0) {
        const next = pending.shift();
        if (next) send(next);
      }
    },
    resetRenderer() {
      ready = false;
    },
  };
}
