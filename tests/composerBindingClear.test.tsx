/**
 * 输入区「当前绑定」chip 的解除能力（专家 / 专家团）。
 *
 * ## 为什么要有这组用例
 *
 * 「新建任务 = 白纸」落地后，绑定只能由用户**当场挂上**（`+` 菜单 / `/` 指令）。
 * 那就必须有一条对称的退路——否则挂错了只能删掉整个会话重来。
 * 这条退路就是 chip 上的 ×（`Chip.onDelete`）——鼠标悬停在名字上就会出现，
 * 平时那里站着的是专家头像。
 *
 * ## 两处「不能顺手做掉」的边界
 *
 * 1. **有会话时只改会话**：全局活跃专家是「空态 chip / 懒建会话」的默认值，
 *    属于用户偏好。清掉手里这一个绑定，不该把偏好也洗了。
 * 2. **空态（还没有会话）时清的就是全局默认值**：那时 chip 显示的就是它本身，
 *    没有会话可清。两种落点不同，但「点 × = 眼前这枚 chip 消失」是同一条心智。
 *
 * 第一组断言落在 **store 字段**上（`agentId` / `groupId` / `activeAgentId`），
 * 样式会变、语义不会。第二组是**形态契约**（× 前置 / 胶囊 / 内边距），
 * 只钉三处会**静默坏掉**的地方，不逐像素比。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { Composer } from '@/pages/chat/Composer';
import { muiTheme } from '@/theme/muiTheme';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import {
  useSettingsStore,
  DEFAULT_TRANSCRIPTION,
  DEFAULT_DESKTOP,
} from '@/stores/settingsStore';
import { resetEventStream } from './helpers/eventStream';
import { click, mount, unmount } from './helpers/reactMount';

const AGENT_ID = 'agent-test';
const AGENT_NAME = '测试智能体';

beforeEach(() => {
  vi.restoreAllMocks();
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      processDetail: 'key',
      memoryEnabled: false,
      autoSummarize: false,
      transcription: DEFAULT_TRANSCRIPTION,
      desktop: DEFAULT_DESKTOP,
    },
    status: 'offline',
  });
  useSessionsStore.setState({
    sessions: [],
    activeId: null,
    streams: {},
    pendingApprovals: [],
    error: null,
  });
  resetEventStream();
  useAgentsStore.setState({
    agents: [
      {
        id: AGENT_ID,
        name: AGENT_NAME,
        systemPrompt: '你是测试助手',
        skillIds: [],
        imBinding: null,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ],
    activeAgentId: AGENT_ID,
  });
});

afterEach(() => unmount());

/**
 * 挂载输入区。
 *
 * `ComposerMenu`（加号菜单）用了 `useNavigate`，所以必须在 Router 上下文里挂；
 * 主题也一并补上——生产环境由 `router/index.tsx` + `App` 提供，测试里用
 * `MemoryRouter` + **真实主题**补。用真实主题而不是临时造一个，是因为下面那组
 * 形态契约要验证的正是「盖过主题里的 `MuiChip.root.borderRadius`」。
 */
