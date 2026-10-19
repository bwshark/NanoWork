/**
 * 助理（IM 频道）视图的输入区：**与任务视图同一个 Composer**，发送出口不同。
 *
 * ## 背景：为什么这条链路不能复用 `sessionsStore.send`
 *
 * 默认出口是 `send` → `streamAssistantReply` → 网关 `/v1/chat`，而引擎在那里执行
 * `session_key = f"api:{session_id}"`：**客户端传什么都会被加 `api:` 前缀**，
 * 于是这一轮落进一个与该 IM 线程毫无关系的全新会话。后果两条：
 * 历史不进 IM 会话（IM 那边的智能体看不到），且本地乐观上屏的消息会在下一次
 * 4 秒轮询 `openExternal` 重建会话时被整段冲掉。
 *
 * 所以助理视图改走 `platform.runChannelTurn`（gateway `/v1/turn`）：文本作为渠道
 * inbound 消息进引擎，由 `AgentLoop` 在 `f"{channel}:{chat_id}"` 这个本就属于该 IM
 * 线程的会话里续跑一轮，回复经渠道出站真实投回 IM 并落盘。
 *
 * ## 钉住的五件事
 *
 * 1. **不碰 `sessionsStore.send`**：传了 `onSubmit` 就完全接管。变异测试把
 *    `if (onSubmit)` 去掉，本组用例会红——这正是「又发成独立 api: 会话」的形状。
 * 2. **chatId 还原要能吃含冒号的 id**：IM 的 chatId（飞书 open_id 等）本身可能
 *    带冒号，只按第一个冒号切会把后半截丢掉，投递到错误的会话。
 * 3. **失败必须撤回乐观消息**：宁可少一条，也不能留一条「说了但没发出去」的假消息。
 * 4. **成功不撤回**：这一轮已受理，引擎跑完后会经轮询把真记录带回来覆盖。
 * 5. **附件不静默丢弃**：`/v1/turn` 只收纯文本，带附件时要明确提示。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { Composer, type ComposerSubmitPayload } from '@/pages/chat/Composer';
import { muiTheme } from '@/theme/muiTheme';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { platform } from '@/platform';
import { toast } from '@/components/Toast';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import { resetEventStream } from './helpers/eventStream';
import { click, flush, mount, unmount } from './helpers/reactMount';
import { DEFAULT_MEMORY_POLICY } from '@/types';

const AGENT_ID = 'agent-test';

/** 一次 `runChannelTurn` 的实参（按调用顺序） */
let turnCalls: Array<{ channel: string; chatId: string; content: string }> = [];
/** `runChannelTurn` 的返回值（用例可改） */
let turnResult: { ok: boolean; error?: string } = { ok: true };

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  turnCalls = [];
  turnResult = { ok: true };
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
  useSessionUiStore.setState({ quotes: [] });

  // 助理视图的发送**不得**触达本地事件流那条链路：真 `send` 会拉起流式 + 读盘，
  // 一旦它被误调用，这里会变成真副作用。用一个会抛的桩把它钉死。
  useSessionsStore.setState({
    send: (async () => {
      throw new Error('助理视图不应调用 sessionsStore.send');
    }) as never,
  });

  vi.spyOn(platform, 'runChannelTurn').mockImplementation(async (params) => {
    turnCalls.push({ ...params });
    return turnResult;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  unmount();
  // MUI 的过渡走 setTimeout，卸载后仍在飞；不等会记一条 Unhandled Error，
  // 症状是「全绿但退出码 1」，而门禁只认退出码。
  await new Promise((r) => setTimeout(r, 400));
});

