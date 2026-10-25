/**
 * 真机验证：IM 会话归档（FR-6.4）—— 渠道分组、筛选、外部来源标记。
 *
 * 与单测的分工：
 * - 来源判定与文案在 `tests/lib/channel/channelSession.test.ts`；
 * - 筛选态在 store 而非组件 state，由 `tests/sessionUiStoreChannelFilter.test.ts` 钉；
 * - 侧栏分组与筛选的**渲染与交互**在 `tests/channelListFilter.test.tsx`；
 * - 会话头部标记由 `tests/chatHeaderExternal.test.tsx` 钉。
 *
 * 那这里还验什么？只有真机能证明的三件事：
 *   ① 打开一条 IM 会话真的会进聊天页、头部真的画出来源标记（组件级测试只渲染头部，
 *      不经过路由与「点列表 → 拉详情 → 注入 sessionsStore」这条真实链路）；
 *   ② 未知渠道（Telegram）在**真实数据流**里不会被并进钉钉组——单测用的是手写
 *      summary，这里用「引擎可能真的回什么形状」的完整字段；
 *   ③ 本机会话的对照组：同一套 UI 上，本机会话没有标记、可以重命名。
 *
 * ⚠️ 桥桩扮演主进程：`nanobotListChannelSessions` 回摘要列表，
 * `nanobotGetChannelSession` 回详情（含 messages）。引擎侧怎么读 JSONL 不是本批范围。
 *
 * 跑法（dev server 已在 5176）：
 *   node tasks/verify-channel-archive.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/xinmi/.workbuddy/binaries/node/workspace/');
const { chromium } = require('playwright-core');

const APP = 'http://127.0.0.1:5176';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const failures = [];
function check(ok, label, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

// ⚠️ 下面 BRIDGE 是**注入浏览器的字符串**，里面绝对不能出现 `//` 注释——它不会报错，
// 只会把后面整段注入代码吞掉（本仓库已经栽过两次：一次白屏、一次「少了 disk 字段」，
// 两次都是同一个错因）。需要说明写在外面，或用成对的块注释。
const BRIDGE = `
const DEFAULTS = { summaries: [], mode: 'normal' };
const ST = () => {
  const raw = localStorage.getItem('__CH__');
  return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
};

const iso = (min) => new Date(Date.UTC(2026, 9, 5, 9, min, 0)).toISOString();

const MESSAGES = {
  'weixin:wxid_a': [
    { role: 'user', content: '跑一下昨天的销售日报', timestamp: iso(0) },
    { role: 'assistant', content: '已生成，详见附件。', timestamp: iso(1) },
  ],
  'weixin:wxid_b': [
    { role: 'user', content: '把上周的客户名单整理一下', timestamp: iso(2) },
  ],
  'telegram:tg_9': [
    { role: 'user', content: 'summarize the release notes', timestamp: iso(3) },
  ],
};

const ALL = [
  { key: 'weixin:wxid_a', channel: 'weixin', title: 'wx-a 的会话', preview: '跑一下昨天的销售日报',
    messageCount: 2, createdAt: iso(0), updatedAt: iso(30) },
  { key: 'telegram:tg_9', channel: 'telegram', title: 'tg-9 的会话', preview: 'summarize the release notes',
    messageCount: 1, createdAt: iso(3), updatedAt: iso(25) },
  { key: 'weixin:wxid_b', channel: 'weixin', title: 'wx-b 的会话', preview: '把上周的客户名单整理一下',
    messageCount: 1, createdAt: iso(2), updatedAt: iso(20) },
];

const base = {
  appGetStorageInfo: async () => ({
    home: 'C:/Users/u', userData: 'C:/Users/u/AppData', product: 'C:/Users/u/.nanowork',
    memory: 'C:/Users/u/.nanowork/memory', cacheDir: 'C:/Users/u/.nanowork',
    cacheBytes: 0,
    disk: { totalBytes: 5e11, usedBytes: 3e11, freeBytes: 2e11 },
    defaultWorkspaceDir: 'C:/Users/u/NanoWork',
  }),
  appGetInfo: async () => ({ appName: 'NanoWork', version: '0.0.0', electron: '31.0.0', node: '20.0.0',
    chrome: '126.0.0', platform: 'win32', osVersion: 'Windows', arch: 'x64', deviceId: 'dev-1' }),
  storageGet: async () => null,
  storageSet: async () => ({ ok: true }),
  readSessionIndex: async () => ({ version: 2, entries: {} }),
  rebuildSessionIndex: async () => ({ version: 2, entries: {} }),
  listSessionMetas: async () => [],
  eventsRead: async () => [],
  loadUserSkills: async () => [],
  loadUserSkills: async () => [],
  nanobotListChannelSessions: async () => {
    const s = ST();
    if (s.mode === 'only-weixin') return ALL.filter((x) => x.channel === 'weixin');
    return ALL;
  },
  nanobotGetChannelSession: async (key) => {
    const found = ALL.find((x) => x.key === key);
    if (!found) return null;
    return { ...found, messages: MESSAGES[key] || [] };
  },
  nanobotListCronRuns: async () => [],
  pluginsScan: async () => ({ plugins: [], skipped: [], pluginsRoot: 'C:/Users/u/.nanowork/plugins' }),
  diagnosticsStats: async () => null,
};

window.electronAPI = new Proxy(base, {
  get(target, prop) {
    if (typeof prop === 'symbol' || prop === 'then') return undefined;
    if (prop in target) return target[prop];
    if (typeof prop === 'string' && prop.startsWith('on')) return () => () => {};
    return async () => null;
  },
});
`;

const { context: ctx, bootPage } = await (async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    // ⚠️ 本机 http_proxy 会劫持 127.0.0.1，不加这个参数 goto 直接超时
    args: ['--no-proxy-server'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(BRIDGE);
  const page0 = await context.newPage();
  await page0.goto(APP, { waitUntil: 'domcontentloaded' });
  return { context, bootPage: page0 };
})();

async function seed(patch) {
  await bootPage.evaluate((value) => {
    const cur = JSON.parse(localStorage.getItem('__CH__') || '{}');
    localStorage.setItem('__CH__', JSON.stringify({ ...cur, ...value }));
  }, patch);
}

let page = null;
const errors = [];
const NOISE = /Failed to load resource|\/v1\/|404|500|CORS policy|controlled|SwitchBase/;
function attachLogs(target) {
  target.on('pageerror', (e) => errors.push(`pageerror: ${e.stack || e.message}`));
  target.on('console', (m) => {
    if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text());
  });
}

/** 每个场景开新页面：store 是模块级单例，同页切场景复位不了（见开发笔记 §7.12） */
async function openApp() {
  page = await ctx.newPage();
  attachLogs(page);
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForTimeout(2500);
}

