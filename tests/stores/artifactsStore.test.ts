import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 镜像（`<userData>/artifact-index/<id>.json`）的两个调用点必须被断言到：
 * 它们是**唯一**能证明「Electron 端真的落盘了」的地方，而 Web 端是 no-op——
 * 所以用 spy 替换 `platform.artifactIndex`，而不是真的去写盘。
 */
const { putSpy, removeSpy } = vi.hoisted(() => ({
  putSpy: vi.fn(async () => undefined),
  removeSpy: vi.fn(async () => undefined),
}));

vi.mock('@/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform')>();
  return {
    ...actual,
    platform: { ...actual.platform, artifactIndex: { put: putSpy, remove: removeSpy } },
  };
});

import { useArtifactsStore } from '@/stores/artifactsStore';
import { artifactContentHash } from '@/lib/artifactIndex';
import { contentHash } from '@/lib/contentHash';
import type { Artifact } from '@/types';

function art(over: Partial<Artifact> & { id: string }): Artifact {
  const { id, ...rest } = over;
  return { type: 'code', content: 'x', createdAt: '2026-09-29T00:00:00.000Z', ...rest, id };
}

beforeEach(() => {
  putSpy.mockClear();
  removeSpy.mockClear();
  // 必须连 bodies 一起清空：recordArtifact 会往 bodies 写正文，
  // 不清会跨用例串扰（同内容在后续用例被误判成已去重）。
  useArtifactsStore.setState({ bySession: {}, index: {}, bodies: {} });
});

describe('recordArtifact：写索引（J-B1）', () => {
  it('索引条目带 sessionId / messageId / contentHash', () => {
    const a = art({ id: 'a1', content: 'hello' });
    useArtifactsStore.getState().recordArtifact('s1', 'm1', a);

    const entry = useArtifactsStore.getState().index.a1;
    expect(entry).toMatchObject({
      id: 'a1',
      sessionId: 's1',
      messageId: 'm1',
      contentHash: contentHash('hello'),
    });
    expect(Object.keys(useArtifactsStore.getState().bySession)).toEqual(['s1']);
  });

  it('镜像 put 被调用一次（J-C1）', () => {
    useArtifactsStore.getState().recordArtifact('s1', 'm1', art({ id: 'a1' }));
    expect(putSpy).toHaveBeenCalledTimes(1);
  });
});

describe('入库去重（J-B2 / J-B3）', () => {
  it('同会话内重复内容不入库：bySession 与 index 都不新增', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'same' }));
    s.recordArtifact('s1', 'm2', art({ id: 'a2', content: 'same' }));

    const state = useArtifactsStore.getState();
    expect(state.bySession.s1).toHaveLength(1);
    expect(Object.keys(state.index)).toEqual(['a1']);
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it('跨会话同内容仍各记一条（跨会话检索要能回答「哪些会话产出过它」）', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'same' }));
    s.recordArtifact('s2', 'm2', art({ id: 'a2', content: 'same' }));

    const state = useArtifactsStore.getState();
    expect(Object.keys(state.index)).toHaveLength(2);
    expect(state.index.a1.contentHash).toBe(state.index.a2.contentHash);
    expect(state.index.a2.sessionId).toBe('s2');
  });

  it('同一个 id 重放不重复入库（既有行为保留）', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'one' }));
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'two' }));
    expect(Object.keys(useArtifactsStore.getState().index)).toEqual(['a1']);
  });
});

describe('clearSession / clearAll（J-C2）', () => {
  it('清会话带走该会话的索引条目 + 逐个 remove', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'one' }));
    s.recordArtifact('s1', 'm2', art({ id: 'a2', content: 'two' }));
    s.recordArtifact('s2', 'm3', art({ id: 'a3', content: 'three' }));

    useArtifactsStore.getState().clearSession('s1');
    const state = useArtifactsStore.getState();
    expect(Object.keys(state.index)).toEqual(['a3']);
    expect(state.bySession.s1).toBeUndefined();
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledWith('a1');
    expect(removeSpy).toHaveBeenCalledWith('a2');
  });

  it('clearAll 清干净并逐个 remove', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'one' }));
    s.recordArtifact('s2', 'm2', art({ id: 'a2', content: 'two' }));

    useArtifactsStore.getState().clearAll();
    expect(useArtifactsStore.getState().index).toEqual({});
    expect(useArtifactsStore.getState().bySession).toEqual({});
    expect(removeSpy).toHaveBeenCalledTimes(2);
  });
});

describe('持久化（J-B4）', () => {
  it('index 进 partialize：与 bySession 一起落盘', () => {
    const state = useArtifactsStore.getState();
    state.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'one' }));

    // partialize 决定写盘内容；索引不在其中的话重启后内容还在而索引空了
    const persisted = useArtifactsStore.persist.getOptions().partialize?.(
      useArtifactsStore.getState(),
    ) as { index?: unknown; bodies?: unknown };
    expect(persisted).toBeTruthy();
    expect(Object.keys(persisted.index ?? {})).toEqual(['a1']);
    // 正文池也必须进 partialize：否则重启后索引在、正文丢
    expect(Object.keys(persisted.bodies ?? {})).toEqual([contentHash('one')]);
  });
});

