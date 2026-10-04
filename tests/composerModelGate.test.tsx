/**
 * 模型能力协商在输入区的落地（FR-9.3）。
 *
 * 三件事只有「整条链走一遍」才验得到（单测各打一块，谁都没验接线）：
 *
 * 1. `useActiveModelCapabilities` 真的读到了当前会话的模型，并把能力传到了菜单；
 * 2. 不支持工具调用时「技能」入口**真的**禁用**且给出原因**——一个点不动也不说
 *    为什么的菜单项，用户只会以为应用坏了；
 * 3. 图片附件在模型未声明视觉能力时**提示而不阻止**——引擎 `supports_vision`
 *    默认是 false，一旦做成硬门禁，所有历史预设的贴图功能会被一起禁掉。
 *
 * 另有一条最要紧的回归：**查不到元数据时必须宽松**。Web 端 / 引擎离线 / 用户手填
 * 的模型名都会落到那一支；读成 false 等于给所有人白送一次「功能消失」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { Composer } from '@/pages/chat/Composer';
import { useToastStore } from '@/components/Toast';
import { muiTheme } from '@/theme/muiTheme';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useModelsStore, type ManagedModel } from '@/stores/modelsStore';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import { resetEventStream } from './helpers/eventStream';
import { click, flush, mount, unmount } from './helpers/reactMount';
import { DEFAULT_MEMORY_POLICY } from '@/types';

const AGENT_ID = 'agent-test';

/** 一份预设元数据（`supportsTools` / `supportsVision` 可指定） */
function preset(over: Partial<ManagedModel> & { name: string }): ManagedModel {
  return {
    model: over.name,
    provider: 'dashscope',
    providerKey: 'dashscope',
    providerLabel: 'DashScope',
    apiKey: '',
    apiBase: '',
    hasKey: false,
    isDefault: false,
    custom: false,
    contextWindowTokens: null,
    maxTokens: null,
    reasoningEffort: null,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    customProtocol: false,
    pricing: null,
    temperature: 0.1,
    ...over,
  };
}

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
      memoryRecall: true,
      memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
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
  useToastStore.setState({ items: [] });
  useAgentsStore.setState({
    agents: [
      {
        id: AGENT_ID,
        name: '测试智能体',
        systemPrompt: '你是测试助手',
        skillIds: [],
        imBinding: null,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ],
    activeAgentId: AGENT_ID,
  });
  useModelsStore.setState({ managed: [], managedAvailable: false, managedLoading: false });
});

afterEach(() => unmount());

function mountComposer(): HTMLElement {
  return mount(
    <ThemeProvider theme={muiTheme}>
      <MemoryRouter>
        <Composer />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** 建一个绑定了指定模型的活跃会话 */
function bindModel(model: string): void {
  const session = useSessionsStore.getState().createSession(AGENT_ID, '新会话');
  useSessionsStore.getState().setSessionModel(session.id, model);
}

/** 点开加号菜单（MUI 菜单渲染在 portal 里，断言要落在 document.body 上） */
function openMenu(host: HTMLElement): void {
  const icon = host.querySelector('[data-testid="AddIcon"]');
  expect(icon, '找不到加号菜单的触发器').toBeTruthy();
  click(icon!.closest('button'));
}

function menuItem(label: string): HTMLElement | null {
  return (
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) =>
      (el.textContent ?? '').includes(label),
    ) ?? null
  );
}

describe('技能入口的能力门控', () => {
  it('模型声明不支持工具调用 → 「技能」禁用并写出原因', async () => {
    useModelsStore.setState({
      managed: [preset({ name: 'local-chat', supportsTools: false })],
      managedAvailable: true,
    });
    bindModel('local-chat');

    const host = mountComposer();
    await flush();
    openMenu(host);
    await flush();

    const skills = menuItem('技能');
    expect(skills, '菜单里没有「技能」').toBeTruthy();
    expect(skills!.getAttribute('aria-disabled'), '不支持工具调用时技能入口必须禁用').toBe('true');
    // 禁用必须给原因：否则用户只会以为应用坏了
    expect(skills!.textContent).toContain('当前模型不支持工具调用');
  });

  it('模型支持工具调用 → 「技能」照常可用', async () => {
    useModelsStore.setState({
      managed: [preset({ name: 'qwen3.8-flash', supportsTools: true })],
      managedAvailable: true,
    });
    bindModel('qwen3.8-flash');

    const host = mountComposer();
    await flush();
    openMenu(host);
    await flush();

    const skills = menuItem('技能');
    expect(skills).toBeTruthy();
    expect(skills!.getAttribute('aria-disabled')).not.toBe('true');
    expect(skills!.textContent).not.toContain('不支持');
  });

  it('⭐ 查不到元数据（Web 端 / 引擎离线 / 手填模型名）→ 一律宽松，不禁用', async () => {
    // 三种「查不到」里最容易出错的是这一支：把它读成「不支持」等于给所有人
    // 白送一次功能消失，而且完全没有报错可查。
    useModelsStore.setState({ managed: [], managedAvailable: false });
    bindModel('不在预设表里的模型');

    const host = mountComposer();
    await flush();
    openMenu(host);
    await flush();

    expect(menuItem('技能')!.getAttribute('aria-disabled')).not.toBe('true');
  });
});

describe('图片附件的视觉能力提示', () => {
  /** 往附件输入框塞一个图片文件并触发 change */
  async function addImage(host: HTMLElement): Promise<void> {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input, '找不到附件输入框').toBeTruthy();
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'a.png', { type: 'image/png' });
    Object.defineProperty(input!, 'files', { value: [file], configurable: true });
    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
  }

  it('未声明图片输入 → 提示一次（不阻止）', async () => {
    useModelsStore.setState({
      managed: [preset({ name: 'text-only', supportsVision: false })],
      managedAvailable: true,
    });
    bindModel('text-only');

    const host = mountComposer();
    await flush();
    await addImage(host);

    const toast = useToastStore.getState().items.at(-1);
    expect(toast?.severity).toBe('warning');
    expect(toast?.message).toContain('未声明图片输入能力');
    // 「可能无法被识别」而不是「不能添加」：判断权留给人
    expect(toast?.message).toContain('可能');
  });

  it('声明了图片输入 → 不提示', async () => {
    useModelsStore.setState({
      managed: [preset({ name: 'vision-gw', supportsVision: true })],
      managedAvailable: true,
    });
    bindModel('vision-gw');

    const host = mountComposer();
    await flush();
    await addImage(host);

    expect(useToastStore.getState().items).toHaveLength(0);
  });
});
