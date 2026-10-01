/**
 * 模型选择器的文案契约：**Auto 行与任何预设行不能长得一样**。
 *
 * ## 为什么要有这组用例
 *
 * 2026-09-21 的真实事故：配置里 `agents.defaults.model` 被填成了 provider 名
 * `sciherd`，于是下拉里出现两行都写着 `sciherd`——第一行是 Auto（隐式 default 预设），
 * 最后一行是**同名的预设** `sciherd`。选后者能正常对话，停在 Auto 就报
 * `The model sciherd does not exist`（404），而屏幕上根本看不出这两行差在哪。
 *
 * 根因在配置（预设名被当成了模型名），但这套 UI 也必须能自证，因为两条链本就不同源：
 * - **Auto 不是一个模型 id**：请求里不带 `model` 字段，实际生效的是隐式 default 预设，
 *   所以文案要写 `Auto · <真实模型名>`；
 * - **预设名 ≠ 模型名**：预设 `sciherd` 的底层模型是 `Qwen3.8-Flash`，两者同名纯属巧合，
 *   所以预设行要把两个名字都露出来（`sciherd · Qwen3.8-Flash`）。
 *
 * 这里钉的是**判据**（两行不同字 / 模型名取自 `model` 字段 / 点下去写的是 id），
 * 不是像素也不是文案格式——后续只是换个词，用例不该红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { Composer } from '@/pages/chat/Composer';
import { muiTheme } from '@/theme/muiTheme';
import { useAgentsStore } from '@/stores/agentsStore';
import { useModelsStore } from '@/stores/modelsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import {
  useSettingsStore,
  DEFAULT_TRANSCRIPTION,
  DEFAULT_DESKTOP,
} from '@/stores/settingsStore';
import { resetEventStream } from './helpers/eventStream';
import { click, flush, mount, unmount } from './helpers/reactMount';
import type { ModelInfo } from '@/types';

beforeEach(() => {
  vi.restoreAllMocks();
  unmount();
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
  useAgentsStore.setState({ agents: [], activeAgentId: null });
  resetEventStream();
  // 目录一律由用例自己种；把 refresh 换成空实现，别让「点 chip」真去打网关
  useModelsStore.setState({ models: [], refresh: () => Promise.resolve() });
});

afterEach(() => unmount());

/** 挂载输入区（Composer 里的加号菜单用了 useNavigate，必须有 Router 上下文） */
function mountComposer(): HTMLElement {
  return mount(
    <ThemeProvider theme={muiTheme}>
      <MemoryRouter>
        <Composer />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** 模型 chip：工具条上唯一一枚以「Auto / 模型名」开头的 chip */
function modelChip(host: HTMLElement): HTMLElement {
  const chip = Array.from(host.querySelectorAll<HTMLElement>('.MuiChip-root')).find((c) =>
    /^(Auto|sciherd|qwen)/i.test((c.textContent ?? '').trim()),
  );
  expect(chip, '未找到模型 chip').toBeTruthy();
  return chip!;
}

/** 已打开菜单里的行文案（MUI Menu 走 Portal，不在挂载容器里） */
function menuRows(): string[] {
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map((n) =>
    (n.textContent ?? '').trim(),
  );
}

/** 点 chip 展开模型菜单 */
async function openMenu(host: HTMLElement): Promise<string[]> {
  click(modelChip(host));
  await flush();
  return menuRows();
}

/** 事故当天的目录：Auto（default 预设）的模型名恰好等于某个预设名 */
const BROKEN_CONFIG_CATALOG: ModelInfo[] = [
  { id: 'default', label: 'sciherd', model: 'sciherd' },
  { id: 'sciherd', label: 'sciherd', model: 'Qwen3.8-Flash' },
];

/** 修好之后的目录：default 指向真实模型名 */
const FIXED_CONFIG_CATALOG: ModelInfo[] = [
  { id: 'default', label: 'Qwen3.8-Flash', model: 'Qwen3.8-Flash' },
  { id: 'sciherd', label: 'sciherd', model: 'Qwen3.8-Flash' },
];

describe('模型选择器的文案', () => {
  it('Auto 态下 chip 与预设行不能同字（事故当天两点都是「sciherd」）', async () => {
    useModelsStore.setState({ models: BROKEN_CONFIG_CATALOG });
    const host = mountComposer();
    const chipText = (modelChip(host).textContent ?? '').trim();
    const rows = await openMenu(host);

    expect(rows).toHaveLength(2);
    // Auto 不是一个模型 id：它必须自报家门，而不是直接顶一个看起来像预设名的名字
    expect(rows[0]).toContain('Auto');
    expect(rows[0]).not.toBe(rows[1]);
    // 预设行必须自证「预设名 × 真实模型名」——只写 `sciherd` 的话，
    // 用户无从知道它到底把哪个模型发给上游
    expect(rows[1]).toContain('sciherd');
    expect(rows[1]).toContain('Qwen3.8-Flash');
    // 这条就是事故当天的现场：chip 写「sciherd」，预设行也写「sciherd」
    expect(chipText).not.toBe(rows[1]);
  });

  it('Auto 行标注的是真实模型名（取 model 字段），不是预设名', async () => {
    useModelsStore.setState({ models: FIXED_CONFIG_CATALOG });
    const host = mountComposer();
    const rows = await openMenu(host);

    expect(rows[0]).toContain('Auto');
    expect(rows[0]).toContain('Qwen3.8-Flash');
    expect(rows[0]).not.toBe(rows[1]);
  });

  it('chip 与菜单行同字（两处口径分叉会出现「chip 说 A、菜单说 B」）', async () => {
    useModelsStore.setState({ models: FIXED_CONFIG_CATALOG });
    const host = mountComposer();

    const chip = modelChip(host);
    const before = (chip.textContent ?? '').trim();
    const rows = await openMenu(host);

    expect(before).toBe(rows[0]);
  });

  it('点预设行写进会话的是预设 id，不是那行展示文案', async () => {
    useModelsStore.setState({ models: FIXED_CONFIG_CATALOG });
    const session = useSessionsStore.getState().createSession(undefined, '选模型');
    const host = mountComposer();

    const rows = await openMenu(host);
    const presetRow = Array.from(document.querySelectorAll('[role="menuitem"]')).find((n) =>
      (n.textContent ?? '').trim() === rows[1],
    );
    click(presetRow);
    await flush();

    // 发给引擎的是预设名（引擎据此查 modelPresets），展示文案里那截模型名不能混进去
    const after = useSessionsStore.getState().sessions.find((s) => s.id === session.id);
    expect(after?.model).toBe('sciherd');
    expect((modelChip(host).textContent ?? '').trim()).toBe(rows[1]);
  });

  it('目录为空时退化为 Auto，不把 undefined 渲染出来', async () => {
    const host = mountComposer();

    expect((modelChip(host).textContent ?? '').trim()).toBe('Auto');
    const rows = await openMenu(host);
    expect(rows).toEqual(['Auto']);
  });
});
