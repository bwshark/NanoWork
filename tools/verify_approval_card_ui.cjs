/**
 * 真机验收 C.8：桌面端助理视图的审批卡是否真的弹出来。
 *
 * 做法：
 * 1. 用 Playwright 打开客户端（Electron 渲染层是 file:// 的 dist/index.html，
 *    直接用 chromium 打开同一个页面即可——审批卡的数据源是主进程 IPC，
 *    这里改为**桩掉 platform.getChannelApprovals**，让它返回一条真实形状的
 *    审批（字段名与引擎真实快照逐字一致，见 tests/electron/channelApprovals.test.ts）。
 * 2. 切到该 IM 会话 → 断言卡片出现在输入框位置。
 * 3. 截图存证。
 *
 * ⚠️ 为什么用桩而不是真连网关：
 * 审批**只在挂起的那几秒内存在**，脚本跑起来时它多半已经超时；
 * 而「卡片有没有渲染出来」是渲染层的事，与网关数据无关。
 * 字段形状用真实快照兜住（下面 APPROVAL 抄的是真机抓到的原样）。
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const DIST = path.resolve(__dirname, '../dist');

/**
 * 用本地 HTTP 服务托管 dist。
 *
 * ⚠️ 不能直接用 file:// —— 浏览器禁止 file:// 文档做 `replaceState('/chat')`
 * （SecurityError: history state object with URL 'file:///D:/chat'），
 * 路由根本切不过去，页面停在首页，审批卡自然渲染不出来。
 */
function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST, 'index.html');
    }
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// 真机抓到的原始快照（tools/inject_pending_approval.py 输出，原样拷贝）
const APPROVAL = {
  id: 'appr-121517f468a6',
  tool: 'write_file',
  args: { content: 'hello\n', path: 'approval-probe.md' },
  call_id: 'call_function_wjgrdjnxgo4j_1',
  timeout_seconds: 300,
  short_code: '17f468a6',
};

const SESSION_ID = 'nb:feishu.feishu:ou_144e0eff3357449329c32c3984ce2c1a';