/** 切到侧栏「助理」Tab */
async function openChannelsTab() {
  await page.locator('[role="tab"]').filter({ hasText: '助理' }).first().click();
  await page.waitForTimeout(3000);
}

const channelChips = () =>
  page.locator('[data-testid="channel-filter-chip"]');
const chipLabels = async () => (await channelChips().allInnerTexts()).map((t) => t.trim());
const chipByText = (text) =>
  channelChips().filter({ hasText: new RegExp(`^${text}$`) }).first();
const isChipSelected = async (text) =>
  (await chipByText(text).getAttribute('data-selected')) === 'true';

// ══ 场景 1：多渠道 → 筛选条出现，且未知渠道自成一组 ═══════════════════
console.log('\n场景 1：渠道分组与筛选条');
await seed({ mode: 'normal' });
await openApp();
await openChannelsTab();

let labels = await chipLabels();
check(labels[0] === '全部', '第一个 chip 是「全部」', labels.join(' / '));
check(
  labels.includes('微信') && labels.includes('Telegram'),
  '每个渠道各一个 chip（含引擎支持但客户端没有图形的 Telegram）',
);
check(
  !labels.includes('钉钉'),
  '⭐ 未知渠道没有被并进「钉钉」组（这正是本批修掉的缺陷）',
);
check(await isChipSelected('全部'), '默认选中「全部」');

const body1 = await page.locator('body').innerText();
check(body1.includes('wx-a 的会话'), '微信会话在列表里');
check(body1.includes('tg-9 的会话'), 'Telegram 会话也在列表里');

// ══ 场景 2：筛选真的改变可见内容 ═══════════════════════════════════
console.log('\n场景 2：按渠道筛选');
await chipByText('Telegram').click();
await page.waitForTimeout(600);

let body2 = await page.locator('body').innerText();
check(body2.includes('tg-9 的会话'), '筛 Telegram 后它还在');
check(!body2.includes('wx-a 的会话'), '微信会话被筛掉');
check(!body2.includes('wx-b 的会话'), '另一条微信会话也被筛掉');
check(await isChipSelected('Telegram'), 'Telegram chip 变成选中态');
check(!(await isChipSelected('全部')), '「全部」不再是选中态');

await chipByText('全部').click();
await page.waitForTimeout(600);
const body3 = await page.locator('body').innerText();
check(
  body3.includes('wx-a 的会话') && body3.includes('tg-9 的会话'),
  '点「全部」两条渠道都回来',
);

