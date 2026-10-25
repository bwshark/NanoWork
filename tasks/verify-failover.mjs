/**
 * 真机验证：故障转移（FR-9.4）。
 *
 * 与单测的分工：
 * - 纯逻辑（链的编辑规则、引擎两态形状的转换、删除/改名时的引用维护）在
 *   `tests/lib/model/modelFallbacks.test.ts` 与 `tests/electron/modelFallbacksConfig.test.ts`；
 * - store 语义（顺序不被归一、桥拒绝时不装作成功）在 `tests/modelsStoreFailover.test.ts`；
 * - 这里只钉**只有真机能证明**的几件事：
 *
 *   ① 版式与可见性：回退链真的按顺序画出来，「未保存」标记真的出现；
 *   ② MUI Select 在真浏览器里真的打得开、选得中（jsdom 里只能靠派发事件模拟）；
 *   ③ 桥收到的载荷顺序 = 屏幕上的顺序（点「下移」之后落盘的是改过的次序）；
 *   ④ 阻断态：链里引用了不存在的预设时保存被禁用并给出原因，移掉后立刻恢复；
 *   ⑤ 删除模型时确认框里说明「会一并摘掉回退链里的引用」。
 *
 * ⚠️ 桥桩扮演的是**主进程**：`nanobotGetModels` 必须直接返回**已经转好的两态形状**
 * （`{kind:'preset'|…}`）。引擎侧的 `str | InlineFallbackConfig` 与两态之间的转换
 * 属于主进程职责，由 `tests/electron/modelFallbacksConfig.test.ts` 覆盖——在这里
 * 再仿真一遍只会模拟出两套实现。
 *
 * 跑法（dev server 已在 5176）：
 *   node tasks/verify-failover.mjs
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

const BRIDGE = `
const DEFAULTS = { fallbacks: [], providerRetryMode: 'standard', defaultPreset: 'primary', syncCalls: [] };
const FO = () => {
  const raw = localStorage.getItem('__FO__');
  return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
};
const save = (next) => localStorage.setItem('__FO__', JSON.stringify(next));

const preset = (name, model, over = {}) => ({
  model,
  provider: 'customgateway',
  maxTokens: 32768,
  contextWindowTokens: 200000,
  temperature: 0.1,
  reasoningEffort: null,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: true,
  customProtocol: false,
  pricing: null,
  ...over,
});

const snapshot = () => ({
  presets: {
    primary: preset('primary', 'primary-model'),
    'backup-a': preset('backup-a', 'backup-a-model'),
    'backup-b': preset('backup-b', 'backup-b-model'),
  },
  providers: {
    customgateway: { apiKey: 'sk-x', apiBase: 'https://gw.example.com/v1', displayName: 'customgateway' },
  },
  defaultPreset: FO().defaultPreset,
  // ⚠️ 两态形状（主进程转好的结果），不是引擎的 str | InlineFallbackConfig
  fallbacks: FO().fallbacks,
  providerRetryMode: FO().providerRetryMode,
});

const base = {
  appGetStorageInfo: async () => ({
    home: 'C:/Users/u', userData: 'C:/Users/u/AppData', product: 'C:/Users/u/.nanowork',
    memory: 'C:/Users/u/.nanowork/memory', cacheDir: 'C:/Users/u/.nanowork',
    cacheBytes: 0,
    disk: { totalBytes: 5e11, usedBytes: 3e11, freeBytes: 2e11 },
    defaultWorkspaceDir: 'C:/Users/u/NanoWork',
  }),
  appGetDesktopConfig: async () => ({ closeToTray: false, launchAtLogin: false, autoOpenDevTools: false }),
  appGetInfo: async () => ({ appName: 'NanoWork', version: '0.0.0', electron: '31.0.0', node: '20.0.0',
    chrome: '126.0.0', platform: 'win32', osVersion: 'Windows', arch: 'x64', deviceId: 'dev-1' }),
  storageGet: async () => null,
  storageSet: async () => ({ ok: true }),
  readSessionIndex: async () => ({ version: 2, entries: {} }),
  rebuildSessionIndex: async () => ({ version: 2, entries: {} }),
  listSessionMetas: async () => [],
  eventsRead: async () => [],
  loadUserSkills: async () => [],
  nanobotGetModels: async () => snapshot(),
  /**
   * 扮演主进程的写入端：记录调用**并真的落盘**——不落盘的话「保存后回读」那一步
   * 会把界面换回旧链，看着像「保存没生效」，而实际上只是桩没接上。
   */
  nanobotSyncModels: async (json) => {
    const mutation = JSON.parse(json);
    const state = FO();
    state.syncCalls = [...state.syncCalls, mutation];
    if (mutation.op === 'setFailover') {
      state.fallbacks = mutation.fallbacks;
      state.providerRetryMode = mutation.providerRetryMode;
    }
    save(state);
    return { ok: true, changed: true, message: '模型配置已写入 config.json' };
  },
  pluginsScan: async () => ({ plugins: [], skipped: [], pluginsRoot: 'C:/Users/u/.nanowork/plugins' }),
  nanobotListChannelSessions: async () => [],
  nanobotListCronRuns: async () => [],
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
    args: ['--no-proxy-server'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(BRIDGE);
  const page0 = await context.newPage();
  await page0.goto(APP, { waitUntil: 'domcontentloaded' });
  await page0.evaluate(() => localStorage.removeItem('__FO__'));
  return { context, bootPage: page0 };
})();

