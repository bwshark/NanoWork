/**
 * 技能页三态控制与来源展示（FR-3.1）。
 *
 * 这个页面的价值全在「展示的是真实字段」上：来源层级、工具白名单、
 * user-invocable 三项都来自 SKILL.md 解析结果或扫描结果，
 * 一旦渲染时写死或猜值，用户就会按错的信息做决策。
 *
 * 交互部分刻意走真实的 MUI Select：非原生 Select 是 div + 通过 Portal 弹出的
 * Menu，必须用 `mousedown` 才能展开（点 click 不会触发 setOpen），
 * 展开后选项是 `li[data-value]`。这是这里唯一需要留意的细节。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { SkillsPage } from '@/pages/skills/SkillsPage';
import { useSkillsStore } from '@/stores/skillsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { platform } from '@/platform';
import { byAria, buttonByText, click, flush, mount, unmount } from './helpers/reactMount';
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
 * 默认的「全部技能」视图只列**未安装**（`off`）的技能 —— 这是既有的市场语义
 * （已安装的只出现在「我安装的」，避免同一技能两个入口并存）。
 * 因此要检查已启用技能的卡片，必须先切视图。
 */
async function mountInstalled(): Promise<HTMLDivElement> {
  const host = mount(<SkillsPage />);
  await flush();
  click(buttonByText(host, '我安装的'));
  await flush();
  return host;
}

describe('技能页：来源层级与真实字段展示', () => {
  it('本地技能带出来源层级徽标', async () => {
    const host = await mountInstalled();
    expect(host.textContent).toContain('用户级');
    expect(host.textContent).toContain('项目级');
    unmount();
  });

  it('allowed-tools 以数量徽标展示，标题给出完整清单', async () => {
    const host = await mountInstalled();
    const card = cardOf(host, '用户级技能');
    expect(card.textContent).toContain('3 个工具');
    const chip = card.querySelector('[aria-label="工具白名单：Read、Write、Bash"]');
    expect(chip).toBeTruthy();
    unmount();
  });

  it('user-invocable:false 明确标出「不可手动调用」', async () => {
    const host = await mountInstalled();
    expect(cardOf(host, '项目级技能').textContent).toContain('不可手动调用');
    // 反向护栏：没声明 false 的技能不该被打上这个标记
    expect(cardOf(host, '用户级技能').textContent).not.toContain('不可手动调用');
    unmount();
  });

  it('未声明 allowed-tools 时不显示工具徽标', async () => {
    const host = await mountInstalled();
    expect(cardOf(host, '项目级技能').textContent).not.toContain('个工具');
    unmount();
  });
});

describe('技能页：三态控制', () => {
  it('切换档位后写入 store，并保持 enabled 的派生关系', async () => {
    const host = await mountInstalled();

    // 三态控件的可访问名带技能名，避免多张卡片之间撞车。
    // 注意 aria-label 落在 Select 的**外层** InputBase 上，真正带
    // onMouseDown 的是里面那个 role="combobox" 的 div —— 必须往下钻一层，
    // 否则在错误的元素上派发事件，菜单永远不展开（看起来像功能坏了）。
    const root = byAria('用户级技能 生效方式', host);
    expect(root).toBeTruthy();
    expect(root!.textContent).toContain('启用');
    const control = root!.querySelector('[role="combobox"]');
    expect(control, '未找到 Select 的 combobox 触发器').toBeTruthy();

    act(() => {
      control!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await flush();

    const option = document.querySelector('li[data-value="user-invocable-only"]');
    expect(option, '三态选项未渲染出来').toBeTruthy();
    act(() => {
      (option as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const stored = useSkillsStore.getState().skills.find((s) => s.id === 'user-skill');
    expect(stored?.override).toBe('user-invocable-only');
    // 中间档不是「停用」：用户照样能挂载，只是模型看不见
    expect(stored?.enabled).toBe(true);
    unmount();
  });

  it('停用后该技能不再算「已安装」（回到市场视图可重新安装）', async () => {
    const host = await mountInstalled();
    useSkillsStore.getState().setSkillOverride('user-skill', 'off');
    await flush();
    expect(useSkillsStore.getState().skills.find((s) => s.id === 'user-skill')?.enabled).toBe(false);
    // 切回市场视图：停用过的技能应当重新出现在可安装列表里。
    // 返回按钮是图标按钮（无文字），只能按 aria-label 找。
    click(byAria('返回全部技能', host));
    await flush();
    expect(host.textContent).toContain('用户级技能');
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
    const host = mount(<SkillsPage />);
    await flush();
    expect(host.textContent).toContain('技能生效方式未能同步到引擎');
    expect(host.textContent).toContain('写入失败：磁盘只读');
    expect(host.textContent).toContain('已保存在本地');
    unmount();
  });

  it('无错误时不渲染告警', async () => {
    const host = mount(<SkillsPage />);
    await flush();
    expect(host.textContent).not.toContain('未能同步到引擎');
    unmount();
  });
});