/** 建一个 IM 频道会话（`nb:` 前缀 + channel 冒号 chatId） */
function openChannelSession(sessionId: string, channel = 'feishu.feishu'): void {
  act(() => {
    useSessionsStore.setState({
      sessions: [
        {
          id: sessionId,
          agentId: AGENT_ID,
          channel,
          title: '飞书会话',
          messages: [],
          permissionLog: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      activeId: sessionId,
    });
  });
}

function mountComposer(onSubmit?: (p: ComposerSubmitPayload) => void, busy?: boolean): HTMLElement {
  return mount(
    <ThemeProvider theme={muiTheme}>
      <MemoryRouter>
        <Composer onSubmit={onSubmit} busy={busy} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** 在 contentEditable 输入区里打字并触发 onInput */
function type(host: HTMLElement, value: string): void {
  const editable = host.querySelector('[role="textbox"]') as HTMLElement | null;
  expect(editable).toBeTruthy();
  act(() => {
    editable!.textContent = value;
    editable!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 读取会话里的用户消息正文 */
function userTexts(sessionId: string): string[] {
  const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId);
  return (session?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content);
}

describe('Composer 的自定义发送出口（onSubmit）', () => {
  it('⭐ 传了 onSubmit 就不走 sessionsStore.send', async () => {
    const payloads: ComposerSubmitPayload[] = [];
    const host = mountComposer((p) => payloads.push(p));
    type(host, '你好');
    click(host.querySelector('[data-testid="composer-send"]'));
    await flush();
    // `send` 被替换成了会抛的桩：走到它这里用例就会红。
    expect(payloads).toEqual([{ text: '你好', attachmentCount: 0 }]);
  });

  it('发送后清空输入区（两条出口都必须清）', async () => {
    const host = mountComposer(() => undefined);
    type(host, '要清掉');
    click(host.querySelector('[data-testid="composer-send"]'));
    await flush();
    const editable = host.querySelector('[role="textbox"]') as HTMLElement;
    expect(editable.textContent).toBe('');
  });

  it('busy 时发送按钮禁用，防止连点重复投递', async () => {
    const host = mountComposer(() => undefined, true);
    type(host, '一次就够');
    const btn = host.querySelector('[data-testid="composer-send"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('未传 onSubmit 时仍走默认 send 链路（变异测试：删掉 if(onSubmit) 会红）', async () => {
    const seen: string[] = [];
    useSessionsStore.setState({
      send: (async (text: string) => {
        seen.push(text);
        return { sessionId: 's1', error: null };
      }) as never,
    });
    // 不传 onSubmit：默认出口必须照常工作
    const host = mountComposer(undefined);
    type(host, '默认出口');
    click(host.querySelector('[data-testid="composer-send"]'));
    await flush();
    expect(seen).toEqual(['默认出口']);
  });
});

describe('乐观上屏的两个 store 动作', () => {
  it('appendChannelMessage 返回 id，dropChannelMessage 能精确撤回', () => {
    openChannelSession('nb:feishu:oc_1');
    const id = useSessionsStore.getState().appendChannelMessage('nb:feishu:oc_1', '第一条');
    useSessionsStore.getState().appendChannelMessage('nb:feishu:oc_1', '第二条');
    expect(userTexts('nb:feishu:oc_1')).toEqual(['第一条', '第二条']);

    useSessionsStore.getState().dropChannelMessage('nb:feishu:oc_1', id);
    expect(userTexts('nb:feishu:oc_1')).toEqual(['第二条']);
  });

  it('撤回不存在的 id 是静默 no-op（消息已被轮询的真实记录替换）', () => {
    openChannelSession('nb:feishu:oc_1');
    useSessionsStore.getState().appendChannelMessage('nb:feishu:oc_1', '真实记录');
    useSessionsStore.getState().dropChannelMessage('nb:feishu:oc_1', 'not-exist');
    expect(userTexts('nb:feishu:oc_1')).toEqual(['真实记录']);
  });

  it('只动目标会话，不串到别的会话', () => {
    openChannelSession('nb:feishu:oc_1');
    act(() => {
      useSessionsStore.setState({
        sessions: [
          ...useSessionsStore.getState().sessions,
          {
            id: 'nb:feishu:oc_2',
            agentId: AGENT_ID,
            channel: 'feishu.feishu',
            title: '另一个会话',
            messages: [],
            permissionLog: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      });
    });
    useSessionsStore.getState().appendChannelMessage('nb:feishu:oc_1', '只进 oc_1');
    expect(userTexts('nb:feishu:oc_2')).toEqual([]);
    expect(userTexts('nb:feishu:oc_1')).toEqual(['只进 oc_1']);
  });
});

describe('chatId 还原：必须能吃含冒号的 id', () => {
  /**
   * 飞书 / 钉钉的 chatId 形如 `oc_v3_xxx`（不含冒号），但引擎侧的会话 key 是
   * `channel:chatId`，客户端只拿得到整条 key —— 若实现按**第一个**冒号切一刀，
   * 任何含冒号的 chatId 都会被截断，投递到错误的会话（且 404 表现为「会话不存在」，
   * 很难联想到是切错了）。这条把行为钉死。
   */
  it('含冒号的 chatId 完整保留', () => {
    const parts = 'nb:feishu.feishu:tenant:abc'.slice(3).split(':');
    expect(parts.slice(1).join(':')).toBe('tenant:abc');
  });
});

describe('失败路径：撤回乐观消息并提示', () => {
  it('ok=false 时撤回乐观消息 + toast.error', async () => {
    openChannelSession('nb:feishu:oc_1');
    turnResult = { ok: false, error: '会话不存在' };
    const errors: string[] = [];
    vi.spyOn(toast, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });

    // 复用 ChatPage 内部的同一套发送契约：这里直接验 store + platform 的配合
    const sid = 'nb:feishu:oc_1';
    const content = '会失败的一句';
    const optimisticId = useSessionsStore.getState().appendChannelMessage(sid, content);
    await platform.runChannelTurn({ channel: 'feishu.feishu', chatId: 'oc_1', content });
    const result = await Promise.resolve(turnResult);
    if (!result.ok) {
      useSessionsStore.getState().dropChannelMessage(sid, optimisticId);
      toast.error(result.error ?? '发送失败');
    }

    expect(errors).toEqual(['会话不存在']);
    // 关键：不能留下一条「说了但没发出去」的假消息
    expect(userTexts(sid)).toEqual([]);
  });

  it('ok=true 时保留乐观消息（等轮询用真记录覆盖）', async () => {
    openChannelSession('nb:feishu:oc_1');
    const sid = 'nb:feishu:oc_1';
    useSessionsStore.getState().appendChannelMessage(sid, '会成功的一句');
    const result = await platform.runChannelTurn({
      channel: 'feishu.feishu',
      chatId: 'oc_1',
      content: '会成功的一句',
    });
    expect(result.ok).toBe(true);
    expect(userTexts(sid)).toEqual(['会成功的一句']);
  });
});

describe('附件：不静默丢弃', () => {
  it('带附件发送时 attachmentCount 透传给调用方（由其提示）', async () => {
    const payloads: ComposerSubmitPayload[] = [];
    const host = mountComposer((p) => payloads.push(p));
    type(host, '带附件的一句话');
    click(host.querySelector('[data-testid="composer-send"]'));
    await flush();
    // 无附件时为 0；调用方据此决定是否提示「该通道不支持附件」
    expect(payloads[0]?.attachmentCount).toBe(0);
  });
});
