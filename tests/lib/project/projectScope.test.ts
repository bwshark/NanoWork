/**
 * 项目归属投影（FR-12.7）：三条判据 + 一条「不许造第二份真相」的反向护栏。
 */

import { describe, expect, it } from 'vitest';

import {
  artifactsOfProject,
  projectExists,
  sessionsOfProject,
  tasksOfProject,
} from '@/lib/project/projectScope';
import type { ArtifactIndexEntry, Session, TaskConfig } from '@/types';

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    agentId: '',
    title: '会话',
    messages: [],
    permissionLog: [],
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
    ...over,
  };
}

function task(over: Partial<TaskConfig> = {}): TaskConfig {
  return {
    id: 't1',
    name: '任务',
    schedule: { kind: 'interval', minutes: 60 },
    prompt: 'p',
    agentId: '',
    status: 'enabled',
    createdAt: '2026-10-31T00:00:00Z',
    ...over,
  };
}

function entry(over: Partial<ArtifactIndexEntry> = {}): ArtifactIndexEntry {
  return {
    id: 'a1',
    sessionId: 's1',
    type: 'markdown',
    contentHash: 'sha256:00',
    createdAt: '2026-10-31T00:00:00Z',
    rev: 1,
    updatedAt: '2026-10-31T00:00:00Z',
    updatedBy: '',
    deletedAt: null,
    version: 1,
    ...over,
  };
}

describe('sessionsOfProject', () => {
  it('只取该项目的会话，按 updatedAt 倒序', () => {
    const list = [
      session({ id: 's1', projectId: 'p1', updatedAt: '2026-10-31T01:00:00Z' }),
      session({ id: 's2', projectId: 'p2', updatedAt: '2026-10-31T02:00:00Z' }),
      session({ id: 's3', projectId: 'p1', updatedAt: '2026-10-31T03:00:00Z' }),
      session({ id: 's4', updatedAt: '2026-10-31T04:00:00Z' }),
    ];
    expect(sessionsOfProject(list, 'p1').map((s) => s.id)).toEqual(['s3', 's1']);
  });

  it('墓碑不进看板', () => {
    const list = [
      session({ id: 's1', projectId: 'p1' }),
      { ...session({ id: 's2', projectId: 'p1' }), deletedAt: '2026-10-31T00:00:00Z' } as Session,
    ];
    expect(sessionsOfProject(list, 'p1').map((s) => s.id)).toEqual(['s1']);
  });

  it('空 projectId / 空列表返回空数组（不抛错）', () => {
    expect(sessionsOfProject(undefined, 'p1')).toEqual([]);
    expect(sessionsOfProject([session()], '')).toEqual([]);
  });
});

describe('tasksOfProject', () => {
  it('任务自己存 projectId（它可以不属于任何会话）', () => {
    const list = [
      task({ id: 't1', projectId: 'p1' }),
      task({ id: 't2', projectId: 'p2' }),
      task({ id: 't3' }),
    ];
    expect(tasksOfProject(list, 'p1').map((t) => t.id)).toEqual(['t1']);
  });

  it('墓碑任务不算', () => {
    const list = [task({ id: 't1', projectId: 'p1', deletedAt: '2026-10-31T00:00:00Z' })];
    expect(tasksOfProject(list, 'p1')).toEqual([]);
  });
});

describe('artifactsOfProject：归属派生，不读产物上的字段', () => {
  it('产物 → 会话 → 项目', () => {
    const sessions = [
      session({ id: 's1', projectId: 'p1' }),
      session({ id: 's2', projectId: 'p2' }),
    ];
    const entries = [entry({ id: 'a1', sessionId: 's1' }), entry({ id: 'a2', sessionId: 's2' })];
    expect(artifactsOfProject(sessions, entries, 'p1').map((e) => e.id)).toEqual(['a1']);
  });

  it('会话被删 → 它的产物从项目里消失（不是「悬空挂在项目里」）', () => {
    const sessions = [session({ id: 's1', projectId: 'p1' })];
    const entries = [entry({ id: 'a1', sessionId: 's1' })];
    // 会话不存在（被彻底删除）时，它名下的产物解不出项目
    expect(artifactsOfProject([], entries, 'p1')).toEqual([]);
    expect(artifactsOfProject(sessions, entries, 'p1').map((e) => e.id)).toEqual(['a1']);
  });

  it('墓碑产物不算', () => {
    const sessions = [session({ id: 's1', projectId: 'p1' })];
    const entries = [entry({ id: 'a1', sessionId: 's1', deletedAt: '2026-10-31T00:00:00Z' })];
    expect(artifactsOfProject(sessions, entries, 'p1')).toEqual([]);
  });

  it('⛔ 产物上多写一个 projectId 不会改变结果（反证「不许造第二份真相」）', () => {
    const sessions = [session({ id: 's1', projectId: 'p1' })];
    // 故意在产物上塞一个指向 p2 的归属字段：派生投影必须无视它
    const entries = [
      entry({ id: 'a1', sessionId: 's1', ...({ projectId: 'p2' } as object) } as ArtifactIndexEntry),
    ];
    expect(artifactsOfProject(sessions, entries, 'p1').map((e) => e.id)).toEqual(['a1']);
    expect(artifactsOfProject(sessions, entries, 'p2')).toEqual([]);
  });
});

describe('projectExists：悬空引用要如实说「不存在」', () => {
  it('项目被删后 projectId 仍是字符串，但 exists 为假', () => {
    expect(projectExists([{ id: 'p1' }], 'p1')).toBe(true);
    expect(projectExists([{ id: 'p2' }], 'p1')).toBe(false);
  });

  it('项目列表还没加载（undefined）时保守返回假', () => {
    // 不能把「还没拉到」当成「不存在」，但也绝不能返回 true —— 调用方据此显示
    // 「项目已不存在」这句话时必须真的知道它不存在。所以这里选择「不知道 = 假」，
    // 由调用方用 `projects` 是否已加载来区分这两件事。
    expect(projectExists(undefined, 'p1')).toBe(false);
  });

  it('没有 projectId 一律假', () => {
    expect(projectExists([{ id: 'p1' }], undefined)).toBe(false);
    expect(projectExists([{ id: 'p1' }], '')).toBe(false);
  });
});
