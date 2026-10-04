/**
 * 真机验证：模型能力协商 + 成本口径（FR-9.3 / FR-11.1 的金额）。
 *
 * 与 jsdom 单测的分工：单测钉住纯逻辑（能力解析、三档计价）与 store 语义；
 * 这里钉住**只有真机才能证明**的四件事：
 *
 *   ① 计价区块在**内置供应商**下也渲染出来——它被刻意放在「自定义供应商」的高级配置
 *      之外；若被挪进去，最常见的这批用户就永远配不了单价（jsdom 已验证，这里验版式与可见性）；
 *   ② 「高级配置」仍只给自定义供应商（既有约定没被顺手破坏）；
 *   ③ 「思考能力」关掉后「注入思考强度」真的置灰**并显示原因**（置灰不给原因是 UX 黑洞）；
 *   ④ 用量分区的成本合计与逐模型金额真的画出来了，且**没配单价的模型不计入**。
 *
 * 跑法（dev server 已在 5176）：
 *   node tasks/verify-model-capability.mjs
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

/** 用量行：gpt-4o-mini 输入 8000 / 输出 4345；mystery 那条不该被计入 */
// ⚠️ 计量字段必须是**引擎的 snake_case**（`readCounters` 读的是 `input_tokens` 等）。
// 写成 camelCase 不会报错——每个数都静默变成 0，于是成本恒为 ¥0，看着像单价没配对。
const USAGE_PROVIDERS = [
  {
    // 与桥桩里 `qwen3.8-flash` 那条预设的 (provider, model) 对齐 —— 归因靠这两列
    provider: 'dashscope',
    model: 'qwen3.8-flash',
    input_tokens: 8000,
    output_tokens: 4345,
    total_tokens: 12345,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    requests: 3,
    failed_requests: 0,
    duration_ms: 0,
  },
  {
    provider: 'unknown-gw',
    model: 'mystery-model',
    input_tokens: 1000,
    output_tokens: 0,
    total_tokens: 1000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    requests: 1,
    failed_requests: 0,
    duration_ms: 0,
  },
];

