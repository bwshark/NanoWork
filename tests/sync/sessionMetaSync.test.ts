/**
 * `sessionMeta` collection：D.3 payload 白名单 / D.4 落地双写 / D.5 workdir 裁决。
 *
 * 覆盖 §I.3 变异清单：
 * - **D-⑥** `payload` 加 `streamWorkdir` → 「payload 不含 `streamWorkdir`」变红；
 * - **D-⑦** `apply` 存活分支不重定向 `streamWorkdir` → 「`streamWorkdir === 本机默认」变红；
 * - **D-⑧** 墓碑分支改用 `writeMeta`（不 `tombstoneSession`）→ 「pull 墓碑后索引条目消失」变红。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '@/sync/syncRegistry';
import { SESSION_SYNC_FIELDS } from '@/lib/sessionSyncMeta';
import { createMemoryEventStore, getEventStore, __setEventStoreForTest } from '@/events';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import type { Session, Settings } from '@/types';

const DEFAULT_WS = '/local/default-ws';

function baseSettings(): Settings {
  return {
    gatewayEndpoint: 'http://127.0.0.1:8765/v1',
    apiToken: '',
    theme: 'dark',
    memoryEnabled: true,
    autoSummarize: true,
    transcription: { enabled: false, endpoint: '', model: 'whisper-1', apiToken: '', language: 'zh' },
    desktop: { closeToTray: true, hotkey: '', openAtLogin: false, showInDock: true },
    workspaceAliases: {},
    knownWorkspaces: [],
    sidebarCollapsed: false,
    hiddenSessions: [],
    shortcuts: {},
    defaultWorkspacePath: DEFAULT_WS,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    agentId: 'a1',
    title: '任务',
    messages: [],
    permissionLog: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function spec() {
  return createDefaultRegistry().get('sessionMeta')!;
}

beforeEach(() => {
  __setEventStoreForTest(createMemoryEventStore());
  useSessionsStore.setState({ sessions: [], activeId: null, sessionTombstones: {} });
  useSettingsStore.setState({
    settings: baseSettings(),
    syncMeta: { rev: 0, updatedAt: '', updatedBy: '', deletedAt: null },
  });
});

afterEach(() => {
  __setEventStoreForTest(null);
});

// ─────────────────────────── D.3 payload 白名单 ───────────────────────────

describe('D.3：sessionMeta payload = 白名单 + 四元数据（D-⑥）', () => {
  it('含 SESSION_SYNC_FIELDS 全字段 + 四元数据', () => {
    const payload = spec().payload({
      ...session({
        skillIds: ['sk1'],
        workdir: '/remote/path',
        fullAccess: true,
        mode: 'plan',
        model: 'gpt-x',
        channel: 'dingtalk',
        pinned: true,
        rev: 4,
        updatedBy: 'dev-a',
      }),
    });
    for (const field of SESSION_SYNC_FIELDS) {
      expect(payload).toHaveProperty(field);
    }
    expect(payload).toMatchObject({ id: 's1', rev: 4, updatedBy: 'dev-a', deletedAt: null });
  });

  it('不含本机事实字段 / 正文（streamWorkdir / messages / memory* …）', () => {
    const payload = spec().payload(
      session({
        streamWorkdir: '/local/shard',
        messages: [{ id: 'm' } as never],
        messageCount: 9,
        memory: 'x',
        memoryVersion: 3,
        memoryWorkspace: '/w',
      }) as unknown as Record<string, unknown>,
    );
    for (const key of ['streamWorkdir', 'messages', 'permissionLog', 'messageCount', 'memory', 'memoryVersion', 'memoryWorkspace']) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it('墓碑记录经 payload 出来只剩元数据（白名单字段读作 undefined，序列化丢弃）', () => {
    const payload = spec().payload({
      id: 's1',
      rev: 3,
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'dev-a',
      deletedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(payload).toMatchObject({ id: 's1', rev: 3, deletedAt: '2026-09-01T00:00:00.000Z' });
  });
});

// ─────────────────────────── D.4 落地双写 ───────────────────────────

describe('D.4：存活落地写内存 + 落盘；墓碑落地走 tombstoneSession', () => {
  it('存活：加入内存 sessions + 写 meta（内存事件存储可见）', async () => {
    spec().apply({
      id: 's1',
      title: '来自远端',
      agentId: 'a1',
      workdir: '/remote/path',
      mode: 'craft',
      rev: 2,
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'dev-b',
      deletedAt: null,
    });

    const s = useSessionsStore.getState().sessions.find((x) => x.id === 's1');
    expect(s).toBeTruthy();
    expect(s!.title).toBe('来自远端');
    const meta = await getEventStore().readMeta('s1', DEFAULT_WS);
    expect(meta?.title).toBe('来自远端');
  });

  it('墓碑（D-⑧）：写索引条目 deletedAt + 从内存 sessions 摘除', async () => {
    // 先放一条存活会话（直接 setState，避免索引重建的 300ms 防抖影响断言）
    useSessionsStore.setState({
      sessions: [session({ id: 's1', workdir: '/remote/path' })],
      activeId: 's1',
      sessionTombstones: {},
    });

    spec().apply({
      id: 's1',
      rev: 5,
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'dev-a',
      deletedAt: '2026-09-01T00:00:00.000Z',
    });

    const state = useSessionsStore.getState();
    expect(state.sessions.find((x) => x.id === 's1')).toBeUndefined();
    expect(state.sessionTombstones.s1).toMatchObject({ rev: 5 });

    // 索引条目被墓碑覆盖（改用 writeMeta 不会产生这个条目 → 断言变红）
    const index = await getEventStore().readIndex();
    expect(index.entries.s1?.deletedAt).toBe('2026-09-01T00:00:00.000Z');
    const listed = await getEventStore().listSessions();
    expect(listed.find((e) => e.id === 's1')).toBeUndefined();
  });

  it('存活落地清同名墓碑', () => {
    useSessionsStore.setState({
      sessions: [],
      activeId: null,
      sessionTombstones: { s1: { rev: 2, updatedAt: '2026-08-01T00:00:00.000Z', updatedBy: 'dev-a', deletedAt: '2026-08-01T00:00:00.000Z' } },
    });
    spec().apply({ id: 's1', title: '复活', rev: 3, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'dev-b', deletedAt: null });
    expect(useSessionsStore.getState().sessionTombstones.s1).toBeUndefined();
    expect(useSessionsStore.getState().sessions.find((x) => x.id === 's1')).toBeTruthy();
  });
});

// ─────────────────────────── D.5 workdir 裁决 ───────────────────────────

describe('D.5：workdir 原值保留、streamWorkdir 重定向本机（D-⑦）', () => {
  it('落地后 workdir 保留对端值、streamWorkdir 为本机默认', () => {
    spec().apply({
      id: 's1',
      title: '远端会话',
      workdir: '/remote/path',
      rev: 2,
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'dev-b',
      deletedAt: null,
    });

    const s = useSessionsStore.getState().sessions.find((x) => x.id === 's1')!;
    expect(s.workdir).toBe('/remote/path'); // 语义工作空间原值保留
    expect(s.streamWorkdir).toBe(DEFAULT_WS); // 落盘分片重定向本机默认
    expect(s.streamWorkdir).not.toBe('/remote/path');
  });
});
