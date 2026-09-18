/**
 * 技能页的字段展示与三态控制（FR-3.1）。
 *
 * 这个页面的价值全在「展示的是真实字段」上：版本 / 来源 / 分类都来自
 * SKILL.md 解析结果或扫描结果，一旦渲染时写死或猜值，用户就会按错的信息做决策。
 *
 * 「基本信息」面板刻意**只留身份字段**（版本 / 来源 / 分类）。工具白名单、
 * 手动调用、本地路径三项已移除：前两项会与菜单里的三态控制重复打架，
 * 本地路径既占位又泄露用户名，真正的入口是菜单里的「打开文件夹」。
 * 面板带 `aria-label="基本信息"`，断言一律限定在面板内部 ——
 * 用整个浮层的 textContent 去查会因为菜单/卡片上的同名文案而失效。
 *
 * ## 三个容易踩的坑
 *
 * 1. **两个入口都是浮层**（都走 Portal 到 `document.body`，查询一律用 `dialogRoot()`）：
 *    市场卡点开的是**快速预览弹窗**（图标 + 安装 + 描述 + 基本信息），
 *    已安装卡点开的是**详情窗口**（去试试 + 开关 + 基本信息 + 概述全文）。
 *    两者用 `aria-label="技能详情"` 与会话内的详情浮层区分，别按 `host` 找。
 * 2. **卡片里的「⋯」菜单用了 `useNavigate`**，所以页面必须在 Router 上下文里挂载。
 *    生产环境由 `router/index.tsx` 提供，测试里用 `MemoryRouter` 补上。
 * 3. **详情窗口打开时列表仍在背后**（这正是它不做整页接管的原因）——
 *    断言「关窗后卡片还在」与断言「开窗时卡片就在」是两件事，两个都要测。
 * 4. **「⋯」菜单的对齐方向按入口分两套**（卡片右对齐 / 窗口左对齐）。jsdom 量不到
 *    Popper 的真实坐标，所以这条几何约束由 `skillMenuOrigin` 的纯函数单测守住，
 *    实际像素另外用 Playwright 截图对照。
 *
 * ## 关于「三态」的控件形态（**三个入口必须同步**，这是本节的主要契约）
 *
 * 一个 `override` 字段，三个入口，任何时刻都要说同一件事：
 *
 * - **卡片开关 / 详情窗口开关**（常驻）：自动触发开 ⇄ 关 ⇔ `override === 'on'`。
 *   关掉落到**中间档**（模型看不见、你还能手动挂载），**不是** `off` ——
 *   判据走 `isAutoTriggerOn`（与引擎同构的 `isSkillListedToModel` 同源）。
 * - **⋯ 菜单底部三行**：完整的档位单选，`aria-checked` 落在当前档上。
 *   `off`（停用：模型和你都用不了）只有这里能选到，开关上没有这个位置。
 *
 * 这里要防的回归很具体：菜单曾经是「一行兼两用」——文案写**动作**、对勾写**当前档**，
 * 于是中间档下渲染成 `✓ 完全启用（模型可见）`（而模型其实看不见它），
 * 同时开关因用 `override !== 'off'` 仍是「开着」，两处彻底对不上。
 * 所以**跨控件**的断言（菜单选完 → 开关跟着动）必须有，只测单点测不出来。
 *
 * 卡片右上角另一个图标按钮是**置顶**，它和三态无关：一个改技能属性（要推引擎），
 * 一个只改这份列表的顺序（纯本地偏好）。两者外形相近，断言必须分开，
 * 否则很容易写出「置顶之后 override 也变了」这种错的双向覆盖。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SkillsPage } from '@/pages/skills/SkillsPage';
import {
  autoTriggerHint,
  isAutoTriggerOn,
  nextAutoTriggerOverride,
  orderInstalledSkills,
  overrideToast,
  skillMenuOrigin,
} from '@/components/skills/skillMeta';
import { useSkillsStore } from '@/stores/skillsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { platform } from '@/platform';
import { byAria, buttonByText, click, dialogRoot, flush, mount, setInputValue, unmount } from './helpers/reactMount';
import type { Skill } from '@/types';

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  // 磁盘扫描：内置技能不来自这里，模拟两个本地技能（用户级 + 项目级）
  vi.spyOn(platform, 'loadUserSkills').mockResolvedValue([
    {
      id: 'user-skill',
      name: '用户级技能',
      description: '放在 ~/.nanowork/skills 里的技能',
      category: 'Other',
      prompt: '正文 A',
      source: 'local',
      scope: 'user',
      override: 'on',
      enabled: true,
      allowedTools: ['Read', 'Write', 'Bash'],
      userInvocable: true,
      version: '1.2.3',
    } as Skill,
    {
      id: 'proj-skill',
      name: '项目级技能',
      description: '放在 workspace/skills 里的技能',
      category: 'Other',
      prompt: '正文 B',
      source: 'local',
      scope: 'project',
      override: 'on',
      enabled: true,
      userInvocable: false,
    } as Skill,
  ]);
  vi.spyOn(platform, 'syncNanobotSkills').mockResolvedValue({ ok: true, message: '' });
  vi.spyOn(platform, 'onSkillsChanged').mockReturnValue(() => {});
  useSkillsStore.setState({ skills: [], pinnedIds: [], loaded: false, syncError: null });
  useSessionsStore.setState({ sessions: [], activeId: null });
});

/** 技能页依赖 Router 上下文（卡片内的「⋯」菜单要跳对话） */
function mountPage(): HTMLDivElement {
  return mount(
    <MemoryRouter>
      <SkillsPage />
    </MemoryRouter>,
  );
}

