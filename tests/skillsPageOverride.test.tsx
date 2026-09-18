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
 *
 * ## 关于「三态」的控件形态
 *
 * 界面从「一个下拉框」改成了**开关 + 一个图标按钮**：开关管「能不能用」
 * （`off` ↔ 非 `off`），图标按钮管「模型看不看得见」（`on` ↔ `user-invocable-only`）。
 * 测试也跟着走这两个真实控件的 aria-label，而不是内部的 Select 结构。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SkillsPage } from '@/pages/skills/SkillsPage';
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
  useSkillsStore.setState({ skills: [], loaded: false, syncError: null });
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
    // 字段列表正是这次要根除的问题。市场卡只在技能未启用时出现，先停用它。
    click(byAria('用户级技能 自动触发', host));
    await flush();
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
  it('详情页的开关与卡片上的开关是同一个（写入同一份 override）', async () => {
    const host = await mountInstalled();
    const panel = await openDetail(host, '用户级技能');

    // 同一个 aria-label：两个入口是同一个开关，不是两套状态
    click(byAria('用户级技能 自动触发', panel));
    await flush();

    const stored = useSkillsStore.getState().skills.find((s) => s.id === 'user-skill');
    expect(stored?.override).toBe('off');
    expect(stored?.enabled).toBe(false);
    // 停用后窗口留在原地（不是被关掉），开关自己变灰 —— 用户能原地再打开
    expect(detailWindowOpen()).toBe(true);
    unmount();
  });

  it('停用时「去试试」禁用 —— 挂载后不会被注入，点了等于没反应', async () => {
    const host = await mountInstalled();
    click(byAria('用户级技能 自动触发', host));
    await flush();

    const panel = await openDetail(host, '用户级技能');
    expect(buttonByText(panel, '去试试')?.disabled).toBe(true);
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
    click(byAria('用户级技能 自动触发', host));
    await flush();
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
  it('「仅手动调用」按钮写入中间档，并保持 enabled 的派生关系', async () => {
    const host = await mountInstalled();

    // 中间档（模型不可见、用户可挂载）用开关表达不出来，
    // 必须有一个能写文案的独立入口，这里就是那个按钮。
    const btn = byAria('用户级技能 仅手动调用', host);
    expect(btn, '未找到「仅手动调用」按钮').toBeTruthy();
    expect(btn!.getAttribute('aria-pressed')).toBe('false');

    click(btn);
    await flush();

    const stored = useSkillsStore.getState().skills.find((s) => s.id === 'user-skill');
    expect(stored?.override).toBe('user-invocable-only');
    // 中间档不是「停用」：用户照样能挂载，只是模型看不见
    expect(stored?.enabled).toBe(true);
    unmount();
  });

  it('自动触发开关切到 off，卡片留在列表里（原地可再启用）', async () => {
    const host = await mountInstalled();

    // 开关的 aria-label 落在真正的 checkbox input 上：点它才会走 MUI 的 onChange，
    // 点外层 span 只是视觉反馈，状态不会变（看起来像「点了没反应」）。
    const sw = byAria('用户级技能 自动触发', host);
    expect(sw, '未找到自动触发开关').toBeTruthy();
    click(sw);
    await flush();

    const stored = useSkillsStore.getState().skills.find((s) => s.id === 'user-skill');
    expect(stored?.override).toBe('off');
    expect(stored?.enabled).toBe(false);

    // 停用 ≠ 卸载：卡片仍留在「我安装的」里，用户能直接再打开它
    expect(cardOf(host, '用户级技能')).toBeTruthy();
    unmount();
  });

  it('停用后该技能回到市场视图，可再次安装', async () => {
    const host = await mountInstalled();
    click(byAria('用户级技能 自动触发', host));
    await flush();

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
