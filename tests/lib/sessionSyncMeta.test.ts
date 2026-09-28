/**
 * 会话同步元数据的判定（architecture-syncmeta §3.1 第 7 行 / §7.3）。
 *
 * 会话与那五个 store 实体不同：它只有 `updateSession` 一个入口，十来个动作都从
 * 它走。所以「什么时候涨 `rev`」的判据必须落在一个**共享件**上，而不是散在
 * 各调用点——散着写的失败形态是静默的（本地一切正常，换台设备才发现少了一次改动）。
 *
 * 这里锁三件事：
 * 1. 白名单**恰好**是那 12 个可同步字段，本机事实与纯缓存一个都不在内；
 * 2. 没变就不涨 `rev`（否则改一次记忆快照就涨一版，LWW 的「谁更新」被噪声淹没）；
 * 3. 数组按顺序比较、`undefined` 与 `[]` 不同义。
 */

import { describe, expect, it } from 'vitest';
import {
  SESSION_SYNC_FIELDS,
  pickSyncFields,
  sessionCreatePatch,
  sessionMetaChanged,
  sessionSyncPatch,
  withSessionSync,
} from '@/lib/sessionSyncMeta';
import type { Session } from '@/types';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    agentId: 'agent-1',
    title: '会话标题',
    messages: [],
    permissionLog: [],
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('SESSION_SYNC_FIELDS：白名单恰好是可同步的那一批', () => {
  it('本机事实与纯缓存一个都不在清单里', () => {
    // 这几条一旦进清单，同步就会把「本机的事实」当成「用户的声明」推上云：
    // streamWorkdir 是记录落在哪台机器的哪个目录、messageCount 是索引派生物、
    // memory* 是带本机版本号的缓存
    for (const key of ['streamWorkdir', 'messageCount', 'memory', 'memoryVersion', 'memoryWorkspace']) {
      expect(SESSION_SYNC_FIELDS as readonly string[]).not.toContain(key);
    }
  });

  it('正文与运行态也不在清单里（它们不走元数据通道）', () => {
    for (const key of ['messages', 'permissionLog', 'createdAt', 'updatedAt']) {
      expect(SESSION_SYNC_FIELDS as readonly string[]).not.toContain(key);
    }
  });
});

describe('sessionMetaChanged：只认可同步字段', () => {
  it('改记忆快照不算「改过元数据」', () => {
    // loadMemoryInto 走的是 updateSession，若它触发 rev+1，则每开一次会话、
    // 每刷一次记忆都涨一版——版本号就成了「打开过几次」的计数器
    const prev = session();
    const next = session({
      memory: '一些记忆',
      memoryVersion: 7,
      memoryWorkspace: 'D:\\ws',
      updatedAt: '2026-09-25T01:00:00.000Z',
    });

    expect(sessionMetaChanged(pickSyncFields(prev), pickSyncFields(next))).toBe(false);
  });

  it('改工作空间分片、消息、计数都不算', () => {
    const prev = session();
    const next = session({
      streamWorkdir: 'D:\\ws',
      messageCount: 12,
      messages: [
        {
          id: 'm-1',
          role: 'user',
          content: '你好',
          createdAt: new Date().toISOString(),
        },
      ],
    });

    expect(sessionMetaChanged(pickSyncFields(prev), pickSyncFields(next))).toBe(false);
  });

  it.each([
    ['title', { title: '换个名字' }],
    ['pinned', { pinned: true }],
    ['mode', { mode: 'plan' as const }],
    ['model', { model: 'qwen-max' }],
    ['workdir', { workdir: 'D:\\other' }],
    ['fullAccess', { fullAccess: true }],
    ['toolApproval', { toolApproval: true }],
    ['agentId', { agentId: 'agent-2' }],
    ['groupId', { groupId: 'group-1' }],
    ['channel', { channel: 'feishu' }],
    ['readonly', { readonly: true }],
  ])('改 %s 算改过元数据', (_label, patch) => {
    expect(
      sessionMetaChanged(pickSyncFields(session()), pickSyncFields(session(patch))),
    ).toBe(true);
  });

  it('技能挂载按顺序比较（顺序会影响注入顺序）', () => {
    const a = session({ skillIds: ['x', 'y'] });
    const b = session({ skillIds: ['y', 'x'] });

    expect(sessionMetaChanged(pickSyncFields(a), pickSyncFields(b))).toBe(true);
  });

  it('`undefined` 与 `[]` 不是同一份声明（跟随默认 vs 显式一个都不挂）', () => {
    expect(
      sessionMetaChanged(pickSyncFields(session()), pickSyncFields(session({ skillIds: [] }))),
    ).toBe(true);
  });

  it('无从比较（prev 缺失）时保守判为有变化', () => {
    expect(sessionMetaChanged(undefined, pickSyncFields(session()))).toBe(true);
  });
});

describe('sessionSyncPatch / withSessionSync', () => {
  it('没变时返回空补丁，且 withSessionSync 原样返回同一个对象', () => {
    const prev = session({ rev: 5, updatedBy: 'dev-a' });
    const next = { ...prev, updatedAt: '2026-09-25T02:00:00.000Z' };

    expect(sessionSyncPatch(prev, next)).toEqual({});
    // 同引用很重要：`set` 里换引用会让整棵会话列表白重渲染一次
    expect(withSessionSync(prev, next)).toBe(next);
  });

  it('变了则 rev 在既有值上递增', () => {
    const prev = session({ rev: 5 });
    const next = { ...prev, title: '新标题' };

    expect(sessionSyncPatch(prev, next, '2026-09-25T03:00:00.000Z')).toEqual({
      rev: 6,
      updatedBy: expect.anything(),
    });
  });

  it('老会话（从未写过元数据）首次改动得到 rev = 1，而不是 0', () => {
    // rev = 0 是**保留值**（「迁移前的老数据、从未被改写过」），首次改动必须离开它
    const prev = session();
    const next = { ...prev, pinned: true };

    expect(sessionSyncPatch(prev, next).rev).toBe(1);
  });

  it('新建会话得到 rev = 1，且走的是 sessionCreatePatch 而非改动路径', () => {
    expect(sessionCreatePatch().rev).toBe(1);
  });
});
