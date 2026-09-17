/**
 * 技能页的字段展示与三态控制（FR-3.1）。
 *
 * 这个页面的价值全在「展示的是真实字段」上：来源层级、工具白名单、
 * user-invocable 三项都来自 SKILL.md 解析结果或扫描结果，
 * 一旦渲染时写死或猜值，用户就会按错的信息做决策。
 *
 * ## 两条容易踩的坑
 *
 * 1. **详情弹窗走 Portal**（渲染到 `document.body`），不在挂载容器里，
 *    查询弹窗内容必须用 `dialogRoot()`。
 * 2. **卡片里的「⋯」菜单用了 `useNavigate`**，所以页面必须在 Router 上下文里挂载。
 *    生产环境由 `router/index.tsx` 提供，测试里用 `MemoryRouter` 补上。
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
import { byAria, buttonByText, click, dialogRoot, flush, mount, unmount } from './helpers/reactMount';
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

/** 点开某张卡的详情弹窗，返回弹窗根节点（Portal，不在 host 内） */
async function openDetail(host: HTMLElement, name: string): Promise<HTMLElement> {
  click(cardOf(host, name));
  await flush();
  return dialogRoot();
}

describe('技能页：真实字段展示（详情弹窗）', () => {
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

  it('allowed-tools 以完整清单展示在基本信息里', async () => {
    const host = await mountInstalled();
    const dialog = await openDetail(host, '用户级技能');
    expect(dialog.textContent).toContain('工具白名单');
    expect(dialog.textContent).toContain('Read、Write、Bash');
    unmount();
  });

  it('user-invocable:false 明确标出「不可手动调用」', async () => {
    const host = await mountInstalled();
    const dialog = await openDetail(host, '项目级技能');
    expect(dialog.textContent).toContain('不可手动调用');
    unmount();

    // 反向护栏：没声明 false 的技能不该被打上这个标记
    const host2 = await mountInstalled();
    const dialog2 = await openDetail(host2, '用户级技能');
    expect(dialog2.textContent).not.toContain('不可手动调用');
    unmount();
  });

  it('未声明 allowed-tools 时不显示工具白名单', async () => {
    const host = await mountInstalled();
    const dialog = await openDetail(host, '项目级技能');
    expect(dialog.textContent).not.toContain('工具白名单');
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