function cardOf(host: HTMLElement, name: string): HTMLElement {
  const el = Array.from(host.querySelectorAll('.MuiCard-root')).find((card) =>
    (card.textContent ?? '').includes(name),
  );
  expect(el, `未找到「${name}」的卡片`).toBeTruthy();
  return el as HTMLElement;
}

/**
 * 挂载技能页并切到「我安装的」视图。
 *
 * 默认的「全部技能」视图只列**未启用**（`off`）的技能 —— 这是既有的市场语义
 * （已启用的只出现在「我安装的」，避免同一技能两个入口并存）。
 * 因此要检查已启用技能的卡片，必须先切视图。
 */
async function mountInstalled(): Promise<HTMLDivElement> {
  const host = mountPage();
  await flush();
  click(buttonByText(host, '我安装的'));
  await flush();
  return host;
}

/** 点开某张已安装卡的详情**窗口**，返回窗口根节点（Portal，不在 host 内） */
async function openDetail(host: HTMLElement, name: string): Promise<HTMLElement> {
  click(cardOf(host, name));
  await flush();
  const win = byAria('技能详情');
  expect(win, '未找到技能详情窗口').toBeTruthy();
  // 两个入口都是浮层：拿 dialogRoot 做交叉验证，避免「标签挂在了别处」也能过
  expect(dialogRoot()).toBe(win);
  return win as HTMLElement;
}

/** 详情窗口当前是否开着 */
function detailWindowOpen(): boolean {
  return byAria('技能详情') !== null;
}

/**
 * 「我安装的」列表里卡片的**顺序**（按名称）。
 *
 * 不能只断言「卡片还在」：置顶这件事的全部意义就是顺序，只查存在性等于没测。
 */
function installedOrder(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('.MuiCard-root')).map((card) =>
    (card.querySelector('.MuiTypography-root')?.textContent ?? '').trim(),
  );
}

/**
 * 菜单项（MUI `MenuItem`）。
 *
 * `[role^="menuitem"]` 同时覆盖两类：普通动作是 `menuitem`，底部的三档是
 * `menuitemradio`（单选行，靠 `aria-checked` 表达当前档）。
 *
 * 菜单走 Portal 到 `document.body`，不在 host 里，所以只能全局查；
 * 按文案找而不是按索引 —— 菜单项是**排列会变**的一列动作。
 *
 * 同名取**最后一个**：MUI 的 Menu 退场动画约 200ms，这期间上一份菜单还留在
 * DOM 里，先查到的是那份已经作废的旧菜单（对勾位置是旧状态）——
 * 结果是「断言看着过了，其实读的是已关闭的菜单」。
 */