/** 写场景数据：localStorage 是**跨页面共享**的，桩在每个新文档里从它恢复 */
async function seed(patch) {
  await bootPage.evaluate((value) => {
    const cur = JSON.parse(localStorage.getItem('__FO__') || '{}');
    localStorage.setItem('__FO__', JSON.stringify({ ...cur, ...value }));
  }, patch);
}

const readState = () => bootPage.evaluate(() => JSON.parse(localStorage.getItem('__FO__') || '{}'));

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
async function openModels() {
  page = await ctx.newPage();
  attachLogs(page);
  await page.goto(`${APP}/settings`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('[role="dialog"]', { timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.locator('nav[aria-label="配置项"]').getByText('模型', { exact: true }).click();
  await page.waitForTimeout(1200);
}

/**
 * 设置弹窗。
 *
 * 取 `.first()`：删除确认框是后挂上来的**第二个** `[role="dialog"]`，
 * 不收敛的话 `innerText` 会直接报 strict mode violation，断言也可能读到确认框的文案。
 */
const dialog = () => page.locator('[role="dialog"]').first();
const dialogText = async () => (await dialog().innerText()).replace(/\s+/g, ' ');
const byAria = (label) => page.locator(`[aria-label="${label}"]`);
const rows = () => page.locator('[data-fallback-index]');
/** 行序 = 屏幕上看到的链（这是「顺序即语义」唯一可信的读法） */
const chainOrder = async () =>
  (await rows().allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());

/**
 * 删除确认框。
 *
 * ⚠️ 它是**第二个** `[role="dialog"]`（设置弹窗还在底下），`dialog()` 会同时命中两个，
 * 于是 `innerText` 报 strict mode violation。取 `.last()` 才是刚弹出来的那个。
 */
const confirmBox = () => page.locator('[role="dialog"]').last();
const confirmText = async () => (await confirmBox().innerText()).replace(/\s+/g, ' ');

const saveBtn = () => dialog().getByRole('button', { name: '保存', exact: true });
const discardBtn = () => dialog().getByRole('button', { name: '放弃修改' });

/**
 * 按**内容**定位并移除一行。
 *
 * ⚠️ 不能用「移除第 N 环」按位置点：上移 / 下移会改位置，按下标点必然点错行
 * （第一版就是这么错的——先「下移第 1 环」再「移除第 1 环」，删掉的是另一个预设）。
 */
async function removeRowContaining(presetName) {
  const row = page.locator('[data-fallback-index]').filter({ hasText: presetName }).first();
  await row.getByRole('button', { name: /移除第\d+环/ }).click();
  await page.waitForTimeout(600);
}

/** 展开 MUI Select（mousedown 才会开菜单，click 落空） */
async function openSelect(ariaLabel) {
  await byAria(ariaLabel).first().click({ force: true });
  await page.waitForTimeout(600);
}
async function pickOption(text) {
  await page.locator('li[role="option"]').filter({ hasText: text }).first().click();
  await page.waitForTimeout(600);
}

// ══ 场景 1：展示「主模型 / 重试模式 / 空链」═══════════════════════════
console.log('\n场景 1：故障转移的展示');
await seed({ fallbacks: [], providerRetryMode: 'standard', syncCalls: [] });
await openModels();

let text = await dialogText();
check(text.includes('故障转移'), '「故障转移」卡片在模型分区里');
check(
  text.includes('当前主模型：「primary」') && text.includes('primary-model'),
  '主模型指向默认预设并写清它对应的真实模型',
);
check(text.includes('连续 3 次失败后短路 60 秒'), '⭐ 说明了主模型的短路行为（不点不知道）');
check(text.includes('标准') && text.includes('1s / 2s / 4s'), '重试模式显示当前档位与说明');
check(text.includes('还没有配回退'), '空链时给一句结论，而不是留白');
check(
  text.includes('内容被拦截') && text.includes('不会回退'),
  '⭐ 说清了「哪些失败触发回退、哪些不触发」',
);
check((await rows().count()) === 0, '空链不画任何行');

// ══ 场景 2：编辑是草稿（不写盘）、顺序真的会变、可以整体放弃 ══════════
console.log('\n场景 2：草稿语义与顺序编辑');
await seed({ fallbacks: [], providerRetryMode: 'standard', syncCalls: [] });
await openModels();

await openSelect('添加到回退链');
await pickOption('backup-a');
await openSelect('添加到回退链');
await pickOption('backup-b');

check((await rows().count()) === 2, '两环都加进来了');
check((await dialogText()).includes('有未保存的改动'), '⭐ 出现「有未保存的改动」（草稿语义）');
check((await readState()).syncCalls.length === 0, '⭐ 还没点保存，桥一次都没被调用（不逐次重启网关）');

let order = await chainOrder();
check(
  order[0].includes('backup-a') && order[1].includes('backup-b'),
  '初始顺序 = 添加顺序',
  order.join(' | '),
);

await byAria('下移第1环').click();
await page.waitForTimeout(500);
order = await chainOrder();
check(
  order[0].includes('backup-b') && order[1].includes('backup-a'),
  '⭐ 点「下移」后屏幕上的顺序真的换了',
  order.join(' | '),
);
check(
  (await byAria('上移第1环').isDisabled()) === true,
  '第 1 环的上移被禁用（到边界不环绕）',
);
check((await byAria('下移第2环').isDisabled()) === true, '末环的下移被禁用');

await discardBtn().click();
await page.waitForTimeout(600);
check((await rows().count()) === 0, '「放弃修改」把链退回磁盘上的样子（空链）');
check(!(await dialogText()).includes('有未保存的改动'), '放弃后「未保存」标记消失');

// ══ 场景 3：保存 → 载荷顺序 = 屏幕顺序；保存后回读跟得上 ══════════════
console.log('\n场景 3：保存与回读');
await seed({
  fallbacks: [
    { kind: 'preset', preset: 'backup-a' },
    { kind: 'preset', preset: 'backup-b' },
  ],
  providerRetryMode: 'standard',
  syncCalls: [],
});
await openModels();

// 把 backup-b 提到最前，并把重试模式换成「持久」
await byAria('上移第2环').click();
await page.waitForTimeout(500);
await openSelect('供应商重试模式');
await pickOption('持久');

await saveBtn().click();
await page.waitForTimeout(2500);

const calls = (await readState()).syncCalls;
check(calls.length === 1, '桥被调用了恰好一次（一次编辑一次写盘）', JSON.stringify(calls.length));
check(calls[0]?.op === 'setFailover', '指令是 setFailover');
check(
  JSON.stringify(calls[0]?.fallbacks) ===
    JSON.stringify([
      { kind: 'preset', preset: 'backup-b' },
      { kind: 'preset', preset: 'backup-a' },
    ]),
  '⭐ 落盘的链顺序就是屏幕上改过的那个顺序',
  JSON.stringify(calls[0]?.fallbacks),
);
check(calls[0]?.providerRetryMode === 'persistent', '重试模式一并落盘');

text = await dialogText();
check(!text.includes('有未保存的改动'), '保存后「未保存」标记消失');
order = await chainOrder();
check(
  order[0].includes('backup-b') && order[1].includes('backup-a'),
  '保存后回读的链与刚保存的一致（不是乐观本地态）',
  order.join(' | '),
);
check(text.includes('60s'), '重试模式说明跟着换成「持久」那一档');

// ══ 场景 4：链里引用了不存在的预设 → 禁用保存并说明原因 ═══════════════
console.log('\n场景 4：失效引用的阻断');
await seed({
  fallbacks: [
    { kind: 'preset', preset: 'ghost' },
    { kind: 'preset', preset: 'backup-a' },
  ],
  providerRetryMode: 'standard',
  syncCalls: [],
});
await openModels();

text = await dialogText();
check(text.includes('已不存在'), '失效的那一环被标出来（不是显示成空行）');
check(
  text.includes('拒绝整份配置') && text.includes('网关起不来'),
  '⭐ 说清了后果：这是一份引擎加载不了的配置',
);
check(text.includes('ghost'), '失效项的原名还在（用户据此知道要删的是哪一个）');
// 保存按钮此刻**没有**未保存改动 → 本来就禁用；先做一次编辑来验证「有改动也保存不了」
await byAria('下移第1环').click();
await page.waitForTimeout(500);
check((await dialogText()).includes('有未保存的改动'), '编辑后确实有未保存改动');
check(await saveBtn().isDisabled(), '⭐⭐ 但仍**不能保存**（写出了引擎也起不来）');

// 按内容删 ghost（此刻它在第 2 位——上一句刚把它下移过）
await removeRowContaining('ghost');
check((await rows().count()) === 1, '把失效项移掉');
check(
  !(await dialogText()).includes('ghost'),
  '⚠️ 删掉的确实是 ghost（按位置点会删错行）',
);
check(!(await dialogText()).includes('拒绝整份配置'), '阻断提示随之消失');
check(!(await saveBtn().isDisabled()), '⭐ 移除后立刻可以保存（拦的是配置，不是把人锁死）');

await saveBtn().click();
await page.waitForTimeout(2500);
const cleaned = (await readState()).syncCalls;
check(
  JSON.stringify(cleaned.at(-1)?.fallbacks) ===
    JSON.stringify([{ kind: 'preset', preset: 'backup-a' }]),
  '保存下去的是清干净的链',
  JSON.stringify(cleaned.at(-1)?.fallbacks),
);

// ══ 场景 5：删除模型时说明「会一并摘掉回退链里的引用」═══════════════
console.log('\n场景 5：删模型对回退链的影响');
await seed({
  fallbacks: [{ kind: 'preset', preset: 'backup-a' }],
  providerRetryMode: 'standard',
  syncCalls: [],
});
await openModels();

// 模型表的行序是「默认优先、其余按名升序」→ 0 = primary（不在链上）, 1 = backup-a（在链上）。
// 下标只用来找按钮，**打开的是哪一个靠确认框里的名字自证**（下面两条 check 就是这道防线）。
//
// ⚠️ 必须用「具名 role」而不是 `[aria-label="删除"]`：MUI 的 Tooltip 会把 title 复制成
// 包裹层 `<span>` 的 `aria-label`（`data-mui-internal-clone-element`），于是属性选择器
// 每颗按钮都会命中**两个**元素（span + button）。这里 title 恰好也叫「删除」才暴露出来；
// `getByRole('button')` 只认按钮，不受包裹层影响。
const deleteBtn = (i) => dialog().getByRole('button', { name: '删除', exact: true }).nth(i);

await deleteBtn(1).click();
await page.waitForTimeout(800);
let confirm = await confirmText();
check(confirm.includes('backup-a'), '打开的是 backup-a 的删除确认（下标没漂）', confirm.slice(0, 40));
check(confirm.includes('还在「故障转移」的回退链里'), '⭐ 说明它同时挂在回退链上');
check(confirm.includes('一并把那一条摘掉'), '并说明链里那一条会被摘掉');
await confirmBox().getByRole('button', { name: '取消' }).click();
await page.waitForTimeout(600);

// 没挂在链上的模型不该出现这句（否则提示会变成噪音，人人都有）
await deleteBtn(0).click();
await page.waitForTimeout(800);
confirm = await confirmText();
check(confirm.includes('primary'), '打开的是 primary 的删除确认');
check(
  !confirm.includes('还在「故障转移」的回退链里'),
  '不在链上的模型不给这句话（提示不能是噪音）',
  confirm.slice(0, 60),
);

// ══ 截图（交付用：一条配好的链）═══════════════════════════════════
console.log('\n截图：故障转移卡片');
await seed({
  fallbacks: [
    { kind: 'preset', preset: 'backup-a' },
    { kind: 'preset', preset: 'backup-b' },
  ],
  providerRetryMode: 'persistent',
  syncCalls: [],
});
await openModels();
await page.screenshot({ path: 'tasks/failover.png' });
check(true, '截图已写入 tasks/failover.png');

// ══ 汇总 ═══════════════════════════════════════════════════════════
console.log('\n──────────────');
if (errors.length > 0) {
  console.log(`⚠️ 页面错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 5)) console.log('   ', e.slice(0, 200));
}
console.log(
  failures.length === 0 && errors.length === 0
    ? `全部通过（${failures.length} 项失败）`
    : `失败 ${failures.length} 项 / 页面错误 ${errors.length} 条`,
);
for (const f of failures) console.log(' ✗', f);
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1);
