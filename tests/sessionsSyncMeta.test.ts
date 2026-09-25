/**
 * 会话同步元数据的**写入链路**（architecture-syncmeta §3.1 第 7 行 / §7.3）。
 *
 * 判据来自文档 §七 批次 3：「一条『会话重命名后 `rev` 递增』用例」。
 * 之所以要一条**集成**用例而不只是纯函数用例：`rev` 真正有意义的地方是
 * 「改动 → `rev` 递增 → 落进 `.meta.json`」这条链路。`updateSession` 里算得再对，
 * 只要 `toMeta` 忘了透传，磁盘上就没有 `rev`——而这件事在界面上完全看不出来。
 *
 * 同时钉住另一半：**没改元数据就不要涨版本**。改记忆快照走的是同一个
 * `updateSession`，若它也涨 `rev`，版本号就退化成「打开过几次」的计数器。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import { useStorageInfoStore } from '@/stores/storageInfoStore';
import { __resetDeviceIdForTest, getDeviceId } from '@/lib/deviceId';
import { waitForSessionWrites } from '@/events';
import { resetEventStream } from './helpers/eventStream';
import type { AppInfo, StorageInfo } from '@/platform/types';
import type { EventStore } from '@/events';

const DEVICE = 'dev-test-01';
const DEFAULT_DIR = 'C:\\Users\\tester\\NanoWork';

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

function appInfo(deviceId: string): AppInfo {
  return {
    appName: 'NanoWork',
    version: '0.0.0',
    electron: '0.0.0',
    node: '0.0.0',
    chrome: '0.0.0',
    platform: 'win32',
    osVersion: '10',
    arch: 'x64',
    deviceId,
  };
}

let store: EventStore;

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
  useAgentsStore.setState({
    agents: [
      {
        id: 'agent-test',
        name: '测试智能体',
        systemPrompt: '你是测试助手',
        skillIds: [],
        imBinding: null,
        enabled: true,
        createdAt: '2026-09-25T00:00:00.000Z',
      },
    ],
    activeAgentId: 'agent-test',
  });
  store = resetEventStream();
}

/** 建会话并等它落盘，返回会话 id */
async function newSession() {
  const session = useSessionsStore.getState().createSession('agent-test', '新任务');
  await waitForSessionWrites(session.id);
  return session.id;
}

async function metaOf(id: string) {
  const session = useSessionsStore.getState().sessions.find((s) => s.id === id);
  return store.readMeta(id, session?.workdir);
}

beforeEach(async () => {
  vi.spyOn(platform, 'appInfo').mockResolvedValue(appInfo(DEVICE));
  __resetDeviceIdForTest();
  // 预热：store 的写动作是同步的，`currentDeviceId()` 未就绪时落空串。
  // 预热由 `src/App.tsx` 的启动副作用保证，用例里显式做一次以断言真实设备号。
  await getDeviceId();
  resetStores();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetDeviceIdForTest();
});

describe('改动 → rev 递增 → 落进 meta.json', () => {
  it('新建会话落 rev = 1 与当前设备号', async () => {
    const id = await newSession();
    const meta = await metaOf(id);

    expect(meta?.rev).toBe(1);
    expect(meta?.updatedBy).toBe(DEVICE);
  });

  it('重命名后 rev 递增，且写进磁盘的 meta', async () => {
    const id = await newSession();

    useSessionsStore.getState().renameSession(id, '改过的标题');
    await waitForSessionWrites(id);

    const meta = await metaOf(id);
    expect(meta?.title).toBe('改过的标题');
    // 这条是 §七 批次 3 的判据本体
    expect(meta?.rev).toBe(2);
    expect(meta?.updatedBy).toBe(DEVICE);
  });

  it('多次改动逐次递增（不是每次重启都从头数）', async () => {
    const id = await newSession();

    useSessionsStore.getState().renameSession(id, '第一次');
    await waitForSessionWrites(id);
    useSessionsStore.getState().togglePinSession(id);
    await waitForSessionWrites(id);
    useSessionsStore.getState().setSessionMode(id, 'plan');
    await waitForSessionWrites(id);

    const meta = await metaOf(id);
    expect(meta?.rev).toBe(4);
    expect(meta?.pinned).toBe(true);
    expect(meta?.mode).toBe('plan');
  });

  it('从磁盘水合回来的会话带着 rev，不会退回缺省', async () => {
    const id = await newSession();
    useSessionsStore.getState().renameSession(id, '第二次');
    await waitForSessionWrites(id);
    const onDisk = await metaOf(id);
    expect(onDisk?.rev).toBe(2);

    // 忘记透传 rev 的话，水合一次就把它洗成 undefined，下一次改动会从 1 重算
    // （而不是 3），同步层据此判「谁更新」会判反方向
    const hydrated = await store.readMeta(id, onDisk?.workdir);
    expect(hydrated?.rev).toBe(2);
    expect(hydrated?.updatedBy).toBe(DEVICE);
  });
});

describe('没改元数据就不涨版本', () => {
  it('把标题设成同一个值不算改动', async () => {
    const id = await newSession();
    useSessionsStore.getState().renameSession(id, '新任务');
    await waitForSessionWrites(id);

    const meta = await metaOf(id);
    expect(meta?.rev).toBe(1);
  });

  it('刷新记忆快照（纯缓存）不算改动', async () => {
    const id = await newSession();

    useSessionsStore.getState().updateSession(id, (s) => ({
      ...s,
      memory: '一些记忆',
      memoryVersion: 3,
      memoryWorkspace: DEFAULT_DIR,
    }));
    await waitForSessionWrites(id);

    const meta = await metaOf(id);
    // 若这里变成 2，版本号就退化成「打开过几次」的计数器
    expect(meta?.rev).toBe(1);
    // 记忆本来就不进 meta（它是缓存，落盘没有意义）
    expect(meta).not.toHaveProperty('memory');
  });

  it('改工作空间分片不算改动（它是「记录落在哪」这个本机事实）', async () => {
    const id = await newSession();

    useSessionsStore.getState().updateSession(id, (s) => ({
      ...s,
      streamWorkdir: DEFAULT_DIR,
    }));
    await waitForSessionWrites(id);

    const meta = await metaOf(id);
    expect(meta?.rev).toBe(1);
  });

  it('未绑定的外部来源会话不产生 meta（真值在引擎侧）', () => {
    // 只读留痕 / IM 频道 / 定时执行会话：本地落盘会制造两份互相打架的数据
    useSessionsStore.setState({
      sessions: [
        {
          id: 'cron:run-1',
          agentId: 'agent-test',
          title: '定时执行留痕',
          messages: [],
          permissionLog: [],
          readonly: true,
          createdAt: '2026-09-25T00:00:00.000Z',
          updatedAt: '2026-09-25T00:00:00.000Z',
        },
      ],
      activeId: 'cron:run-1',
    });

    useSessionsStore.getState().renameSession('cron:run-1', '改个名');

    const session = useSessionsStore.getState().sessions[0];
    // 元数据照常维护在内存里（视图要一致），只是不落盘
    expect(session.rev).toBe(1);
  });
});