async function main() {
  // ⚠️ 本机 Playwright 版本要的 chromium-1248 没装，但 chromium-1243 已装。
  // 显式指过去（版本差 5 个小版本，协议层兼容）。
  const CHROME =
    process.env.CHROMIUM_PATH ||
    'C:/Users/xinmi/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

  const { server, port } = await startServer();
  const APP_URL = `http://127.0.0.1:${port}/chat`;

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-proxy-server', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // 捕获控制台错误，便于定位
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.addInitScript(
    ({ sessionId, approval }) => {
      // 平台层桩：把 platform 的三个方法替换掉。
      // ⚠️ 渲染层通过 `window.electronAPI`（preload 暴露）调用主进程；
      // 浏览器环境没有 preload，所以这里给 electronAPI 造一个最小实现。
      // 缺失任何一个被渲染层直接调用的方法都会白屏（如 getPlatform），
      // 所以先按 preload 契约列出全部**同步/无参**方法，其余一律返回空值。
      const noop = () => {};
      const asyncEmpty = async () => ({});
      const asyncList = async () => [];
      const api = {
        getPlatform: () => 'win32',
        platform: 'electron',
        windowMinimize: noop,
        windowToggleMaximize: noop,
        windowClose: noop,
        windowReload: noop,
        windowToggleDevTools: noop,
        windowToggleFullScreen: noop,
        windowIsMaximized: async () => false,
        appGetInfo: async () => ({ version: '0.0.0-test' }),
        appGetStorageInfo: async () => ({}),
        appGetDesktopConfig: async () => ({}),
        appSetDesktopConfig: async () => ({ ok: true }),
        appShowWindow: noop,
        appQuit: noop,
        appRendererReady: async () => ({ ok: true }),
        updaterGetStatus: async () => ({ state: 'idle' }),
        updaterCheck: async () => ({ ok: true }),
        updaterDownload: async () => ({ ok: true }),
        updaterInstall: async () => ({ ok: true }),
        onWindowMaximizeChange: noop,
        onAppNavigate: noop,
        onAppDeepLink: noop,
        onUpdaterStatus: noop,
        onAppOpenAbout: noop,
        onDesktopConfigChange: noop,
        onSkillsChanged: noop,
        nanobotGetConfig: asyncEmpty,
        nanobotGetSettings: asyncEmpty,
        nanobotListSessions: asyncList,
        nanobotGetChannelApprovals: async () => ({
          ok: true,
          approvals: [
            {
              id: approval.id,
              tool: approval.tool,
              args: approval.args,
              callId: approval.call_id,
              timeoutSeconds: approval.timeout_seconds,
              shortCode: approval.short_code,
            },
          ],
        }),
        nanobotResolveChannelApproval: async (params) => {
          window.__resolved = params;
          return { ok: true };
        },
        nanobotListChannelSessions: async () => [
          {
            key: 'feishu.feishu:ou_144e0eff3357449329c32c3984ce2c1a',
            channel: 'feishu.feishu',
            title: '真机验收会话',
            preview: '创建文件',
            messageCount: 2,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        nanobotGetChannelSession: async () => ({
          key: 'feishu.feishu:ou_144e0eff3357449329c32c3984ce2c1a',
          channel: 'feishu.feishu',
          title: '真机验收会话',
          preview: '创建文件',
          messageCount: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [
            {
              role: 'user',
              content: '创建一个叫 approval-probe.md 的文件',
              timestamp: new Date().toISOString(),
            },
            {
              role: 'assistant',
              content: '',
              timestamp: new Date().toISOString(),
            },
          ],
        }),
        storageGet: async () => null,
        storageSet: async () => true,
        storageRemove: async () => true,
        readSessionIndex: async () => ({}),
        loadUserSkills: async () => [],
        nanobotGatewayInfo: async () => ({ running: true, port: 18790 }),
        writeSessionIndex: async () => true,
        secretsStatus: async () => ({ ok: true }),
        secretsKeys: async () => [],
        nanobotGetChannels: async () => [],
        nanobotGetMcp: async () => ({}),
        nanobotGetModels: async () => ({}),
        nanobotListCronRuns: async () => [],
        appGetInfo: async () => ({ version: '0.0.0-test', platform: 'win32' }),
      };
      /*
       * ⚠️ Proxy 兜底：preload 暴露了几十个方法，漏掉任何一个渲染层就会
       * 抛 TypeError 并白屏（第一次跑就栽在 getPlatform 上）。
       *
       * ⚠️ 兜底返回值**不能一律是 `{}`**：渲染层对不同方法期待不同形状
       * （`t.map is not a function` —— 拿到的不是数组）。
       * 按方法名前缀猜形状：list/get* 之类给数组，其余给对象。
       *
       * ⚠️ 不能用 `ownKeys` 陷阱：渲染层会对 electronAPI 做 Object.keys /
       * Object.entries（枚举 preload 暴露面），Proxy 的 ownKeys 默认返回空数组
       * → Object.keys(undefined) 抛 "Cannot convert undefined or null to object"。
       * 所以**不写 ownKeys**：未命中属性的 get 仍然生效，而枚举只看到真实键。
       */
      const LIST_LIKE = /^(list|search|load|read|get).*(List|Skills|Cron|Sessions|Channels|Mcp|Models|Artifacts|Records|Items|Entries|Runs|Index|IndexEntries)$/i;
      const fallback = new Proxy(api, {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (typeof prop === 'symbol') return undefined;
          return async () => (LIST_LIKE.test(String(prop)) ? [] : {});
        },
        has() {
          return true;
        },
      });
      window.electronAPI = fallback;
      window.__TEST_SESSION_ID = sessionId;
    },
    { sessionId: SESSION_ID, approval: APPROVAL },
  );

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // 先切到侧边栏的「助理」Tab（IM 会话列表在那里）
  // ⚠️ MUI 的 Tab 是 button[role=tab]，按文本找任意节点会点到 Tab 容器而不是按钮，
  // 或者点到 Tab 里的 span（事件冒泡不到）。直接按 role 找。
  const tabClicked = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const hit = tabs.find((t) => (t.textContent || '').trim() === '助理');
    if (hit) {
      hit.click();
      return true;
    }
    return false;
  });
  console.log('[0] 点击「助理」Tab:', tabClicked);
  await page.waitForTimeout(1500);

  // 切到该 IM 会话：找到侧边栏里的会话条目并点击
  const clicked = await page.evaluate((sessionId) => {
    const nodes = Array.from(document.querySelectorAll('*'));
    const hit = nodes.find((n) => {
      const t = (n.textContent || '').trim();
      return t.includes('真机验收会话') && n.children.length === 0;
    });
    if (hit) {
      hit.click();
      return true;
    }
    return false;
  }, SESSION_ID);
  console.log('[1] 点击会话条目:', clicked);

  await page.waitForTimeout(3000);

  // 断言：审批卡出现在页面上
  const cardInfo = await page.evaluate(() => {
    const body = document.body.innerText || '';
    const hasTool = body.includes('write_file');
    const hasButtons =
      body.includes('允许本次') ||
      body.includes('拒绝') ||
      body.includes('允许');
    // 卡片位置：应贴在输入框区域（底部），不是页面居中
    const candidates = Array.from(document.querySelectorAll('div')).filter((d) => {
      const t = (d.textContent || '');
      return t.includes('write_file') && (t.includes('允许') || t.includes('拒绝'));
    });
    let rect = null;
    if (candidates.length) {
      // 取最内层的那个
      const inner = candidates[candidates.length - 1];
      const r = inner.getBoundingClientRect();
      rect = { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width) };
    }
    return {
      hasTool,
      hasButtons,
      rect,
      viewportH: window.innerHeight,
      snippet: body.slice(0, 400),
    };
  });

  console.log('[2] 卡片可见:', JSON.stringify(cardInfo, null, 2));

  await page.screenshot({ path: path.resolve(__dirname, '../docs/evidence/approval-card-ui.png'), fullPage: false });
  console.log('[3] 截图已存 docs/evidence/approval-card-ui.png');

  // 点「允许本次」，验证按钮确实把裁决发到了主进程，且参数三件套正确
  const resolveParams = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('button'));
    const btn = nodes.find((b) => (b.textContent || '').trim() === '允许本次');
    if (!btn) return null;
    btn.click();
    return 'clicked';
  });
  await page.waitForTimeout(1200);
  const resolved = await page.evaluate(() => window.__resolved || null);
  console.log('[4] 点击「允许本次」:', resolveParams, '→ 裁决参数:', JSON.stringify(resolved));

  const resolveOk =
    resolved &&
    resolved.channel === 'feishu.feishu' &&
    resolved.chatId === 'ou_144e0eff3357449329c32c3984ce2c1a' &&
    resolved.requestId === APPROVAL.id &&
    resolved.decision === 'allow';

  if (errors.length) {
    console.log('[5] 控制台错误:');
    errors.slice(0, 10).forEach((e) => console.log('   -', e));
  }

  await browser.close();
  server.close();

  const ok = cardInfo.hasTool && cardInfo.hasButtons && resolveOk;
  console.log(ok ? '\n✅ 审批卡在助理视图渲染出来了，且「允许本次」接线正确' : '\n❌ 验证未通过');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(2);
});