describe('彻底去重：内容池 bodies（D1 / J-A1~A4）', () => {
  it('recordArtifact 把正文按 hash 只存一份进 bodies，bySession 只留引用（content 清空）', () => {
    useArtifactsStore.getState().recordArtifact('s1', 'm1', art({ id: 'a1', content: 'hello' }));
    const state = useArtifactsStore.getState();
    expect(state.bodies[contentHash('hello')]).toBe('hello');
    expect(state.bySession.s1[0].content).toBe('');
  });

  it('同内容跨会话只占 bodies 一个 key（D1 核心收益：正文不重复存储）', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'dup' }));
    s.recordArtifact('s2', 'm2', art({ id: 'a2', content: 'dup' }));
    expect(Object.keys(useArtifactsStore.getState().bodies)).toEqual([contentHash('dup')]);
  });

  it('空正文（image / video）不入 bodies', () => {
    useArtifactsStore.getState().recordArtifact('s1', 'm1', art({ id: 'a1', type: 'image', content: '' }));
    expect(useArtifactsStore.getState().bodies).toEqual({});
    expect(useArtifactsStore.getState().bySession.s1[0].content).toBe('');
  });

  it('clearSession 不清 bodies：同 hash 可能被其它会话引用，误删会让对方正文消失', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'shared' }));
    s.recordArtifact('s2', 'm2', art({ id: 'a2', content: 'shared' }));
    useArtifactsStore.getState().clearSession('s1');
    // s2 仍引用 shared：bodies 必须留着
    expect(useArtifactsStore.getState().bodies[contentHash('shared')]).toBe('shared');
    expect(useArtifactsStore.getState().index.a2).toBeTruthy();
  });

  it('clearAll 清 bodies（J-A4）', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'one' }));
    s.recordArtifact('s2', 'm2', art({ id: 'a2', content: 'two' }));
    useArtifactsStore.getState().clearAll();
    expect(useArtifactsStore.getState().bodies).toEqual({});
  });
});

describe('FR-7.4 版本链', () => {
  it('同 id 内容变化 → 升版本；previousVersion 指旧 hash；versions 增长；两版正文都在 bodies', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'v1' }));
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'v2' })); // 同 id 不同内容

    const e = useArtifactsStore.getState().index.a1;
    expect(e.version).toBe(2);
    expect(e.previousVersion).toBe(contentHash('v1'));
    expect(e.contentHash).toBe(contentHash('v2'));
    expect(e.versions).toHaveLength(2);
    expect(useArtifactsStore.getState().bodies[contentHash('v1')]).toBe('v1');
    expect(useArtifactsStore.getState().bodies[contentHash('v2')]).toBe('v2');
  });

  it('同 id 同内容重放不升版本（标题变化则同步更新、不污染版本链）', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'v1' }));
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'v1', title: '刷新标题' }));

    const e = useArtifactsStore.getState().index.a1;
    expect(e.version).toBe(1); // 不升版
    expect(e.title).toBe('刷新标题'); // 但标题同步
    expect(e.versions).toHaveLength(1);
  });

  it('recordArtifactVersion：用户编辑新内容升一版', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'v1' }));
    s.recordArtifactVersion('a1', art({ id: 'a1', content: 'v2-edited' }));

    const e = useArtifactsStore.getState().index.a1;
    expect(e.version).toBe(2);
    expect(e.contentHash).toBe(contentHash('v2-edited'));
    expect(e.previousVersion).toBe(contentHash('v1'));
  });

  it('rollbackToVersion：恢复旧正文并新开一版（旧正文仍在 bodies）', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'v1' }));
    s.recordArtifact('s1', 'm1', art({ id: 'a1', content: 'v2' }));
    s.rollbackToVersion('a1', contentHash('v1')); // 回退到 v1 正文

    const e = useArtifactsStore.getState().index.a1;
    expect(e.version).toBe(3);
    expect(e.contentHash).toBe(contentHash('v1'));
    expect(e.previousVersion).toBe(contentHash('v2'));
    expect(useArtifactsStore.getState().bodies[contentHash('v1')]).toBe('v1');
  });

  it('rollbackToVersion：正文不在 bodies（图片不进池）→ 不回退', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', art({ id: 'a1', type: 'image', content: '', url: 'http://x/1.png' }));
    s.rollbackToVersion('a1', 'sha256:missing');
    // 没崩、版本不变
    expect(useArtifactsStore.getState().index.a1.version).toBe(1);
  });
});

describe('merge 迁移（D2）：旧 bySession 内联正文搬进 bodies', () => {
  it('旧数据（bySession 带 content、无 bodies）升级时搬到 bodies 并补索引条目、原位置置空', () => {
    const merge = useArtifactsStore.persist.getOptions().merge!;
    const current = useArtifactsStore.getState();
    const merged = merge(
      {
        bySession: { s1: [art({ id: 'legacy', content: 'old body' })] },
        index: {},
        bodies: {},
      },
      current,
    ) as unknown as ReturnType<typeof useArtifactsStore.getState>;

    expect(merged.bodies[artifactContentHash(art({ id: 'legacy', content: 'old body' }))]).toBe('old body');
    expect(merged.index.legacy).toBeTruthy();
    expect(merged.bySession.s1[0].content).toBe('');
  });

  it('无旧内联正文的数据迁移后保持不变', () => {
    const merge = useArtifactsStore.persist.getOptions().merge!;
    const current = useArtifactsStore.getState();
    const merged = merge(
      { bySession: { s1: [art({ id: 'ref', content: '' })] }, index: { ref: {} as never }, bodies: {} },
      current,
    ) as unknown as ReturnType<typeof useArtifactsStore.getState>;
    expect(merged.bodies).toEqual({});
    expect(merged.bySession.s1[0].content).toBe('');
  });
});