function mountComposer(): HTMLElement {
  return mount(
    <ThemeProvider theme={muiTheme}>
      <MemoryRouter>
        <Composer />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/**
 * 按文案定位「当前绑定」chip。
 *
 * 技能 chip 也带 ×，按名字找才不会把两者混在一起——这正是断言要防的：
 * 「点了 ×」必须作用在专家上，不是碰巧命中了旁边某个技能。
 */
function bindingChip(host: HTMLElement, name: string): HTMLElement | null {
  return (
    Array.from(host.querySelectorAll<HTMLElement>('.MuiChip-root')).find((c) =>
      (c.textContent ?? '').includes(name),
    ) ?? null
  );
}

/** 点掉 chip 上的 ×（MUI 把 onDelete 挂在删除图标上，并已 stopPropagation） */
function clickClear(host: HTMLElement, name: string): void {
  const chip = bindingChip(host, name);
  expect(chip).toBeTruthy();
  click(chip!.querySelector('.MuiChip-deleteIcon'));
}

describe('输入区：当前绑定 chip 可解除（点 ×）', () => {
  it('有会话时点 × 清掉会话绑定，chip 随之消失', () => {
    const session = useSessionsStore
      .getState()
      .createSession(AGENT_ID, '已绑定会话');

    const host = mountComposer();
    expect(bindingChip(host, AGENT_NAME)).toBeTruthy();

    clickClear(host, AGENT_NAME);

    const after = useSessionsStore
      .getState()
      .sessions.find((s) => s.id === session.id);
    expect(after?.agentId).toBe('');
    expect(after?.groupId).toBeNull();
    expect(bindingChip(host, AGENT_NAME)).toBeNull();
  });

  it('清会话绑定时不动全局默认专家（那是另一件事）', () => {
    useSessionsStore.getState().createSession(AGENT_ID, '已绑定会话');

    const host = mountComposer();
    clickClear(host, AGENT_NAME);

    expect(useAgentsStore.getState().activeAgentId).toBe(AGENT_ID);
    // 但视图上确实没 chip 了：有效专家以会话绑定为准，不回退全局
    expect(bindingChip(host, AGENT_NAME)).toBeNull();
  });

  it('未绑定的会话不渲染 chip（白纸态）', () => {
    useSessionsStore
      .getState()
      .createSession(undefined, '白纸会话', { inheritCapabilities: false });

    const host = mountComposer();

    expect(bindingChip(host, AGENT_NAME)).toBeNull();
    expect(host.querySelectorAll('.MuiChip-deleteIcon')).toHaveLength(0);
  });

  it('清空后还能重新挂上（× 不是单向门）', () => {
    const session = useSessionsStore
      .getState()
      .createSession(AGENT_ID, '已绑定会话');
    const host = mountComposer();

    clickClear(host, AGENT_NAME);
    expect(bindingChip(host, AGENT_NAME)).toBeNull();

    // 与 `+` 菜单选专家走的是同一条写路径（handleAgentChange → updateSession）
    act(() => {
      useSessionsStore.getState().updateSession(session.id, (s) => ({
        ...s,
        agentId: AGENT_ID,
      }));
    });

    expect(bindingChip(host, AGENT_NAME)).toBeTruthy();
  });

  it('空态（还没有会话）时 × 清的是全局默认值', () => {
    expect(useSessionsStore.getState().activeId).toBeNull();

    const host = mountComposer();
    expect(bindingChip(host, AGENT_NAME)).toBeTruthy();

    clickClear(host, AGENT_NAME);

    expect(useAgentsStore.getState().activeAgentId).toBeNull();
    expect(bindingChip(host, AGENT_NAME)).toBeNull();
  });
});

/**
 * 形态契约：只钉几处**会静默坏掉**的地方，不逐像素比。
 *
 * 它们各自有明确的失败机制，而且上面那组功能用例**全绿**——
 * 这正是需要在样式层单独守一遍的原因：
 *
 * 1. **前导图标永远在场**：chip 默认显示专家头像，没配头像时回退类型图标。
 *    这一条真的坏过一次——为了做「× 前置」把图标整个删掉了，
 *    结果 chip 变成光秃秃的「× 名字」，用户一眼看出不对。
 * 2. **× 默认藏着**：它只在悬停时顶替头像。要是忘了 `display: none`，
 *    头像和 × 会并排挤在前导位，chip 直接变形。
 * 3. **两种形态同槽同尺寸**：icon 与 deleteIcon 的 order / 尺寸 / 外边距必须一致，
 *    否则悬停互换时 chip 会跳一下。
 * 4. **数值必须带单位**：`sx` 会把裸数字"解释"一遍——`padding*` 上的数字是 spacing 倍数
 *    （`paddingRight: 12` → 96px），`borderRadius` 上的数字要乘
 *    `theme.shape.borderRadius`（本项目 10，`999` → 9990px）。两个都不报错，只是悄悄变样。
 * 5. **胶囊形要盖过主题**：`MuiChip.root` 在主题里是 `borderRadius: 6`，
 *    这里不赢就又缩回小圆角矩形。
 *
 * jsdom 对 `border-radius` 的计算值给的是展开后的怪数，所以第 5 条不断言具体数值，
 * 只断言「至少和自身高度一样圆」——6px 那种小圆角必然过不去。
 */
describe('当前绑定 chip 的形态契约', () => {
  const cs = (el: Element) => window.getComputedStyle(el);

  /** 取 chip 的前导图标槽（MUI 会把 icon / deleteIcon 分别挂上对应 class）。 */
  const iconOf = (chip: HTMLElement) =>
    chip.querySelector<HTMLElement>('.MuiChip-icon');
  const delOf = (chip: HTMLElement) =>
    chip.querySelector<HTMLElement>('.MuiChip-deleteIcon');

  it('默认显示前导图标，且 × 藏着', () => {
    useSessionsStore.getState().createSession(AGENT_ID, '已绑定会话');
    const host = mountComposer();

    const chip = bindingChip(host, AGENT_NAME)!;
    const icon = iconOf(chip);
    const del = delOf(chip);
    const label = chip.querySelector<HTMLElement>('.MuiChip-label')!;

    // 1) 前导图标在场（这个专家没配头像 → 回退机器人图标，仍是「有图标」）。
    //    注意图标元素**自身**就是那个 <svg>，不是它的子节点。
    expect(icon).toBeTruthy();
    expect(icon!.tagName.toLowerCase()).toBe('svg');
    // 2) × 默认不可见——它只在悬停时顶替头像
    expect(cs(del!).display).toBe('none');
    // 3) 两种形态共用前导位：order 与尺寸对齐，切换时不跳
    expect(cs(icon!).order).toBe('-1');
    expect(cs(del!).order).toBe('-1');
    expect(cs(icon!).width).toBe('18px');
    expect(cs(del!).width).toBe('18px');
    expect(cs(icon!).marginLeft).toBe(cs(del!).marginLeft);
    expect(cs(icon!).marginRight).toBe(cs(del!).marginRight);
    // 4) 数值没被 MUI 二次解释
    expect(cs(label).paddingLeft).toBe('0px');
    expect(cs(label).paddingRight).toBe('12px');
    expect(cs(del!).marginLeft).toBe('8px');
    // 5) 胶囊形：圆角至少不输给自身高度
    expect(parseFloat(cs(chip).borderRadius)).toBeGreaterThanOrEqual(
      parseFloat(cs(chip).height),
    );
  });

  it('专家配了 emoji 头像就用头像，不退回类型图标', () => {
    useAgentsStore.setState({
      agents: [
        {
          id: AGENT_ID,
          name: AGENT_NAME,
          systemPrompt: '你是测试助手',
          avatar: '🧑‍💻',
          skillIds: [],
          imBinding: null,
          enabled: true,
          createdAt: new Date().toISOString(),
        },
      ],
      activeAgentId: AGENT_ID,
    });
    useSessionsStore.getState().createSession(AGENT_ID, '已绑定会话');

    const host = mountComposer();
    const chip = bindingChip(host, AGENT_NAME)!;

    expect(iconOf(chip)!.textContent).toContain('🧑‍💻');
    expect(iconOf(chip)!.querySelector('svg')).toBeNull();
  });

  it('专家头像写成图片地址时渲染真图片（不是姓名首字）', () => {
    useAgentsStore.setState({
      agents: [
        {
          id: AGENT_ID,
          name: AGENT_NAME,
          systemPrompt: '你是测试助手',
          avatar: 'https://example.com/avatar.png',
          skillIds: [],
          imBinding: null,
          enabled: true,
          createdAt: new Date().toISOString(),
        },
      ],
      activeAgentId: AGENT_ID,
    });
    useSessionsStore.getState().createSession(AGENT_ID, '已绑定会话');

    const host = mountComposer();
    const chip = bindingChip(host, AGENT_NAME)!;

    const img = iconOf(chip)!.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe('https://example.com/avatar.png');
  });
});
