/**
 * 默认工作空间（设置 → 通用 → 存储）的**下发链路**测试。
 *
 * 用户报过一个具体故障：设置里写着默认工作空间是 `<home>/NanoWork`，让 Agent
 * 新建一个文件，文件却落在了 `D:\test`。根因不在设置页，而在这条链路上有两处
 * 会**静默退化成「这一轮没有工作空间」**：
 *
 * 1. `createSession` 触发时主进程还没回过存储信息（应用刚启动的那一瞬）；
 * 2. 早于该功能存在的旧会话，`workdir` 本来就是 `undefined`。
 *
 * 请求里 `workspace` 一旦缺席，引擎就退回**它自己**配置里的默认工作空间，
 * 于是模型在提示词里看到的目录和用户在设置里看到的不是同一个——用户设的是 A，
 * 文件落在 B。而且这个失败是无声的：设置页照样显示 NanoWork，没有任何报错。
 *
 * 所以这里锁两件事：**请求必须带上有效工作空间**（含上面两种退化路径），
 * 以及**显式设过的不能被默认值覆盖**。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { useStorageInfoStore } from '@/stores/storageInfoStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { waitForSessionWrites } from '@/events';
import { resetEventStream } from './helpers/eventStream';
import type { Agent } from '@/types';
import type { StorageInfo } from '@/platform/types';
import type { ChatHandle, ChatRequest, StreamHandlers } from '@/ai/runtime/types';

const DEFAULT_DIR = 'C:\\Users\\tester\\NanoWork';
const CUSTOM_DIR = 'D:\\dev\\my-project';

/** 只填本文件用得到的字段；路径按 Windows 形态写，避免被当成分隔符转义 */
const INFO: StorageInfo = {
  cacheDir: 'C:\\Users\\tester\\.nanowork',
  cacheBytes: 1024,
  disk: {
    totalBytes: 300 * 1024 ** 3,
    usedBytes: 262 * 1024 ** 3,
    freeBytes: 38 * 1024 ** 3,
  },
  defaultWorkspaceDir: DEFAULT_DIR,
};

let captured: ChatRequest[] = [];

function agent(): Agent {
  return {
    id: 'agent-test',
    name: '测试智能体',
    systemPrompt: '你是测试助手',
    skillIds: [],
    imBinding: null,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

/** 参数 `info` 显式传 null 表示「主进程还没回话」，与「返回了空」不是一回事 */
function resetStores(info: StorageInfo | null = INFO) {
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
  useStorageInfoStore.setState({ info, loading: false, error: null });
  useSessionsStore.setState({
    sessions: [],
    activeId: null,
    streams: {},
    pendingApprovals: [],
    error: null,
  });
  useArtifactsStore.setState({ bySession: {} });
  useAgentsStore.setState({ agents: [agent()], activeAgentId: 'agent-test' });
  captured = [];
  resetEventStream();
}

function mockGateway() {
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (req: ChatRequest, handlers: StreamHandlers): ChatHandle => {
      captured.push(req);
      handlers.onToken('好的。');
      handlers.onStatus('done');
      handlers.onDone();
      return { done: Promise.resolve(), abort: () => {} };
    },
  );
}

async function settle(sessionId: string) {
  await waitForSessionWrites(sessionId);
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetStores();
  mockGateway();
});

afterEach(() => vi.restoreAllMocks());

describe('默认工作空间的下发链路', () => {
  it('新建会话自动落到默认工作空间，并随请求下发', async () => {
    const session = useSessionsStore.getState().createSession('agent-test', '新任务');
    expect(session.workdir).toBe(DEFAULT_DIR);

    await useSessionsStore.getState().send('你好', session.id);
    await settle(session.id);

    expect(captured).toHaveLength(1);
    expect(captured[0].workspace).toBe(DEFAULT_DIR);
  });

  it('会话建在「存储信息还没取到」的窗口里，发消息时兜底补上', async () => {
    // 复现真实时序：应用刚启动，`createSession` 抢在 IPC 回话之前触发。
    resetStores(null);
    const session = useSessionsStore.getState().createSession('agent-test', '抢跑会话');
    expect(session.workdir).toBeUndefined();

    // 主进程回话（几十毫秒后）
    useStorageInfoStore.setState({ info: INFO, loading: false, error: null });

    await useSessionsStore.getState().send('你好', session.id);
    await settle(session.id);

    // 会话的 workdir 不回填（回填要搬事件流目录，为几十毫秒的窗口不值得），
    // 但**下发给引擎的工作空间必须是有效值**——否则模型只能自己猜目录。
    expect(captured[0].workspace).toBe(DEFAULT_DIR);
  });

  it('用户自定义路径优先于内置默认', async () => {
    useSettingsStore.getState().setSettings({ defaultWorkspacePath: CUSTOM_DIR });

    const session = useSessionsStore.getState().createSession('agent-test', '自定义路径会话');
    expect(session.workdir).toBe(CUSTOM_DIR);

    await useSessionsStore.getState().send('你好', session.id);
    await settle(session.id);

    expect(captured[0].workspace).toBe(CUSTOM_DIR);
  });

  it('会话已显式设过工作空间时，不被默认值覆盖', async () => {
    const session = useSessionsStore
      .getState()
      .createSession('agent-test', '指定路径会话', { workdir: CUSTOM_DIR });

    await useSessionsStore.getState().send('你好', session.id);
    await settle(session.id);

    expect(captured[0].workspace).toBe(CUSTOM_DIR);
  });

  it('存储信息不可用（Web 端 / 读取失败）时不下发工作空间，而不是编一个', async () => {
    // 这条是「宁可缺席也不猜」的护栏：引擎侧有自己的默认工作空间，
    // 但那是引擎的事实；渲染层凭空造一个路径，事后无法分辨它是猜的还是用户选的。
    resetStores(null);

    const session = useSessionsStore.getState().createSession('agent-test', '无信息会话');
    await useSessionsStore.getState().send('你好', session.id);
    await settle(session.id);

    expect(captured[0].workspace).toBeUndefined();
  });
});
