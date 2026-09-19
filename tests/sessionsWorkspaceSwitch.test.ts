/**
 * 切换工作空间时**记录搬不搬**，以及「0 个任务的工作空间」还在不在。
 *
 * 用户报的现象：把一个任务从工作空间 bbb 切到 aaa 之后——
 *   1. 侧边栏里 bbb 整个分组消失了（看起来像工作空间丢了）；
 *   2. 那个会话的记录被「读旧 → 删旧 → 写新」搬进了 aaa 的记录目录。
 *
 * 两件事都是真的，成因也都在同一处：**工作空间既是语义（这活儿干在哪儿），又
 * 被当成了事件流的物理落点**（`projects/<slug>/`），于是「换工作空间」被实现成
 * 「把整个会话连记录一起搬过去」。
 *
 * 现在的规则：
 * - 记录只在「确知一条消息都没有」时随工作空间归位（新建任务 → 选工作空间 → 干活
 *   这条主路径下，记录仍落在用户真正干活的那个分片里）；
 * - 一旦有过消息，落盘分片就**冻结**：`workdir` 继续跟随新工作空间，磁盘上不动
 *   任何文件（搬迁是「读旧→删旧→写新」，中途挂掉就是整段对话没了，而这个动作
 *   的触发只是点一下工作空间按钮，代价与触发完全不成比例）；
 * - 工作空间进 `settings.knownWorkspaces` 登记表，0 个任务也留在侧边栏分组里。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { useStorageInfoStore } from '@/stores/storageInfoStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { __resetHydrationForTest } from '@/stores/sessionsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import {
  __resetRecordersForTest,
  __setEventStoreForTest,
  waitForSessionWrites,
} from '@/events';
import { resetEventStream } from './helpers/eventStream';
import type { EventStore } from '@/events';
import type { Agent } from '@/types';
import type { StorageInfo } from '@/platform/types';
import type { ChatHandle, ChatRequest, StreamHandlers } from '@/ai/runtime/types';

const DEFAULT_DIR = 'C:\\Users\\tester\\NanoWork';
const BBB = 'D:\\work\\bbb';
const AAA = 'D:\\work\\aaa';
const CCC = 'D:\\work\\ccc';

const INFO: StorageInfo = {
  cacheDir: 'C:\\Users\\tester\\.nanowork',
  cacheBytes: 1024,
  disk: { totalBytes: 1, usedBytes: 1, freeBytes: 1 },
  defaultWorkspaceDir: DEFAULT_DIR,
};

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

let store: EventStore;

/**
 * 记忆存储换成「有目录维度」的一份。
 *
 * 内存参照实现声明 `fileBacked: false`（它确实不写文件），但它的落点维度本来就是
 * 按 `workdir` 分的（`scopeKey`）。而 `setSessionWorkdir` 的搬迁分支专门看这个能力位
 * ——Web 端没有目录维度，搬了也没意义。这里把它包一层声明成有目录，好让搬迁逻辑
 * 真正跑起来：否则「空会话的记录随工作空间归位」这条路径在测试里永远是空转。
 */
function resetFileBackedStream(): EventStore {
  const inner = resetEventStream();
  const wrapped: EventStore = {
    ...inner,
    capabilities: { ...inner.capabilities, fileBacked: true },
  };
  __setEventStoreForTest(wrapped);
  return wrapped;
}

function resetStores() {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      memoryEnabled: false,
      autoSummarize: false,
      transcription: DEFAULT_TRANSCRIPTION,
      desktop: DEFAULT_DESKTOP,
      workspaceAliases: {},
      knownWorkspaces: [],
    },
    status: 'offline',
  });
  useStorageInfoStore.setState({ info: INFO, loading: false, error: null });
  useSessionsStore.setState({
    sessions: [],
    activeId: null,
    streams: {},
    pendingApprovals: [],
    error: null,
  });
  useArtifactsStore.setState({ bySession: {} });
  useAgentsStore.setState({ agents: [agent()], activeAgentId: 'agent-test' });
  store = resetEventStream();
}

function mockGateway() {
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (_req: ChatRequest, handlers: StreamHandlers): ChatHandle => {
      handlers.onToken('好的，我在这个目录里干活。');
      handlers.onStatus('done');
      handlers.onDone();
      return { done: Promise.resolve(), abort: () => {} };
    },
  );
}

/** 等该会话已入队的写盘全部落定（事件与 meta 是分开排队的） */
async function settle(sessionId: string) {
  await waitForSessionWrites(sessionId);
  await new Promise((r) => setTimeout(r, 0));
}

function sessionOf(id: string) {
  const s = useSessionsStore.getState().sessions.find((x) => x.id === id);
  if (!s) throw new Error(`会话不存在：${id}`);
  return s;
}

beforeEach(() => {
  resetStores();
  mockGateway();
});

afterEach(() => vi.restoreAllMocks());

