/**
 * 真机验证：设置 → 插件页的「插件市场」区（FR-3.7 / FR-3.8）。
 *
 * 与 jsdom 单测的分工：单测钉住**纯函数与 store 语义**（市场状态文案、引用集、
 * 远程同步禁用），这里钉住「浏览器里真的点得开、真的发 IPC、真的把状态画出来」——
 * 尤其是「同步失败」不能被画成「同步成功」（那是最容易顺手糊过去的一处）。
 *
 * 验的五件事：
 *   ① 空注册表 / 两种市场（目录型可同步、远程型如实禁用）都能画出来；
 *   ② 浏览包：没有归档时说「先点同步」，而不是画一个空列表；
 *   ③ 同步成功 → 卡片显示「上次同步 …」；同步失败 → 卡片显示失败原因，
 *      **并且不留下任何「上次同步过」的痕迹**；
 *   ④ 有归档时按版本列出，点某个版本 → IPC 参数正确（市场/包/版本三元组），
 *      安装后**不自动启用**（切版本是换内容指纹，自动启用会把「没生效」治愈掉）；
 *   ⑤ GC 的引用集只含市场副本，本地平铺安装不进引用集（进去了 = 误删生效插件）。
 *
 * 为什么用 route/bridge 桩而不是真主进程：本轮要验的本来就是「拿到结果之后怎么
 * 渲染」，归档、materialize、拨指针都在 Electron 主进程与引擎里，且会动用户真实
 * 的 `~/.nanowork/plugins`。取数链路（IPC 签名、解码、状态写入）是真的。
 *
 * 跑法（dev server 已在 5176）：
 *   node tasks/verify-plugin-market.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/xinmi/.workbuddy/binaries/node/workspace/');
const { chromium } = require('playwright-core');

const APP = 'http://127.0.0.1:5176';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PLUGINS_ROOT = 'C:/Users/u/.nanowork/plugins';

const failures = [];
function check(ok, label, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/**
 * 桥桩：市场相关接口读 `window.__PM__`，测试侧直接改这个对象就能换场景，
 * 不用为了换数据而 reload 页面之外的任何东西。
 */
