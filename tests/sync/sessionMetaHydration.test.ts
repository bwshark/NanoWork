/**
 * 补缺口用例：`applyRemoteSessionMeta` 落地远端 sessionMeta 时，**已水合会话的
 * 本机运行时状态（messages / permissionLog / messageCount）必须保留**。
 *
 * ## 为什么这条必须单测（工程师自述偏离的独立复核）
 * 工程师把存活分支写成 `{ ...x, ...next, messages: x.messages, permissionLog:
 * x.permissionLog, messageCount: x.messageCount }`（**保留**本机运行时状态），理由是
 * 「引擎 accepted 非空后会再 pull 一次自己刚推的变更；若整条覆盖会清空已水合消息，
 * 而 `hydratedSessions` 已标记就绪、`loadSession` 不再重读 → 聊天记录永久消失」。
 *
 * 本用例**证实**该理由成立：已水合会话（messages 非空）落地一条远端 sessionMeta 后，
 * `messages` 仍在。把 `apply` 的存活分支改成 `{ ...x, ...next }` → 本用例变红。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '@/sync/syncRegistry';
import { createMemoryEventStore, __setEventStoreForTest } from '@/events';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Message, PermissionLog, Session, Settings } from '@/types';

const NEWER = '2026-09-01T00:00:00.000Z';

function baseSettings(): Settings {
  return {
    gatewayEndpoint: 'http://127.0.0.1:8765/v1',
    apiToken: '',
    theme: 'dark',
    processDetail: 'key',
    memoryEnabled: true,
    autoSummarize: true,
    transcription: { enabled: false, endpoint: '', model: 'whisper-1', apiToken: '', language: 'zh' },
    desktop: { closeToTray: true, hotkey: '', openAtLogin: false, showInDock: true },
    workspaceAliases: {},
    knownWorkspaces: [],
    sidebarCollapsed: false,
    hiddenSessions: [],
    shortcuts: {},
    defaultWorkspacePath: '/local/ws',
  };
}

function hydratedSession(): Session {
  const messages = [
    { id: 'm1', role: 'user', content: '你好' },
    { id: 'm2', role: 'assistant', content: '在的' },
  ] as unknown as Message[];
  const permissionLog = [{ id: 'p1', tool: 'write_file', decision: 'allow' }] as unknown as PermissionLog[];
  return {
    id: 's1',
    agentId: 'a1',
    title: '本机标题',
    messages,
    permissionLog,
    messageCount: 2,
    workdir: '/remote/path',
    streamWorkdir: '/devA/ws',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 1,
    updatedBy: 'dev-a',
  };
}

beforeEach(() => {
  __setEventStoreForTest(createMemoryEventStore());
  useSettingsStore.setState({
    settings: baseSettings(),
    syncMeta: { rev: 0, updatedAt: '', updatedBy: '', deletedAt: null },
  });
  useSessionsStore.setState({
    sessions: [hydratedSession()],
    activeId: 's1',
    sessionTombstones: {},
  });
});

afterEach(() => {
  __setEventStoreForTest(null);
});

describe('applyRemoteSessionMeta：保留已水合会话的本机运行时状态', () => {
  it('落地远端 sessionMeta 后 title 更新，但 messages / permissionLog / messageCount 仍在', () => {
    const spec = createDefaultRegistry().get('sessionMeta')!;

    spec.apply({
      id: 's1',
      title: '远端标题',
      agentId: 'a1',
      workdir: '/remote/path',
      rev: 2,
      updatedAt: NEWER,
      updatedBy: 'dev-b',
      deletedAt: null,
    });

    const s = useSessionsStore.getState().sessions.find((x) => x.id === 's1')!;
    // 元数据字段以远端为准
    expect(s.title, '远端 title 应落地').toBe('远端标题');
    // 本机运行时状态保留（整条覆盖 { ...x, ...next } → 三者被清空 → 变红）
    expect(s.messages?.map((m) => m.id), 'messages 不得被清空').toEqual(['m1', 'm2']);
    expect(s.permissionLog, 'permissionLog 不得被清空').toHaveLength(1);
    expect(s.messageCount, 'messageCount 不得被清空').toBe(2);
  });

  it('落地一条【本机没有】的远端会话：初始化为空 messages / permissionLog', () => {
    const spec = createDefaultRegistry().get('sessionMeta')!;
    spec.apply({
      id: 's-new',
      title: '新会话',
      agentId: 'a1',
      rev: 1,
      updatedAt: NEWER,
      updatedBy: 'dev-b',
      deletedAt: null,
    });
    const s = useSessionsStore.getState().sessions.find((x) => x.id === 's-new')!;
    expect(s).toBeTruthy();
    expect(s.messages).toEqual([]);
    expect(s.permissionLog).toEqual([]);
  });
});