const BRIDGE = `
const RAW = localStorage.getItem('__MC__');
window.__MC__ = RAW ? JSON.parse(RAW) : { presetModel: 'qwen3.8-flash' };
const M = () => window.__MC__;
const save = () => localStorage.setItem('__MC__', JSON.stringify(M()));

/** 预设快照：一个内置（带单价）、一个自定义供应商（高级配置只在它身上显示） */
const PRESETS = () => ({
  presets: {
    'qwen3.8-flash': {
      model: 'qwen3.8-flash',
      provider: 'dashscope',
      maxTokens: 32768,
      contextWindowTokens: 200000,
      temperature: 0.1,
      reasoningEffort: null,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: true,
      customProtocol: false,
      pricing: { inputPerMillion: 10, outputPerMillion: 20, cacheReadPerMillion: 1, currency: 'CNY' },
    },
    'local-chat': {
      model: 'local-chat',
      provider: 'my-gateway',
      maxTokens: 32768,
      contextWindowTokens: 131072,
      temperature: 0.1,
      reasoningEffort: 'high',
      supportsTools: false,
      supportsVision: true,
      supportsReasoning: true,
      customProtocol: false,
      pricing: null,
    },
    // 单独一条「能力为假」的预设：**必须与 reasoningEffort 自洽**（能力为假时强度为 null），
    // 否则夹具本身就是我们写入侧会产出矛盾数据的例子
    'no-think': {
      model: 'no-think',
      provider: 'my-gateway',
      maxTokens: 32768,
      contextWindowTokens: 200000,
      temperature: 0.1,
      reasoningEffort: null,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: false,
      customProtocol: false,
      pricing: null,
    },
  },
  providers: {
    dashscope: { apiKey: null, apiBase: null, displayName: null },
    'my-gateway': { apiKey: null, apiBase: 'https://gw.example.com/v1', displayName: 'my-gateway' },
  },
  defaultPreset: null,
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
  nanobotGetModels: async () => PRESETS(),
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

const ctx = await (async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-proxy-server'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(BRIDGE);
  const boot = await context.newPage();
  await boot.goto(APP, { waitUntil: 'domcontentloaded' });
  await boot.evaluate(() => localStorage.removeItem('__MC__'));
  await boot.close();
  return context;
})();

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
async function openSettings(sectionLabel) {
  page = await ctx.newPage();
  attachLogs(page);
  await page.goto(`${APP}/settings`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('[role="dialog"]', { timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.locator('nav[aria-label="配置项"]').getByText(sectionLabel, { exact: true }).click();
  await page.waitForTimeout(900);
}

const dialog = () => page.locator('[role="dialog"]');
const dialogText = async () => (await dialog().innerText()).replace(/\s+/g, ' ');
const byAria = (label) => page.locator(`[aria-label="${label}"]`);

// ══ 场景 1：模型分区 → 添加模型（默认内置供应商）════════════════════
//
// 这一场的重点就是「**哪些在、哪些不在**」：能力勾选项与上下文窗口都在
// `custom &&` 分支里（内置供应商不显示，既有约定），而**计价必须在外面**——
// 放进去了，最常见的这批用户就永远配不了单价。
console.log('\n场景 1：添加模型（内置供应商）');
await openSettings('模型');
await dialog().getByRole('button', { name: '添加模型' }).click();
await page.waitForTimeout(1200);
const modelDialog = page.locator('[role="dialog"]').last();
const modelText = async () => (await modelDialog.innerText()).replace(/\s+/g, ' ');
let text = await modelText();

check(
  (await modelDialog.locator('[aria-label="上下文窗口"]').count()) === 0,
  '内置供应商**不显示**高级配置（既有约定没被破坏）',
);
for (const label of ['工具调用', '图片输入', '思考能力', '注入思考强度', '自定义协议']) {
  check(
    (await modelDialog.locator(`[aria-label="${label}"]`).count()) === 0,
    `勾选项「${label}」随高级配置一起隐藏`,
  );
}
check(
  (await modelDialog.locator('[aria-label="输入单价"]').count()) === 1 &&
    (await modelDialog.locator('[aria-label="输出单价"]').count()) === 1 &&
    (await modelDialog.locator('[aria-label="缓存读取单价"]').count()) === 1,
  '⭐ 内置供应商**也能配单价**（计价在「自定义」分支之外）',
);
check((await modelDialog.locator('[aria-label="计价币种"]').count()) === 1, '币种选择器在');
check(text.includes('计价（每百万 token）'), '计价区有标题');
check(text.includes('按输入单价') || text.includes('缓存读取') , '说明了缓存缺省口径', text.slice(-120));

// ══ 场景 2a：编辑自定义供应商的预设（回填）══════════════════════════
console.log('\n场景 2a：自定义预设的回填');
await openSettings('模型');
// 预设表按「默认优先、其余按名升序」→ local-chat / no-think / qwen3.8-flash
await dialog().locator('[aria-label="编辑"]').first().click();
await page.waitForTimeout(1500);
const customDialog = page.locator('[role="dialog"]').last();

check(
  (await customDialog.locator('[aria-label="模型名称"]').inputValue()) === 'local-chat',
  '打开的是自定义供应商的那条预设',
);
check((await customDialog.locator('[aria-label="上下文窗口"]').count()) === 1, '自定义显示高级配置');
for (const label of ['工具调用', '图片输入', '思考能力', '注入思考强度', '自定义协议']) {
  check((await customDialog.locator(`[aria-label="${label}"]`).count()) === 1, `勾选项「${label}」在`);
}
check((await customDialog.locator('[aria-label="输入单价"]').count()) === 1, '自定义同样有计价');
check(
  (await customDialog.locator('[aria-label="上下文窗口"]').inputValue()) === '128K',
  '上下文窗口按原值回填（131072 → 128K）',
);
check(await customDialog.locator('[aria-label="思考能力"]').isChecked(), '回填：声明支持思考 → 勾上');
check(await customDialog.locator('[aria-label="注入思考强度"]').isChecked(), '回填：档位是 high → 强度勾上');
check(
  await customDialog.locator('[aria-label="注入思考强度"]').isEnabled(),
  '能力为真时强度可选（两者是独立的两件事）',
);
await customDialog.getByRole('button', { name: '取消' }).click();
await page.waitForTimeout(600);

// ══ 场景 2b：能力为假 → 强度被门控（置灰 + 给原因）══════════════════
console.log('\n场景 2b：思考能力门控');
await dialog().locator('[aria-label="编辑"]').nth(1).click();
await page.waitForTimeout(1500);
const gateDialog = page.locator('[role="dialog"]').last();
const gateText = async () => (await gateDialog.innerText()).replace(/\s+/g, ' ');

check(
  (await gateDialog.locator('[aria-label="模型名称"]').inputValue()) === 'no-think',
  '打开的是「声明不支持思考」的那条预设',
);
check(
  !(await gateDialog.locator('[aria-label="思考能力"]').isChecked()),
  '回填：声明不支持思考 → 勾选框是关的',
);
check(
  !(await gateDialog.locator('[aria-label="注入思考强度"]').isChecked()),
  '能力为假时强度不该是勾上的',
);
check(await gateDialog.locator('[aria-label="注入思考强度"]').isDisabled(), '强度被置灰');
check(
  (await gateText()).includes('已声明该模型没有思考能力'),
  '⭐ 置灰给出了原因（不是让用户猜）',
);

// 反向走一遍：能力打开 → 强度可开且能勾上 → 再关掉能力 → 强度被清空并重新置灰
await gateDialog.locator('[aria-label="思考能力"]').click();
await page.waitForTimeout(500);
check(await gateDialog.locator('[aria-label="注入思考强度"]').isEnabled(), '打开能力后强度可选');
await gateDialog.locator('[aria-label="注入思考强度"]').click();
await page.waitForTimeout(600);
check(await gateDialog.locator('[aria-label="注入思考强度"]').isChecked(), '强度可以开起来');

await gateDialog.locator('[aria-label="思考能力"]').click();
await page.waitForTimeout(600);
check(
  !(await gateDialog.locator('[aria-label="注入思考强度"]').isChecked()),
  '⭐ 再次关掉能力 → 强度被一并清空（不留一个仍然生效的档位）',
);
check(await gateDialog.locator('[aria-label="注入思考强度"]').isDisabled(), '并重新置灰');

// ══ 场景 4：用量分区 → 成本合计与逐模型金额 ══════════════════════════
console.log('\n场景 4：用量分区的成本');
// 用量数据来自引擎 HTTP，真机上没有网关 → 用**上下文级**路由桩喂进去。
// ⚠️ 必须挂在 ctx 上而不是 page 上：每个场景都开新 page，挂在旧 page 上等于没挂
// （症状就是「Failed to fetch」，看着像引擎没起）。
await ctx.route('**/v1/usage*', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      timezone_name: 'Asia/Shanghai',
      window_days: 90,
      // ⚠️ 键名必须与引擎 payload 一致：解码器读的是 `providers_30d` / `sources` /
      // `*_30d`（见 `nanobotHttp/usage.ts::decodeUsagePayload`），不是 camelCase
      days: [
        {
          date: '2026-10-04',
          input_tokens: 8000,
          output_tokens: 4345,
          total_tokens: 12345,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          requests: 3,
          failed_requests: 0,
          duration_ms: 0,
          sources: { user: { input_tokens: 8000, output_tokens: 4345, total_tokens: 12345, requests: 3 } },
        },
      ],
      total_tokens: 12345,
      providers_30d: USAGE_PROVIDERS,
      updated_at: '2026-10-04T08:00:00Z',
    }),
  });
});
await openSettings('用量');
await page.waitForTimeout(2500);
text = await dialogText();

check(text.includes('成本'), '成本卡片在');
check(text.includes('¥0.1669'), '⭐ 合计按三档算出（内置预设带单价）', text.slice(-260));
check(text.includes('覆盖 1 个模型'), '说明合计覆盖了几个模型');
check(text.includes('还有 1 个模型没配单价（未计入）'), '⭐ 没配单价的模型不计入，但如实报数');
check(text.includes('输入 ¥10 · 缓存 ¥1 · 输出 ¥20'), '逐模型行显示单价口径');
check(text.includes('未配置单价 → 不计入金额合计'), '没配单价的行说明为什么没有金额');

// ══ 场景 5：输入区的能力门控（技能入口禁用 + 给原因）═══════════════
console.log('\n场景 5：输入区的技能门控');
page = await ctx.newPage();
attachLogs(page);
await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForTimeout(2500);
await page.evaluate(async () => {
  const models = await import('/src/stores/modelsStore.ts');
  const sessions = await import('/src/stores/sessionsStore.ts');
  await models.useModelsStore.getState().loadManaged(true);
  const s = sessions.useSessionsStore.getState().createSession(undefined, '门控验证');
  sessions.useSessionsStore.getState().setSessionModel(s.id, 'local-chat');
});
await page.waitForTimeout(1200);

await page.locator('[data-testid="AddIcon"]').first().click();
await page.waitForTimeout(700);
const skillsItem = page.locator('[role="menuitem"]').filter({ hasText: '技能' }).first();
check((await skillsItem.count()) === 1, '加号菜单里有「技能」');
check(
  (await skillsItem.getAttribute('aria-disabled')) === 'true',
  '⭐ 模型不支持工具调用 → 技能入口禁用',
);
check(
  (await skillsItem.innerText()).includes('当前模型不支持工具调用'),
  '⭐ 禁用处写出了原因',
);

const real = errors.filter((e) => !/The above error/.test(e));
check(real.length === 0, '零页面错误', real.slice(0, 2).join(' | ').slice(0, 200));

console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项`}`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join('\n'));
await page?.screenshot({ path: 'tasks/model-capability.png', fullPage: false }).catch(() => {});
process.exit(failures.length === 0 ? 0 : 1);