// ══ 场景 3：只有一个渠道时不出现筛选条（没有可筛的东西）═════════════
console.log('\n场景 3：单渠道时不出现筛选条');
await seed({ mode: 'only-weixin' });
await openApp();
await openChannelsTab();
check(
  (await channelChips().count()) === 0,
  '只有一个渠道 → 筛选条不渲染',
  `count=${await channelChips().count()}`,
);

// ══ 场景 4：打开 IM 会话 → 头部出现来源标记、标题只读 ══════════════
console.log('\n场景 4：IM 会话的外部来源标记');
await seed({ mode: 'normal' });
await openApp();
await openChannelsTab();
await page.getByText('wx-a 的会话', { exact: true }).first().click();
await page.waitForTimeout(2500);

// ⚠️ locator 绑定的是**声明时的那个 page**。每个场景都 `ctx.newPage()`，
// 所以必须按当前页面现取，写成模块级常量会让后面的场景一直读旧页面的 DOM
// （实测症状：页面正文已经显示「来自 Telegram」，断言却拿到「来自 微信」）。
const badgeIn = (p) => p.locator('[data-testid="external-source-badge"]');
const badge = badgeIn(page);
check((await badge.count()) === 1, '头部画出来源标记');
const badge4Text = (await badge.first().innerText()).replace(/\s+/g, '');
check(
  badge4Text.includes('来自') && badge4Text.includes('微信'),
  `标记文案对得上（${badge4Text}）`,
);
check(
  (await page.locator('[aria-label="重命名"]').count()) === 0,
  '⭐ 标题没有重命名入口（标题来自网关，改了会被下一轮轮询盖回去）',
);
check(
  (await page.locator('[aria-label="历史提问"]').count()) > 0,
  '只读的快捷入口仍在（历史提问 / 搜索 / 产物）',
);
check(
  (await page.locator('[placeholder*="IM"]').count()) > 0,
  '底部是「向该 IM 用户发送消息」的出站通道（placeholder 对得上）',
);

await page.screenshot({ path: 'tasks/channel-archive.png' });

// ══ 场景 5：本机会话对照组 ═════════════════════════════════════════
console.log('\n场景 5：来源标记跟着会话走（不是写死的常量）');
await seed({ mode: 'normal' });
await openApp();
await openChannelsTab();

// ⚠️ 本场景是**新页面**，locator 必须现取（见上面 badgeIn 的说明）
const badgeB = badgeIn(page);
const badgeText = async () =>
  (await badgeB.first().innerText()).replace(/\s+/g, '');

/**
 * 侧栏的频道会话行（`data-testid` + `data-channel` 由 SidebarNav 透传）。
 *
 * ⚠️ 必须点**行内的标题文字**，不能点整行的几何中心：行右侧有一组
 * 「悬停才出现」的快捷入口（搜索 / 历史提问 / 产物），它们各自 `stopPropagation`。
 * Playwright 的 `click()` 默认点元素中心，hover 之后中心可能落在快捷入口上——
 * 于是「点了会话行」实际点到了「对话内搜索」，会话根本没换。
 */
const rowTitle = (key, text) =>
  page
    .locator(`[data-testid="channel-session-row"][data-channel="${key}"]`)
    .first()
    .getByText(text, { exact: true });

await rowTitle('weixin', 'wx-a 的会话').click();
await page.waitForTimeout(2500);
check((await badgeB.count()) === 1, '第一条会话：标记在');
check((await badgeText()).includes('微信'), '第一条的标记是「微信」');

// 回侧栏点另一条渠道的会话（侧栏常驻，Tab 状态不丢）
await rowTitle('telegram', 'tg-9 的会话').click();
await page.waitForTimeout(2500);
check((await badgeB.count()) === 1, '换会话后标记仍在');
check(
  (await badgeText()).includes('Telegram'),
  '⭐ 标记跟着会话走（不是写死的常量）',
  await badgeText(),
);

// 注：「本机会话没有标记、可以重命名」的对照由 `tests/chatHeaderExternal.test.tsx` 覆盖。
// 真机上造一条**有消息**的本机会话需要真引擎（新会话没有消息 → ChatPage 走空态、
// 头部不渲染，两条断言都会变成「0 === 0」的假通过），所以不在这里做。

// ══ 汇总 ═══════════════════════════════════════════════════════════
const realErrors = errors.filter((e) => !NOISE.test(e));
console.log(
  `\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}，页面错误 ${realErrors.length} 条`,
);
if (failures.length) console.log('失败项：\n - ' + failures.join('\n - '));
if (realErrors.length) console.log('页面错误：\n - ' + realErrors.slice(0, 8).join('\n - '));

await ctx.browser().close();
process.exit(failures.length === 0 && realErrors.length === 0 ? 0 : 1);
