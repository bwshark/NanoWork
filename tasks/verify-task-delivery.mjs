/**
 * 真机验证：任务表单的「结果推送」（FR-5.6）与「生效区间」（FR-5.4）接线。
 *
 * 两趟，各自一个 context：
 * 1. **不加桥桩**（纯 Web）：验空态与「区间不再被编进 cron」。Web 端本来就没有渠道会话，
 *    所以这一趟恰好是空态的真实形态。
 * 2. **加 electronAPI 桥桩**（`listNanobotChannelSessions` 返回两个真实形态的会话）：
 *    把「在表单里挑一个目标 → 点保存」一路验到**交给主进程的 jobs.json 片段**。
 *    这一趟才是「UI 改了但没接线」这类缺陷的唯一探针。
 *
 * 跑法（dev server 已在 5176）：
 *   node tasks/verify-task-delivery.mjs
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

/** 本地日 → `type="date"` 的值（脚本在任何时区都自洽） */
function dayInput(offsetDays = 14) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * electronAPI 桥桩。
 *
 * ⚠️ 三个会**静默毁掉整张截图**的坑（本项目踩过，见 skill §7.14 D）：
 * `on*` 必须返回**函数**（否则 `useEffect` 的 cleanup 变成 Promise → 整页掉进
 * ErrorBoundary）；`then` 与 symbol 必须返回 `undefined`（否则整对象变 thenable）；
 * 形状要给全（缺 `readSessionIndex` 之类会在页面里抛 TypeError，被误当成「点了没反应」）。
 */