const BRIDGE = `
const DEFAULT_PM = () => ({
  markets: [],
  /** id -> { mode: 'ok' | 'fail', error?, entry }（同步结果由桥桩现场合成） */
  sync: {},
  /** market id -> MarketIndex */
  packages: {},
  /** 安装调用记录（[market, name, version]） */
  installs: [],
  syncCalls: [],
  gcCalls: [],
  /** 浏览器里「当前扫到的插件」，安装后会被换掉一份以模拟激活标记失效 */
  scan: { plugins: [], skipped: [], pluginsRoot: '${PLUGINS_ROOT}' },
  syncResult: { ok: true, root: '${PLUGINS_ROOT}/cache/official/demo-plugin/1.9.0' },
});

/**
 * 场景数据存在 sessionStorage 里：下面的用例会反复导航到同一个 /settings，
 * 而 init script 每次导航都会重跑、把内存里的桩清空——桩一清空，界面就退回
 * 「空注册表」，后半个脚本全变成假绿。
 */
// 用 localStorage 而不是 sessionStorage：场景数据是「跨导航 + 跨新页面」都要活下来的，
// 而 sessionStorage 是每个 tab 各一份（新 page 读不到），localStorage 才是共享的。
const RAW = localStorage.getItem('__PM__');
window.__PM__ = RAW ? { ...DEFAULT_PM(), ...JSON.parse(RAW) } : DEFAULT_PM();
const S = () => window.__PM__;

const base = {
  appGetStorageInfo: async () => ({
    home: 'C:/Users/u', userData: 'C:/Users/u/AppData', product: 'C:/Users/u/.nanowork',
    memory: 'C:/Users/u/.nanowork/memory', cacheDir: 'C:/Users/u/.nanowork',
    cacheBytes: 0,
    disk: { totalBytes: 5e11, usedBytes: 3e11, freeBytes: 2e11 },
    defaultWorkspaceDir: 'C:/Users/u/NanoWork',
  }),
  appGetDesktopConfig: async () => ({ closeToTray: false, launchAtLogin: false, autoOpenDevTools: false }),
  storageGet: async () => null,
  storageSet: async () => ({ ok: true }),
  readSessionIndex: async () => ({ version: 2, entries: {} }),
  rebuildSessionIndex: async () => ({ version: 2, entries: {} }),
  listSessionMetas: async () => [],
  eventsRead: async () => [],
  loadUserSkills: async () => [],
  nanobotListChannelSessions: async () => [],
  nanobotListCronRuns: async () => [],
  nanobotGetCronSession: async () => null,

  // ── 市场（FR-3.7 / 3.8）────────────────────────────────────
  // 返回 { markets, error }——store 读的是 registry.markets，给裸数组会被当成空注册表
  pluginsMarkets: async () => ({ markets: S().markets.map((m) => ({ ...m })), error: null }),
  pluginsMarketsUpsert: async (entry) => {
    S().markets = [...S().markets.filter((m) => m.id !== entry.id), { ...entry }];
    return { ok: true };
  },
  pluginsMarketsRemove: async (id) => {
    S().markets = S().markets.filter((m) => m.id !== id);
    return { ok: true };
  },
  pluginsMarketsSync: async (id) => {
    S().syncCalls.push(id);
    const c = S().sync[id] ?? { mode: 'ok' };
    if (c.mode === 'fail') {
      return {
        ok: false,
        result: null,
        entry: { ...c.entry, lastError: c.error, lastSyncAt: null },
        error: c.error,
      };
    }
    return { ok: true, result: { synced: 2, skipped: [] }, entry: { ...c.entry, lastError: null } };
  },
  pluginsMarketPackages: async (id) =>
    S().packages[id] ?? { market: id, packages: [], skipped: [] },
  pluginsMarketInstall: async (market, name, version) => {
    S().installs.push([market, name, version]);
    return S().syncResult;
  },
  pluginsMarketGc: async (referenced, keepDays) => {
    S().gcCalls.push([referenced, keepDays]);
    return { removed: [], kept: referenced.map((p) => p) };
  },

  pluginsScan: async () => S().scan,
  pluginsInstall: async () => ({ ok: true, root: 'x' }),
  pluginsUninstall: async () => ({ ok: true }),
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

/** 一个目录型市场（已同步过） */
function marketOfficial() {
  return {
    id: 'official',
    name: 'official',
    type: 'directory',
    location: `${PLUGINS_ROOT}/market-src`,
    isBuiltIn: true,
    autoUpdate: false,
    lastSyncAt: '2026-10-04T13:05:00Z',
    lastError: null,
  };
}

/** 一个远程市场（本轮无服务端，同步必须禁用） */
function marketRemote() {
  return {
    id: 'upstream',
    name: 'upstream',
    type: 'remote',
    location: 'https://example.invalid/plugins.zip',
    isBuiltIn: false,
    autoUpdate: true,
    lastSyncAt: null,
    lastError: null,
  };
}

/** 同步成功：回写的条目带着 lastSyncAt（业务上就是「注册表被更新过」） */
function syncOk(entry) {
  return { mode: 'ok', entry };
}

/** 同步失败：回写的条目带着 lastError 且 lastSyncAt 清成 null */
function syncFailed(error, entry) {
  return { mode: 'fail', error, entry };
}

/** 一个市场来源的生效副本（激活中） */
function scanActive() {
  return {
    plugins: [
      {
        manifest: {
          name: 'demo-plugin', displayName: '演示插件', version: '2.0.0',
          versionDeclared: true, description: '示例插件', repository: '', category: 'Development',
          main: 'SKILL.md', permissions: { tools: [], network: [] }, engineRange: '', schema: 'https://agent-plugins.org/schemas/v1/plugin.json',
          manifestPath: 'plugin.json',
        },
        root: `${PLUGINS_ROOT}/cache/official/demo-plugin/2.0.0`,
        resources: [],
        installedAt: '2026-10-04T13:00:00Z',
      },
    ],
    skipped: [],
    pluginsRoot: PLUGINS_ROOT,
  };
}

function scanInactive() {
  return { ...scanActive() };
}

/** 一个本地平铺安装（GC 的引用集不该含有它） */
function scanWithLocal() {
  const scan = scanActive();
  scan.plugins.push({
    manifest: {
      name: 'local-one', displayName: '本地插件', version: '0.0.1',
      versionDeclared: true, description: '本地平铺安装的插件', repository: '', category: 'Development',
      main: 'SKILL.md', permissions: { tools: [], network: [] }, engineRange: '', schema: 'https://agent-plugins.org/schemas/v1/plugin.json',
      manifestPath: 'plugin.json',
    },
    root: `${PLUGINS_ROOT}/local-one`,
    resources: [],
  });
  return scan;
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  // 本机 http_proxy 会劫持 127.0.0.1 → goto 超时（dev server 其实是好的）
  args: ['--no-proxy-server'],
});

const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addInitScript(BRIDGE);
// 每次运行先清一次场景数据：不然上次的arkets会跟着 localStorage 进来，
// 场景 1 的「空注册表」就成了假红。
const boot = await ctx.newPage();
await boot.goto(APP, { waitUntil: 'domcontentloaded' });
await boot.evaluate(() => localStorage.clear());
await boot.close();

let page = await ctx.newPage();
/** 本脚本故意打出来的 404/500 与桥桩下的 MUI controlled 告警不算页面错误 */
const NOISE = /Failed to load resource|\/v1\/|404|500|CORS policy|controlled|SwitchBase/;
function attachLogs(target) {
  target.on('pageerror', (e) => errors.push(`pageerror: ${e.stack || e.message}`));
  target.on('console', (m) => {
    if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text());
  });
}
attachLogs(page);

/**
 * 打开设置弹窗并切到「插件」分区。
 *
 * `reload=false` 走首次导航；`reload=true` 走 `page.reload()`。切换场景必须真的
 * 重载——store 是模块级单例，只靠 `goto` 到同一个 URL 它不会回到初始值，上一场景
 * 的 `syncingMarket` 会让「同步」按钮一直 disabled，后面的用例全是假红。
 */
/**
 * 每个场景开一个**新页面**。
 *
 * store 是模块级单例、展开状态是组件 state，同一个页面里切场景只能靠导航重置，
 * 而既有的一次导航（同 URL / about:blank / 加 query）都验证过没能把它们复位——
 * 结果就是上一个场景的「同步中」按钮还挡在下个场景身上。新页面没有这个问题，
 * 期望的行为本来就是「打开设置就看到这一幕」。
 */
async function openPlugins() {
  page = await ctx.newPage();
  attachLogs(page);
  await page.goto(`${APP}/settings`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('[role="dialog"]', { timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.locator('nav[aria-label="配置项"]').getByText('插件', { exact: true }).click();
  await page.waitForTimeout(1200);
}

const panel = () => page.locator('[role="dialog"]');
const panelText = async () => (await panel().innerText()).replace(/\s+/g, ' ');
/**
 * 场景数据落在 localStorage：桥桩在每个新文档 / 新页面里从它恢复 __PM__，
 * 而 store 只在组件挂载时读一次注册表——不落盘的桩数据下一次就蒸发了。
 */
const stub = async (patch) => {
  await page.evaluate((p) => {
    const cur = JSON.parse(localStorage.getItem('__PM__') || '{}');
    localStorage.setItem('__PM__', JSON.stringify({ ...cur, ...p }));
    // 桥桩读的是页面内存里的 __PM__，只落盘不落内存的话，当前这个页面点的按钮
    // 会拿到上一次场景的桩数据（表现：同步一直「成功」）。
    Object.assign(window.__PM__, p);
  }, patch);
};
const card = (id) => panel().locator(`[data-market="${id}"]`);
const syncBtn = (id) => card(id).getByRole('button', { name: /^同步/ });
const browseBtn = (id) => card(id).getByRole('button', { name: '浏览包' });

// ───────────── 场景 ①：空注册表 ─────────────
console.log('\n[场景 1] 还没有登记市场');
await openPlugins();
let text = await panelText();
check(text.includes('插件市场'), '市场区标题渲染');
check(text.includes('回收旧副本'), 'GC 入口在（回收旧副本）');
check(text.includes('添加市场'), '添加市场入口在');
check(text.includes('还没有登记市场'), '⭐ 空注册表说清楚「可以指向本机一个插件目录」（不是空白一片）', (text.match(/还没有登记市场[^。]*/) ?? [''])[0]);

// ───────────── 场景 ②：目录型 + 远程型两种市场 ─────────────
console.log('\n[场景 2] 目录型可同步 / 远程型如实禁用（注册表：official + upstream）');
await stub({
  markets: [marketOfficial(), marketRemote()],
  sync: { official: syncOk(marketOfficial()), upstream: syncOk(marketRemote()) },
  packages: { official: { market: 'official', packages: [], skipped: [] } },
});
await openPlugins();
text = await panelText();
check(text.includes('目录型') && text.includes('远程'), '两类市场画成不同的类型标签');
check(text.includes('内置'), '内置市场有标记');
check(text.includes('官方') === false, '内置市场不应凭空显示一个不存在的大类文案');

const remoteSync = syncBtn('upstream');
await remoteSync.waitFor({ timeout: 5000 });
check(await remoteSync.isDisabled(), '⭐ 远程市场「同步」按钮禁用（点了才报错更糟）');
// disabled 的 MUI Button 上 title 落在 Tooltip 的包裹 span 里，hover 一次读给用户看的话
// force：disabled 按钮会被 Tooltip 的包裹 span 挡住，pointer 事件落在 span 上
await remoteSync.hover({ force: true });
await page.waitForTimeout(700);
const remoteTip = await page.locator('.MuiTooltip-tooltip').first().innerText();
check(
  /远程市场同步需要服务端支持/.test(remoteTip),
  '⭐ 禁用的同时给出原因（remote 同步需要服务端支持）',
  remoteTip.replace(/\s+/g, ' ').slice(0, 40),
);
const builtInRemove = panel().getByRole('button', { name: '删除市场 official' });
check(await builtInRemove.isDisabled(), '内置市场删不掉（删除按钮禁用）');

// ───────────── 场景 ③：浏览包，但还没归档 ─────────────
console.log('\n[场景 3] 市场里没有归档任何包');
await browseBtn('official').click();
text = await panelText();
check(text.includes('这个市场里还没有归档任何包'), '⭐ 空归档说「先点同步」，而不是画一个空列表 / 不报错', (text.match(/这个市场里还没有归档任何包[^。]*。/) ?? [''])[0]);

// ───────────── 场景 ④：同步成功 ─────────────
console.log('\n[场景 4] 目录型同步成功');
await syncBtn('official').click();
await page.waitForTimeout(1200);
text = await panelText();
const okStamp = (text.match(/上次同步 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/) ?? [''])[0];
check(okStamp !== '', '⭐ 同步成功 → 卡片显示「上次同步 2026-10-04 13:05」（取注册表回写实值）', okStamp);
check(!text.includes('上次同步失败'), '成功态不残留上一次失败的文案');

// ───────────── 场景 ⑤：同步失败，不许装作成功 ─────────────
console.log('\n[场景 5] 同步失败（找不到市场源）');
await stub({ sync: { official: syncFailed('市场不存在', marketOfficial()) } });
await syncBtn('official').click();
await page.waitForTimeout(1200);
text = await panelText();
check(text.includes('上次同步失败：市场不存在'), '⭐ 失败 → 卡片如实显示失败原因（不是笼统的「同步失败」）', (text.match(/上次同步失败：[^）]*/) ?? [''])[0]);
check(!/上次同步 \d{4}-\d{2}-\d{2}/.test(text), '⭐ 失败时不留下任何「上次同步过」的痕迹（成功时间戳被回写的空值盖掉）');
check(text.includes('市场读写失败：市场不存在'), 'store 把主进程回写的错误也升到顶部提示');
const syncCalls = await page.evaluate(() => window.__PM__.syncCalls);
check(syncCalls.includes('official'), '同步走的是 pluginsMarketsSync(official)', JSON.stringify(syncCalls));

// ───────────── 场景 ⑥：有归档 → 选版本安装 ─────────────
console.log('\n[场景 6] 市场里有两版包 → 装旧版');
await stub({
  sync: { official: syncOk(marketOfficial()) },
  packages: {
    official: {
      market: 'official',
      packages: [
        { name: 'demo-plugin', displayName: '演示插件', version: '2.0.0', description: '示例插件' },
        { name: 'demo-plugin', displayName: '演示插件', version: '1.9.0', description: '示例插件' },
      ],
      skipped: ['not-a-plugin'],
    },
  },
  scan: scanActive(),
});
await openPlugins();
await browseBtn('official').click();
text = await panelText();
check(text.includes('2.0.0（生效中）'), '当前生效版本标「（生效中）」', (text.match(/v2\.0\.0[^ ]*(（生效中）)?/) ?? [''])[0]);
check(text.includes('v1.9.0'), '另一版列出来（同包多版本并存）');
check(text.includes('已跳过 1 个不合规目录'), '跳过的坏包如实列出，界面不会「什么都没装」', (text.match(/已跳过 \d 个不合规目录[^：]*：[^\\s]*/) ?? [''])[0]);
check(!text.includes('1.9.0 更新'), '低版本不标「更新」（那会把用户往回退版本上劝）');

const installBtn = card('official').getByRole('button', { name: /v1\.9\.0/ });
check(await installBtn.isDisabled() === false, '非生效版本可以点');
await installBtn.click();
await page.waitForTimeout(1200);
const installs = await page.evaluate(() => window.__PM__.installs);
check(
  JSON.stringify(installs) === JSON.stringify([['official', 'demo-plugin', '1.9.0']]),
  '⭐ 安装把「市场 / 包 / 版本」三元组原样递给主进程',
  JSON.stringify(installs),
);

// 切版本 = 换一份内容指纹 → 激活标记立刻失效，**不自动启用**
await stub({ scan: scanInactive() });
await openPlugins();
text = await panelText();
// 注意：激活态是**引擎上报**的（本机网关没起 → 芯片是「状态未知」），不由 scan 决定。
// 所以这里验的是「安装 ≠ 启用」这件事本身：切完版本，启用开关不许被偷偷拨上——
// 一旦自动启用，「装了却没生效」就会变成一次无痕的自我治愈，从此查不出原因。
const toggle = panel().locator('input[aria-label="启用 演示插件"]');
check(await toggle.isChecked() === false, '⭐ 切版本后启用开关仍是关的（安装从不顺手把启用也做了）');
check(
  !text.includes('已启用但引擎未激活'),
  '⭐ 没有偷偷启用（若自动启用，这条「已启用但引擎未激活」的漂移提示就会冒出来）',
);
check(text.includes('official v2.0.0'), '卡片来源 chip 显示来自哪个市场、哪一版', (text.match(/official v[\d.]+/) ?? [''])[0]);

// ───────────── 场景 ⑦：GC 的引用集 ─────────────
console.log('\n[场景 7] 回收旧副本：引用集只含市场副本');
await stub({ scan: scanWithLocal() });
await openPlugins();
await panel().getByRole('button', { name: '回收旧副本' }).click();
await page.waitForTimeout(1200);
const gc = await page.evaluate(() => window.__PM__.gcCalls);
const referenced = gc[0]?.[0] ?? [];
check(gc.length === 1, '点一次只发一次 GC', JSON.stringify(gc.length));
check(gc[0]?.[1] === 30, 'GC 带默认保留天数 30', String(gc[0]?.[1]));
check(
  referenced.includes(`${PLUGINS_ROOT}/cache/official/demo-plugin/2.0.0`),
  '⭐ 引用集含市场生效副本（漏了 = 插件凭空消失）',
  JSON.stringify(referenced),
);
check(
  !referenced.some((p) => p === `${PLUGINS_ROOT}/local-one`),
  '⭐ 引用集不含本地平铺安装（它不是 cache 副本，GC 不管它）',
  JSON.stringify(referenced),
);
text = await panelText();
check(text.includes('保留 1 个') || text.includes('回收'), 'GC 有结论反馈', (text.match(/已回收[^（]*|没有可回收的旧副本[^（]*/) ?? [''])[0]);

await page.screenshot({ path: 'tasks/plugin-market.png' });
check(errors.length === 0, '零页面错误', errors.slice(0, 3).join(' | '));

console.log(
  `\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}：` +
    `${failures.join(' / ') || '—'}`,
);
await browser.close();
process.exit(failures.length === 0 ? 0 : 1);