describe('切换工作空间：已有消息的会话，记录不搬', () => {
  it('切到新工作空间后，事件与 meta 仍留在原分片，只把新工作空间写进 meta', async () => {
    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '任务', { workdir: BBB });
    await useSessionsStore.getState().send('你好', s.id);
    await settle(s.id);
    const before = (await store.readEvents(s.id, BBB)).length;
    expect(before).toBeGreaterThan(1); // session-start + 消息 + session-end

    useSessionsStore.getState().setSessionWorkdir(s.id, AAA);
    await settle(s.id);

    // 原分片：记录一条不少
    expect((await store.readEvents(s.id, BBB)).length).toBe(before);
    // 新分片：什么都没有（记录没有被复制/搬迁过去）
    expect(await store.readEvents(s.id, AAA)).toEqual([]);

    // meta 留在原分片，但里面记着**新的**工作空间
    const meta = await store.readMeta(s.id, BBB);
    expect(meta?.workdir).toBe(BBB);
    expect(meta?.workspace).toBe(AAA);
    expect(await store.readMeta(s.id, AAA)).toBeNull();

    // 内存视图：语义工作空间已切走，落盘分片冻在原处
    expect(sessionOf(s.id).workdir).toBe(AAA);
    expect(sessionOf(s.id).streamWorkdir).toBe(BBB);
  });

  it('冻结之后继续对话，事件仍追加在原分片（不会被拆到两个文件里）', async () => {
    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '任务', { workdir: BBB });
    await useSessionsStore.getState().send('第一轮', s.id);
    await settle(s.id);
    useSessionsStore.getState().setSessionWorkdir(s.id, AAA);
    await settle(s.id);

    const beforeSecond = (await store.readEvents(s.id, BBB)).length;
    await useSessionsStore.getState().send('第二轮', s.id);
    await settle(s.id);

    expect((await store.readEvents(s.id, BBB)).length).toBeGreaterThan(beforeSecond);
    expect(await store.readEvents(s.id, AAA)).toEqual([]);
  });

  it('再切一次（第三个工作空间）依然不搬：分片只冻结一次', async () => {
    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '任务', { workdir: BBB });
    await useSessionsStore.getState().send('你好', s.id);
    await settle(s.id);
    useSessionsStore.getState().setSessionWorkdir(s.id, AAA);
    await settle(s.id);
    useSessionsStore.getState().setSessionWorkdir(s.id, CCC);
    await settle(s.id);

    expect(sessionOf(s.id).workdir).toBe(CCC);
    expect(sessionOf(s.id).streamWorkdir).toBe(BBB);
    expect(await store.readEvents(s.id, AAA)).toEqual([]);
    expect(await store.readEvents(s.id, CCC)).toEqual([]);
    expect((await store.readEvents(s.id, BBB)).length).toBeGreaterThan(0);
  });

  it('重启水合：按分片读回历史，工作空间取 meta.workspace', async () => {
    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '任务', { workdir: BBB });
    await useSessionsStore.getState().send('你好', s.id);
    await settle(s.id);
    const historyLen = (await store.readEvents(s.id, BBB)).length;
    useSessionsStore.getState().setSessionWorkdir(s.id, AAA);
    await settle(s.id);

    // 模拟重启：记录器、水合标记、内存视图全部丢掉，只留磁盘上那份存储
    __resetRecordersForTest();
    __resetHydrationForTest();
    useSessionsStore.setState({ sessions: [], activeId: null });
    await useSessionsStore.getState().loadSessions();
    await useSessionsStore.getState().loadSession(s.id);
    await settle(s.id);

    const reloaded = sessionOf(s.id);
    expect(reloaded.workdir).toBe(AAA);
    expect(reloaded.streamWorkdir).toBe(BBB);
    expect(reloaded.messages.length).toBeGreaterThan(0);
    expect((await store.readEvents(s.id, BBB)).length).toBe(historyLen);
  });
});

describe('切换工作空间：空会话的记录仍随工作空间归位', () => {
  beforeEach(() => {
    // 这一组要的是**真的搬迁**（`fileBacked` 分支），见 resetFileBackedStream 的说明
    store = resetFileBackedStream();
  });

  it('没发过消息时切换：事件流搬到新分片，meta 里不出现 workspace 字段', async () => {
    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '空任务', { workdir: BBB });
    await settle(s.id);

    useSessionsStore.getState().setSessionWorkdir(s.id, AAA);
    await settle(s.id);

    expect(await store.readEvents(s.id, BBB)).toEqual([]);
    expect((await store.readEvents(s.id, AAA)).length).toBeGreaterThan(0);
    const meta = await store.readMeta(s.id, AAA);
    expect(meta?.workdir).toBe(AAA);
    // 两者相同就不占字段：「records 落在哪」与「工作空间在哪」是同一个答案
    expect(meta?.workspace).toBeUndefined();
    expect(sessionOf(s.id).streamWorkdir).toBeUndefined();
  });

  it('先把工作空间选好再干活：记录落在真正干活的那个分片里', async () => {
    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '新任务', { workdir: DEFAULT_DIR });
    useSessionsStore.getState().setSessionWorkdir(s.id, BBB);
    await settle(s.id);
    await useSessionsStore.getState().send('你好', s.id);
    await settle(s.id);

    expect(await store.readEvents(s.id, DEFAULT_DIR)).toEqual([]);
    expect((await store.readEvents(s.id, BBB)).length).toBeGreaterThan(0);
    expect(sessionOf(s.id).workdir).toBe(BBB);
  });
});

describe('工作空间登记表', () => {
  it('新建 / 切换工作空间都会登记，切走之后原地那一个仍在表里', async () => {
    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '任务', { workdir: BBB });
    await useSessionsStore.getState().send('你好', s.id);
    await settle(s.id);
    useSessionsStore.getState().setSessionWorkdir(s.id, AAA);
    await settle(s.id);

    expect(useSettingsStore.getState().settings.knownWorkspaces).toEqual([
      BBB,
      AAA,
    ]);
  });

  it('forgetWorkspace 只摘登记，不动任何会话数据', async () => {
    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '任务', { workdir: BBB });
    await settle(s.id);

    useSettingsStore.getState().forgetWorkspace(BBB);
    expect(useSettingsStore.getState().settings.knownWorkspaces).toEqual([]);
    // 会话与它的记录都还在
    expect(sessionOf(s.id).workdir).toBe(BBB);
    expect((await store.readEvents(s.id, BBB)).length).toBeGreaterThan(0);
  });
});