const BRIDGE = `
window.__bridge = { syncedTasks: null };
const base = {
  getPlatform: () => 'win32',
  isElectron: () => true,
  /* ⚠️ 这三个必须返回 Promise：调用方会 .catch()，返回裸对象会抛
     appInfo(...).catch is not a function（真机 preload 也是 Promise） */
  appGetInfo: async () => ({ version: '0.0.0-verify', deviceId: 'verify-device', name: 'nanowork' }),
  appGetStorageInfo: async () => ({
    home: 'C:/Users/verify', userData: 'C:/Users/verify/AppData',
    product: 'C:/Users/verify/.nanowork', memory: 'C:/Users/verify/.nanowork/memory',
  }),
  appGetDesktopConfig: async () => ({ closeToTray: false, launchAtLogin: false, autoOpenDevTools: false }),
  storageGet: async () => null,
  storageSet: async () => ({ ok: true }),
  storageRemove: async () => ({ ok: true }),
  readSessionIndex: async () => ({ version: 2, entries: {} }),
  rebuildSessionIndex: async () => ({ version: 2, entries: {} }),
  listSessionMetas: async () => [],
  eventsRead: async () => [],
  readSessionMeta: async () => null,
  pluginsScan: async () => [],
  loadUserSkills: async () => [],
  /* 两个真实形态的渠道会话：一个普通渠道、一个 owner 限定的多实例渠道 */
  nanobotListChannelSessions: async () => ([
    { key: 'wecom:chat-1', channel: 'wecom', title: '研发群', preview: '',
      messageCount: 3, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z' },
    { key: 'feishu.feishu:ou_1', channel: 'feishu.feishu', title: '', preview: '帮我看看这个报错',
      messageCount: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
  ]),
  nanobotListCronRuns: async () => [],
  nanobotGetCronSession: async () => null,
  nanobotSyncTasks: async (json) => {
    window.__bridge.syncedTasks = json;
    return { ok: true, changed: true, message: 'ok' };
  },
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

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  // 本机 http_proxy 会劫持 127.0.0.1 → goto 超时（dev server 其实是好的）
  args: ['--no-proxy-server'],
});

/** 打开任务页并把「添加自动化」点开 */
async function openForm(page) {
  await page.goto(`${APP}/tasks`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('text=添加自动化', { timeout: 120000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '添加自动化', exact: true }).click();
  await page.waitForSelector('[role="dialog"]', { timeout: 20000 });
  await page.waitForTimeout(600);
}

// ═══════════════════ 第一趟：不加桥桩（纯 Web） ═══════════════════

console.log('\n[第一趟] 纯 Web：空态 + 生效区间不再被编进 cron');

const plainErrors = [];
const plain = await browser.newPage({ viewport: { width: 1280, height: 900 } });
plain.on('pageerror', (e) => plainErrors.push(`pageerror: ${e.message}`));
plain.on('console', (m) => {
  // 资源加载失败（引擎不在线时的 /v1/* 探测）不是本页面的错误，滤掉
  if (m.type() === 'error' && !/Failed to load resource|CORS|\/v1\/|404/.test(m.text())) {
    plainErrors.push(m.text());
  }
});

await openForm(plain);
const plainText = await plain.locator('[role="dialog"]').innerText();
check(plainText.includes('结果推送'), '表单出现「结果推送」区');
check(
  plainText.includes('助理设置'),
  '没有渠道会话时给出「去哪儿接入」的提示（而不是一个空菜单）',
  plainText.split('\n').find((l) => l.includes('助理设置')) ?? '',
);
const addBtn = plain.getByRole('button', { name: '添加推送目标' });
check(await addBtn.isDisabled(), '没有可推送会话时「添加推送目标」禁用');

// 每天 09:00 + 生效开始日期 → cron 必须仍是「每天」
const day = dayInput(14);
await plain.getByLabel('名称', { exact: true }).fill('验证·区间');
await plain.getByLabel('开始', { exact: true }).fill(day);
await plain.getByRole('button', { name: '保存', exact: true }).click();
await plain.waitForTimeout(1500);

const plainBody = await plain.locator('body').innerText();
check(plainBody.includes('验证·区间'), '任务已保存并出现在列表');
check(
  plainBody.includes('0 9 * * *'),
  '⭐ 填了生效开始日期后 cron 仍是「每天 09:00」（不再被编成每年一次）',
  (plainBody.match(/Cron: [^\n·]*/) ?? [''])[0],
);
check(
  /\d{4}-\d{2}-\d{2} \d{2}:\d{2} 起/.test(plainBody),
  '生效区间以窗口形式显示在卡片上（FR-5.4）',
);
check(plainErrors.length === 0, '第一趟零页面错误', plainErrors.slice(0, 2).join(' | '));
await plain.screenshot({ path: 'tasks/task-delivery-1-web.png' });

// ═══════════════════ 第二趟：加桥桩（走 Electron 分支） ═══════════════════

console.log('\n[第二趟] 桥桩：从界面点选 → 交给主进程的 jobs.json 片段');

const bridgeErrors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(BRIDGE);
const electron = await ctx.newPage();
electron.on('pageerror', (e) => bridgeErrors.push(`pageerror: ${e.message}`));
electron.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource|CORS|\/v1\/|404/.test(m.text())) {
    bridgeErrors.push(m.text());
  }
});

await openForm(electron);
console.log(
  `  [boot] ${JSON.stringify(await electron.evaluate(() => ({ electron: !!window.electronAPI })))}`,
);

await electron.getByRole('button', { name: '添加推送目标' }).click();
await electron.waitForTimeout(600);
const menuLabels = await electron.locator('[role="menuitem"]').allInnerTexts();
console.log(`  菜单项：${menuLabels.join(' | ')}`);
check(menuLabels.some((t) => t.includes('研发群')), '菜单列出渠道会话（企业微信 · 研发群）');
check(
  menuLabels.some((t) => t.includes('飞书')),
  'owner 限定渠道（feishu.feishu）也在列，并按中文名显示',
);
check(menuLabels.length === 2, '两个会话都在可选列表里', `共 ${menuLabels.length} 项`);

await electron.locator('[role="menuitem"]', { hasText: '研发群' }).first().click();
await electron.waitForTimeout(500);

const chips = await electron.locator('.MuiDialog-paper .MuiChip-label').allInnerTexts();
check(chips.includes('企业微信 · 研发群'), '已选目标以 Chip 呈现', chips.join(' / '));
check(
  (await electron.locator('[role="dialog"]').innerText()).includes('仅失败时'),
  '有目标后出现「推送时机」（档位开关）',
);

// 加第二个目标 + 切到「仅失败时」
await electron.getByRole('button', { name: '添加推送目标' }).click();
await electron.waitForTimeout(500);
const menu2 = await electron.locator('[role="menuitem"]').allInnerTexts();
check(!menu2.some((t) => t.includes('研发群')), '已选过的会话不再出现在菜单里', menu2.join(' | '));
await electron.locator('[role="menuitem"]', { hasText: '飞书' }).first().click();
await electron.waitForTimeout(400);
await electron.getByRole('button', { name: '仅失败时', exact: true }).click();
await electron.waitForTimeout(400);

await electron.getByLabel('名称', { exact: true }).fill('验证·推送');
await electron.getByRole('button', { name: '保存', exact: true }).click();
// 同步有 600ms 防抖
await electron.waitForTimeout(2500);

const synced = await electron.evaluate(() => window.__bridge.syncedTasks);
check(!!synced, '保存后触发了任务同步（拿到了交给主进程的片段）');
if (synced) {
  const job = JSON.parse(synced).jobs.find((j) => j.name === '验证·推送');
  check(!!job, '片段里有刚保存的任务');
  console.log(`  payload.delivery = ${JSON.stringify(job?.payload?.delivery)}`);
  check(
    JSON.stringify(job?.payload?.delivery) ===
      JSON.stringify({
        targets: [
          { channel: 'wecom', chatId: 'chat-1' },
          { channel: 'feishu.feishu', chatId: 'ou_1' },
        ],
        on: 'error',
      }),
    '⭐ 投递配置原样进了 jobs.json 片段（渠道 + 会话 id + 时机）',
    JSON.stringify(job?.payload?.delivery),
  );
  check(
    job?.payload?.deliver === false && job?.payload?.channel === null && job?.payload?.to === null,
    '⭐ legacy 投递字段未被污染（非空会让引擎判「未绑定会话」并禁用任务）',
  );
  check(
    String(job?.payload?.sessionKey ?? '').startsWith('api:cron-'),
    '任务仍绑在自己的 api:cron- 会话上（执行 / 权限 / 留痕不变）',
    String(job?.payload?.sessionKey ?? ''),
  );
}

// 卡片元信息行应显示推送摘要（这一行常驻，不需要 hover——只读状态就用整页文本断言）
const electronBody = await electron.locator('body').innerText();
check(
  electronBody.includes('推送：企业微信、飞书（2 个会话）· 仅失败时'),
  '卡片元信息行显示推送摘要（渠道去重 + 会话数 + 时机）',
  (electronBody.match(/推送：[^\n]*/) ?? [''])[0],
);
check(electronBody.includes('验证·推送'), '任务出现在列表里', '');

check(bridgeErrors.length === 0, '第二趟零页面错误', bridgeErrors.slice(0, 3).join(' | '));
await electron.screenshot({ path: 'tasks/task-delivery-2-picker.png' });

// ═══════════════════ 第三趟：`on: start`（开始通知） ═══════════════════

console.log('\n[第三趟] 切到「开始时」→ 片段 on=start，摘要读作「开始与结束时」');

await openForm(electron);
await electron.getByRole('button', { name: '添加推送目标' }).click();
await electron.waitForTimeout(600);
await electron.locator('[role="menuitem"]', { hasText: '研发群' }).first().click();
await electron.waitForTimeout(500);

const dialog3 = await electron.locator('[role="dialog"]').innerText();
check(
  dialog3.includes('仅失败时') &&
    dialog3.includes('每次执行后') &&
    dialog3.includes('开始时'),
  '推送时机有三档',
  '「开始时」必须与「每次执行后」并排读——它是在结果之外多推一条，不是只推开始',
);

await electron.getByRole('button', { name: '开始时', exact: true }).click();
await electron.waitForTimeout(400);
await electron.getByLabel('名称', { exact: true }).fill('验证·开始通知');
await electron.getByRole('button', { name: '保存', exact: true }).click();
await electron.waitForTimeout(2500);

const synced3 = await electron.evaluate(() => window.__bridge.syncedTasks);
const job3 = synced3
  ? JSON.parse(synced3).jobs.find((j) => j.name === '验证·开始通知')
  : null;
check(!!job3, '第三个任务已保存并进了片段');
check(
  JSON.stringify(job3?.payload?.delivery) ===
    JSON.stringify({
      targets: [{ channel: 'wecom', chatId: 'chat-1' }],
      on: 'start',
    }),
  '⭐ `on: start` 原样进了 jobs.json 片段（引擎侧由 `_DELIVERY_MODES` 认这个取值）',
  JSON.stringify(job3?.payload?.delivery),
);

const body3 = await electron.locator('body').innerText();
check(
  body3.includes('推送：企业微信（1 个会话）· 开始与结束时'),
  '⭐ 卡片摘要读作「开始与结束时」（写「开始时」会被读成「只推开始、不推结果」）',
  (body3.match(/推送：[^\n]*/) ?? [''])[0],
);
check(bridgeErrors.length === 0, '第三趟零页面错误', bridgeErrors.slice(0, 3).join(' | '));
await electron.screenshot({ path: 'tasks/task-delivery-3-start.png' });

console.log(
  `\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}：` +
    `${failures.join(' / ') || '—'}`,
);
await browser.close();
process.exit(failures.length === 0 ? 0 : 1);