function menuItem(label: string): HTMLElement | null {
  const hits = Array.from(document.querySelectorAll('[role^="menuitem"]')).filter((el) =>
    (el.textContent ?? '').includes(label),
  ) as HTMLElement[];
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * 走真实路径改档位：打开卡片的 ⋯ 菜单 → 点某一档。
 *
 * 停用（`off`）只在菜单里 —— 卡片开关的两个位置是「自动触发」的开/关，
 * 关掉落到中间档。所以凡是要造一个 `off` 的前置条件，都必须走这里，
 * 顺便把「三档在菜单里真的点得到」也测了。
 */
async function setOverrideViaMenu(host: HTMLElement, name: string, label: string): Promise<void> {
  click(byAria(`${name} 操作菜单`, host));
  await flush();
  const item = menuItem(label);
  expect(item, `菜单里未找到「${label}」`).toBeTruthy();
  click(item);
  await flush();
}

/** 卡片上那个开关的选中态（`aria-label` 落在真正的 checkbox input 上） */
function switchChecked(host: HTMLElement, name: string): boolean {
  return (byAria(`${name} 自动触发`, host) as HTMLInputElement | null)?.checked ?? false;
}

describe('技能页：真实字段展示（已安装技能详情页）', () => {
  it('本地技能在详情里带出来源层级', async () => {
    const host = await mountInstalled();
    const dialog = await openDetail(host, '用户级技能');
    expect(dialog.textContent).toContain('用户级');

    unmount();
    const host2 = await mountInstalled();
    const dialog2 = await openDetail(host2, '项目级技能');
    expect(dialog2.textContent).toContain('项目级');
    unmount();
  });

  it('「基本信息」只放身份字段：工具白名单 / 手动调用 / 本地路径都不再出现在面板里', async () => {
    const host = await mountInstalled();

    // 面板有独立的 aria-label，断言的是「这一块里没有某些字段」，
    // 而不是「整个窗口里没有这几个字」—— 后者会被菜单/卡片上的同名文案放过
    const win = await openDetail(host, '用户级技能');
    const winPanel = byAria('基本信息', win);
    expect(winPanel, '未找到基本信息面板').toBeTruthy();
    expect(winPanel!.textContent).toContain('1.2.3'); // 版本仍在
    expect(winPanel!.textContent).toContain('用户级'); // 来源仍在
    expect(winPanel!.textContent).toContain('Other'); // 分类仍在
    expect(winPanel!.textContent).not.toContain('工具白名单');
    expect(winPanel!.textContent).not.toContain('手动调用');
    expect(winPanel!.textContent).not.toContain('本地路径');

    click(byAria('关闭技能详情'));
    // Dialog 退场过渡约 200ms，不等它会把「下一个弹窗」查成还开着的那个
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await flush();

    // 市场弹窗复用同一份 `skillInfoRows`，也必须同样干净 —— 两个入口各写一份
    // 字段列表正是要根除的那个问题。市场卡只在技能「停用」时出现，
    // 而停用只从 ⋯ 菜单里可点（开关关掉的是自动触发，技能仍在已安装池里）。
    await setOverrideViaMenu(host, '用户级技能', '停用');
    click(byAria('返回全部技能', host));
    await flush();
    click(byAria('用户级技能 详情', host));
    await flush();

    const marketPanel = byAria('基本信息', dialogRoot());
    expect(marketPanel, '未找到市场弹窗的基本信息面板').toBeTruthy();
    expect(marketPanel!.textContent).toContain('1.2.3');
    expect(marketPanel!.textContent).not.toContain('工具白名单');
    expect(marketPanel!.textContent).not.toContain('本地路径');
    // 注意：市场弹窗底部还有「不可手动调用」能力标签，它对「可手动调用」是超串，
    // 所以这条必须限定在面板内部断言，不能拿整个弹窗的 textContent 去查
    expect(marketPanel!.textContent).not.toContain('手动调用');
    unmount();
  });

  it('版本号只在真实存在时展示', async () => {
    const host = await mountInstalled();
    const dialog = await openDetail(host, '用户级技能');
    expect(dialog.textContent).toContain('1.2.3');
    unmount();

    const host2 = await mountInstalled();
    const dialog2 = await openDetail(host2, '项目级技能');
    expect(dialog2.textContent).not.toContain('版本');
    unmount();
  });
});

describe('技能页：详情页的交互（开关 / 去试试 / 概述）', () => {
  it('详情窗口的开关与卡片上的开关是同一个：关掉它，两处一起变成「关」', async () => {
    const host = await mountInstalled();
    const panel = await openDetail(host, '用户级技能');

    // 同一个 aria-label：两个入口是同一个开关，不是两套状态
    click(byAria('用户级技能 自动触发', panel));
    await flush();

    // 关掉的是「自动触发」→ 落到中间档（模型看不见、你还能手动挂载），不是停用
    const stored = useSkillsStore.getState().skills.find((s) => s.id === 'user-skill');
    expect(stored?.override).toBe('user-invocable-only');
    expect(stored?.enabled).toBe(true);
    // 窗口留在原地（不是被关掉），背后那张卡上的同一个开关也必须跟着回到「关」
    expect(detailWindowOpen()).toBe(true);
    expect(switchChecked(host, '用户级技能')).toBe(false);
    unmount();
  });

  it('窗口内的 ⋯ 菜单改档，窗口里那个开关立刻跟上（同一个字段的两个入口）', async () => {
    const host = await mountInstalled();
    const panel = await openDetail(host, '用户级技能');
    expect((byAria('用户级技能 自动触发', panel) as HTMLInputElement).checked).toBe(true);

    // 在窗口里选「仅手动调用」：开关必须同时弹回左边 ——
    // 这一条正是用户报的「算不算同一个功能」：菜单说仅手动、开关还开着就是不对
    click(byAria('用户级技能 操作菜单', panel));
    await flush();
    click(menuItem('仅手动调用'));
    await flush();

    expect((byAria('用户级技能 自动触发', panel) as HTMLInputElement).checked).toBe(false);
    // 反向：再打开一次开关，菜单的对勾要回到「完全启用」上。
    // 等上一份菜单退场（约 200ms）再开新的，否则读到的是还在淡出的旧菜单
    click(byAria('用户级技能 自动触发', panel));
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    click(byAria('用户级技能 操作菜单', panel));
    await flush();
    expect(menuItem('完全启用')?.getAttribute('aria-checked')).toBe('true');
    expect(menuItem('仅手动调用')?.getAttribute('aria-checked')).toBe('false');
    unmount();
  });

  it('停用时「去试试」禁用；仅手动调用时仍可用（两档的差别就在这里）', async () => {
    const host = await mountInstalled();
    // 停用（off）只从 ⋯ 菜单里点得到：开关关掉的是自动触发，落到的是中间档
    await setOverrideViaMenu(host, '用户级技能', '停用');

    const panel = await openDetail(host, '用户级技能');
    expect(buttonByText(panel, '去试试')?.disabled).toBe(true);
    unmount();

    // 反向护栏：中间档只是「模型看不见」，用户照样挂得上，
    // 把它的「去试试」也禁用会让「仅手动调用」变得毫无意义
    const host2 = await mountInstalled();
    await setOverrideViaMenu(host2, '用户级技能', '仅手动调用');
    const panel2 = await openDetail(host2, '用户级技能');
    expect(buttonByText(panel2, '去试试')?.disabled).toBe(false);
    unmount();
  });

  it('「去试试」把技能挂到当前会话的 skillIds 上', async () => {
    const host = await mountInstalled();
    const panel = await openDetail(host, '用户级技能');

    expect(useSessionsStore.getState().activeId).toBeNull();
    click(buttonByText(panel, '去试试'));
    await flush();

    // 没有活跃会话时要先建一个：否则用户到了对话页，技能挂在一个不存在的会话上
    const st = useSessionsStore.getState();
    expect(st.activeId, '未创建/激活会话').toBeTruthy();
    const session = st.sessions.find((s) => s.id === st.activeId);
    expect(session?.skillIds).toContain('user-skill');
    unmount();
  });

  it('概述渲染的是技能真实正文（prompt），没有正文时整段不出现', async () => {
    const host = await mountInstalled();
    const panel = await openDetail(host, '用户级技能');
    expect(panel.textContent).toContain('概述');
    expect(panel.textContent).toContain('正文 A');
    unmount();

    // 反向护栏：正文为空的技能不该留一个空的「概述」标题
    vi.mocked(platform.loadUserSkills).mockResolvedValue([
      {
        id: 'blank-skill',
        name: '空正文技能',
        description: '没有正文',
        category: 'Other',
        prompt: '   ',
        source: 'local',
        scope: 'user',
        override: 'on',
        enabled: true,
      } as Skill,
    ]);
    const host2 = await mountInstalled();
    const panel2 = await openDetail(host2, '空正文技能');
    expect(panel2.textContent).not.toContain('概述');
    unmount();
  });

  it('概述把 SKILL.md 的 Markdown 真渲染出来（代码块可读，未整段丢弃）', async () => {
    vi.mocked(platform.loadUserSkills).mockResolvedValue([
      {
        id: 'md-skill',
        name: '带正文的技能',
        description: '正文含 Markdown 结构',
        category: 'Other',
        prompt: '## 用法\n\n```bash\nplaywright-cli tab-list\n```\n',
        source: 'local',
        scope: 'user',
        override: 'on',
        enabled: true,
      } as Skill,
    ]);
    const host = await mountInstalled();
    const panel = await openDetail(host, '带正文的技能');

    // 标题渲染成元素而不是原样吐出 `##`，代码块内容逐字保留
    expect(panel.querySelector('h2')?.textContent).toContain('用法');
    expect(panel.textContent).toContain('playwright-cli tab-list');
    unmount();
  });

  it('关闭按钮回到「我安装的」列表，且列表全程都在背后可见', async () => {
    const host = await mountInstalled();
    await openDetail(host, '用户级技能');

    // 浮层不接管页面：开窗时列表仍在，关窗后也不需要一个「重新加载」的过程
    expect(cardOf(host, '用户级技能')).toBeTruthy();

    click(byAria('关闭技能详情'));
    // Dialog 的退出过渡大约 200ms，过渡跑完才真正把纸面从 DOM 里摘掉 ——
    // 只 flush 微任务会在过渡中途断言失败（看着像「点了没关」）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await flush();

    expect(detailWindowOpen()).toBe(false);
    expect(cardOf(host, '用户级技能')).toBeTruthy();
    unmount();
  });

  it('概述里的搜索能数出真实命中数（不是写死的计数）', async () => {
    vi.mocked(platform.loadUserSkills).mockResolvedValue([
      {
        id: 'search-skill',
        name: '可搜索的技能',
        description: '正文里同一个词出现两次',
        category: 'Other',
        prompt: '## 用法\n\n第一步用 playwright 打开页面\n\n第二步用 playwright 截图\n',
        source: 'local',
        scope: 'user',
        override: 'on',
        enabled: true,
      } as Skill,
    ]);
    const host = await mountInstalled();
    const win = await openDetail(host, '可搜索的技能');

    click(byAria('搜索概述', win));
    await flush();

    // 计数来自遍历渲染后 DOM 的真实命中：'playwright' 恰好 2 处
    // aria-label 挂在真正的 input 上（InputBase 的 inputProps），所以查询到的就是输入框
    setInputValue(byAria('搜索概述内容', win) as HTMLInputElement, 'playwright');
    await flush();
    expect(win.textContent).toContain('1/2');

    // 换成只出现一次的关键词，计数必须跟着变（防「恒定输出 1/N」的假实现）
    setInputValue(byAria('搜索概述内容', win) as HTMLInputElement, '截图');
    await flush();
    expect(win.textContent).toContain('1/1');
    unmount();
  });

  it('市场卡点开的是「预览弹窗」，与已安装的「详情窗口」是两种形态', async () => {
    const host = await mountInstalled();
    // 停用后该技能回到市场池，此时市场卡才存在
    await setOverrideViaMenu(host, '用户级技能', '停用');
    click(byAria('返回全部技能', host));
    await flush();

    click(byAria('用户级技能 详情', host));
    await flush();

    // 市场入口是「装之前看得懂」的预览：有安装动作、不读全文
    const market = dialogRoot();
    expect(market.textContent).toContain('安装');
    expect(market.textContent).not.toContain('概述');
    // 它没有详情窗口的那套管理动作
    expect(byAria('关闭技能详情')).toBeNull();
    unmount();
  });
});

describe('技能页：三态控制', () => {
  it('中间档收在 ⋯ 菜单里（卡片上不再有独立按钮）', async () => {
    const host = await mountInstalled();

    // 卡片右上角只剩「⋯ + 置顶」，中间档没有自己的按钮 —— 这是有意的信息收敛，
    // 所以这里先反向确认「旧按钮真的没了」，再走菜单这条真实路径。
    expect(
      byAria('用户级技能 仅手动调用', host),
      '卡片上不该再有「仅手动调用」按钮',
    ).toBeNull();

    click(byAria('用户级技能 操作菜单', host));
    await flush();

    const item = menuItem('仅手动调用');
    expect(item, '菜单里未找到「仅手动调用」').toBeTruthy();
    click(item);
    await flush();

    const stored = useSkillsStore.getState().skills.find((s) => s.id === 'user-skill');
    expect(stored?.override).toBe('user-invocable-only');
    // 中间档不是「停用」：用户照样能挂载，只是模型看不见
    expect(stored?.enabled).toBe(true);
    unmount();
  });

  it('⋯ 菜单把三档列全，对勾只落在当前档上（行文案 = 状态名，不是动作名）', async () => {
    const host = await mountInstalled();
    click(byAria('用户级技能 操作菜单', host));
    await flush();

    // 三行必须同时在：少一行就等于有一档从界面上消失了
    for (const label of ['完全启用', '仅手动调用', '停用']) {
      expect(menuItem(label), `菜单缺少「${label}」这一档`).toBeTruthy();
    }
    expect(menuItem('完全启用')?.getAttribute('aria-checked')).toBe('true');
    expect(menuItem('仅手动调用')?.getAttribute('aria-checked')).toBe('false');
    expect(menuItem('停用')?.getAttribute('aria-checked')).toBe('false');
    unmount();
  });

  it('处于中间档时，对勾落在中间档那一行', async () => {
    const host = await mountInstalled();
    useSkillsStore.setState({
      skills: useSkillsStore
        .getState()
        .skills.map((s) =>
          s.id === 'user-skill' ? { ...s, override: 'user-invocable-only' } : s,
        ),
    });
    await flush();

    click(byAria('用户级技能 操作菜单', host));
    await flush();
    // 曾经这里渲染成 `✓ 完全启用（模型可见）`：文案跟着状态翻转、对勾表示的是
    // 「当前在中间档」，两处都在撒谎。现在行文案固定，只有对勾说明位置。
    expect(menuItem('仅手动调用')?.getAttribute('aria-checked')).toBe('true');
    expect(menuItem('完全启用')?.getAttribute('aria-checked')).toBe('false');
    unmount();
  });

  it('菜单里选「仅手动调用」后，卡片开关跟着弹回左边（同一个字段）', async () => {
    const host = await mountInstalled();
    expect(switchChecked(host, '用户级技能')).toBe(true);

    await setOverrideViaMenu(host, '用户级技能', '仅手动调用');

    expect(
      useSkillsStore.getState().skills.find((s) => s.id === 'user-skill')?.override,
    ).toBe('user-invocable-only');
    // 这就是用户报的「不同步」：菜单说仅手动调用，开关必须同时变成「关」
    expect(switchChecked(host, '用户级技能')).toBe(false);
    unmount();
  });

  it('开关关掉落到中间档（不是停用），卡片留在列表里可原地再打开', async () => {
    const host = await mountInstalled();

    // 开关的 aria-label 落在真正的 checkbox input 上：点它才会走 MUI 的 onChange，
    // 点外层 span 只是视觉反馈，状态不会变（看起来像「点了没反应」）。
    const sw = byAria('用户级技能 自动触发', host);
    expect(sw, '未找到自动触发开关').toBeTruthy();
    click(sw);
    await flush();

    const stored = useSkillsStore.getState().skills.find((s) => s.id === 'user-skill');
    // 关掉的是自动触发：模型不再自主加载，但技能仍可用（用户还能手动挂载）
    expect(stored?.override).toBe('user-invocable-only');
    expect(stored?.enabled).toBe(true);
    expect(switchChecked(host, '用户级技能')).toBe(false);

    // 停用 ≠ 卸载：卡片仍留在「我安装的」里，用户能直接再打开它
    expect(cardOf(host, '用户级技能')).toBeTruthy();

    // 再点回来 = 打开自动触发 → 落到完全启用（停在触发不了的状态会像没生效）
    click(byAria('用户级技能 自动触发', host));
    await flush();
    expect(
      useSkillsStore.getState().skills.find((s) => s.id === 'user-skill')?.override,
    ).toBe('on');
    expect(switchChecked(host, '用户级技能')).toBe(true);
    unmount();
  });

  it('菜单里选「停用」是独立的一档：开关仍为「关」，卡片留在列表里', async () => {
    const host = await mountInstalled();
    await setOverrideViaMenu(host, '用户级技能', '停用');

    const stored = useSkillsStore.getState().skills.find((s) => s.id === 'user-skill');
    expect(stored?.override).toBe('off');
    expect(stored?.enabled).toBe(false);
    // 中间档与停用在开关上长得一样（都是「关」），区分它们的只有菜单对勾与卡片的表现
    expect(switchChecked(host, '用户级技能')).toBe(false);
    expect(cardOf(host, '用户级技能')).toBeTruthy();

    // 从停用点开关 = 「打开自动触发」→ 直接回到完全启用
    click(byAria('用户级技能 自动触发', host));
    await flush();
    expect(
      useSkillsStore.getState().skills.find((s) => s.id === 'user-skill')?.override,
    ).toBe('on');
    unmount();
  });

  it('停用后该技能回到市场视图，可再次安装', async () => {
    const host = await mountInstalled();
    await setOverrideViaMenu(host, '用户级技能', '停用');

    // 返回按钮是图标按钮（无文字），只能按 aria-label 找。
    click(byAria('返回全部技能', host));
    await flush();
    expect(byAria('安装 用户级技能', host), '停用后的技能未回到可安装列表').toBeTruthy();

    // 安装有一段可见的反馈时长，真实等待它走完（不引 fake timers，
    // 否则 MUI 过渡与 zustand 的异步推送会被一起冻住）
    click(byAria('安装 用户级技能', host));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    await flush();
    expect(useSkillsStore.getState().skills.find((s) => s.id === 'user-skill')?.enabled).toBe(true);
    unmount();
  });

  it('批量管理可以一次停用选中的技能', async () => {
    const host = await mountInstalled();
    click(buttonByText(host, '批量管理'));
    await flush();

    click(byAria('选择 用户级技能', host));
    await flush();
    expect(host.textContent).toContain('已选 1 项');

    click(buttonByText(host, '停用所选'));
    await flush();
    expect(useSkillsStore.getState().skills.find((s) => s.id === 'user-skill')?.override).toBe('off');
    unmount();
  });
});

describe('技能页：引擎同步失败必须可见', () => {
  it('同步失败时渲染告警，并说明本地状态已保存', async () => {
    // 不能让 store 直接带着 syncError 进来：进页面时的 refresh 会重推一次覆盖，
    // 成功的话会把错误清掉。所以这里模拟的是「推送真的失败」这条路径。
    vi.spyOn(platform, 'syncNanobotSkills').mockResolvedValue({
      ok: false,
      message: '写入失败：磁盘只读',
    });
    const host = mountPage();
    await flush();
    expect(host.textContent).toContain('技能生效方式未能同步到引擎');
    expect(host.textContent).toContain('写入失败：磁盘只读');
    expect(host.textContent).toContain('已保存在本地');
    unmount();
  });

  it('无错误时不渲染告警', async () => {
    const host = mountPage();
    await flush();
    expect(host.textContent).not.toContain('未能同步到引擎');
    unmount();
  });
});

/**
 * 「⋯」菜单的对齐方向是**几何约束**，不是审美偏好，改错在哪边都会出事：
 * 卡片左对齐会让最后一列的菜单冲出视口，窗口右对齐会把菜单甩到窗口左缘。
 * jsdom 量不到 Popper 的实际坐标，所以把判据抽成纯函数在此守死 ——
 * 真实像素位置由 `tasks/skill/preview/19/21` 那两张 Playwright 实测截图对照。
 */
describe('技能「⋯」菜单的对齐方向', () => {
  it('卡片上右对齐 —— ⋯ 贴卡片右缘，菜单必须向左展开才留在卡片内', () => {
    const { anchorOrigin, transformOrigin } = skillMenuOrigin('card');
    expect(anchorOrigin.horizontal).toBe('right');
    expect(transformOrigin.horizontal).toBe('right');
  });

  it('窗口里左对齐 —— ⋯ 距窗口右缘还有 300 多 px，右对齐会把菜单甩到窗口左边缘', () => {
    const { anchorOrigin, transformOrigin } = skillMenuOrigin('window');
    expect(anchorOrigin.horizontal).toBe('left');
    expect(transformOrigin.horizontal).toBe('left');
  });

  it('两个入口都从按钮下沿往下展开', () => {
    for (const ctx of ['card', 'window'] as const) {
      const { anchorOrigin, transformOrigin } = skillMenuOrigin(ctx);
      expect(anchorOrigin.vertical).toBe('bottom');
      expect(transformOrigin.vertical).toBe('top');
    }
  });
});

describe('技能页：置顶（列表顺序，与三态无关）', () => {
  it('点置顶把卡片挪到最前，且不动 override', async () => {
    const host = await mountInstalled();
    const before = installedOrder(host);
    expect(before.length).toBeGreaterThan(1);
    expect(before[0], '前置条件：被测技能一开始不在第一位').not.toContain('用户级技能');

    click(byAria('用户级技能 置顶', host));
    await flush();

    expect(installedOrder(host)[0]).toContain('用户级技能');
    expect(useSkillsStore.getState().pinnedIds).toContain('user-skill');
    // 反向护栏：置顶只改顺序，绝不能顺手改掉覆盖档（那会被推给引擎）
    expect(
      useSkillsStore.getState().skills.find((s) => s.id === 'user-skill')?.override,
    ).toBe('on');
    // 置顶项之外的原顺序保持不变（稳定排序，而不是随机重排）
    expect(installedOrder(host).slice(1)).toEqual(before.filter((n) => n !== '用户级技能'));

    // 再点一次是取消：回到原顺序
    click(byAria('用户级技能 置顶', host));
    await flush();
    expect(useSkillsStore.getState().pinnedIds).not.toContain('user-skill');
    expect(installedOrder(host)).toEqual(before);
    unmount();
  });

  it('置顶只留在本地，不会推给引擎', async () => {
    const host = await mountInstalled();
    // 置顶是「这份列表怎么排」，引擎侧没有对应语义：推过去只会污染覆盖表
    const callsBefore = vi.mocked(platform.syncNanobotSkills).mock.calls.length;
    click(byAria('用户级技能 置顶', host));
    await flush();
    expect(vi.mocked(platform.syncNanobotSkills).mock.calls.length).toBe(callsBefore);
    unmount();
  });

  it('按钮反映当前置顶态（aria-pressed），置顶项不受停用影响', async () => {
    const host = await mountInstalled();
    expect(byAria('用户级技能 置顶', host)?.getAttribute('aria-pressed')).toBe('false');

    click(byAria('用户级技能 置顶', host));
    await flush();
    expect(byAria('用户级技能 置顶', host)?.getAttribute('aria-pressed')).toBe('true');

    // 停用后置顶仍在：两件事互不相干（停用只是压暗卡片，不改排序偏好）
    await setOverrideViaMenu(host, '用户级技能', '停用');
    expect(useSkillsStore.getState().pinnedIds).toContain('user-skill');
    expect(installedOrder(host)[0]).toContain('用户级技能');
    unmount();
  });
});

describe('技能页：自动触发开关的悬停说明', () => {
  it('悬停开关给的是「关掉之后会怎样」，不是复述按钮名', async () => {
    const host = await mountInstalled();
    const sw = byAria('用户级技能 自动触发', host);
    expect(sw, '未找到自动触发开关').toBeTruthy();

    act(() => {
      sw!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    // MUI 的进入延迟 100ms + Grow 过渡，等足够长再断言
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    // MUI 的 Tooltip 不带 role，唯一的标识是它的类名
    const tip = document.querySelector('.MuiTooltip-tooltip');
    expect(tip, '悬停开关后没有出现提示气泡').toBeTruthy();
    expect(tip!.textContent).toContain('关闭自动触发后');
    expect(tip!.textContent).toContain('仅支持手动触发');
    unmount();
  });

  it('开关关着时给的是「打开之后会怎样」——两个方向都必须有话说', () => {
    // 只写一句话的实现会让「已经关着」（中间档或停用）的技能没有任何解释，
    // 用户不敢往回开
    const on = autoTriggerHint({ override: 'on' } as Skill);
    const mid = autoTriggerHint({ override: 'user-invocable-only' } as Skill);
    const off = autoTriggerHint({ override: 'off' } as Skill);
    expect(on).toContain('关闭自动触发后');
    expect(mid).toContain('开启自动触发后');
    expect(off).toContain('开启自动触发后');
    expect(on).not.toBe(mid);
  });
});

/**
 * 开关只有两个位置，字段有三档 —— 这个映射是纯逻辑，jsdom 量不到、也不依赖布局，
 * 所以在这里把契约钉死。文案与映射**必须成对**：气泡承诺「关掉后仅支持手动触发」，
 * 落点就必须是中间档，落进 `off`（连挂载都挂不上）等于欺骗用户。
 */
describe('技能页：开关位置 ⇄ 三档的映射契约', () => {
  const mk = (override: Skill['override']): Skill => ({ id: 'x', name: 'x', override } as Skill);

  it('开 = 模型可见（完全启用），不是「非停用」', () => {
    expect(isAutoTriggerOn(mk('on'))).toBe(true);
    expect(isAutoTriggerOn(mk('user-invocable-only'))).toBe(false);
    expect(isAutoTriggerOn(mk('off'))).toBe(false);
  });

  it('关掉开关落到中间档；从中间档或停用打开都落到完全启用', () => {
    expect(nextAutoTriggerOverride(mk('on'))).toBe('user-invocable-only');
    expect(nextAutoTriggerOverride(mk('user-invocable-only'))).toBe('on');
    expect(nextAutoTriggerOverride(mk('off'))).toBe('on');
  });

  it('反馈文案按落点说话：三档各一句，且互不相同', () => {
    const [on, mid, off] = (['on', 'user-invocable-only', 'off'] as const).map((v) =>
      overrideToast('技能', v),
    );
    expect(new Set([on, mid, off]).size).toBe(3);
    expect(on).toContain('已开启');
    // 关掉自动触发 ≠ 停用：文案必须点名「还能手动调用」，否则用户不敢关
    expect(mid).toContain('仅支持手动调用');
    expect(off).toContain('停用');
  });
});

describe('技能页：置顶排序的纯函数契约', () => {
  const mk = (id: string): Skill => ({ id, name: id } as Skill);

  it('置顶项提到最前，其余保持原序', () => {
    const list = [mk('a'), mk('b'), mk('c')];
    expect(orderInstalledSkills(list, ['c']).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(orderInstalledSkills(list, ['b', 'c']).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('不改动入参数组（sort 是原地排序）', () => {
    const list = [mk('a'), mk('b')];
    orderInstalledSkills(list, ['b']);
    // store 里的数组被就地翻面是「界面看着对了、别处悄悄出错」的典型
    expect(list.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('没有置顶项时原样返回', () => {
    const list = [mk('a'), mk('b')];
    expect(orderInstalledSkills(list, []).map((s) => s.id)).toEqual(['a', 'b']);
  });
});
