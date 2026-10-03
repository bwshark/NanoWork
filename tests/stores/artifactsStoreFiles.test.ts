import { beforeEach, describe, expect, it } from 'vitest';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { fileArtifactId, findFileArtifact, toFileViews } from '@/lib/fileArtifact';
import { artifactContentHash } from '@/lib/artifactIndex';
import type { Artifact } from '@/types';

/** 造一条文件产物（`id` 走真实派生规则，保证与运行时一致） */
function fileArt(
  sessionId: string,
  path: string,
  over: Partial<Artifact> = {},
): Artifact {
  return {
    id: fileArtifactId(sessionId, path),
    type: 'file',
    title: path.split('/').pop() ?? path,
    content: '',
    path,
    change: 'created',
    createdAt: '2026-09-29T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  useArtifactsStore.setState({ bySession: {}, index: {}, bodies: {}, indexTombstones: {} });
});

describe('文件产物：以路径为身份（会话内）', () => {
  it('同会话同路径再写一次 → 升一版而不是新增一条', () => {
    const s = useArtifactsStore.getState();
    const first = fileArt('s1', 'D:/aa/tetris.html', { content: '<html>v1</html>', size: 14 });
    s.recordArtifact('s1', 'm1', first);
    s.recordArtifact('s1', 'm2', { ...first, content: '<html>v2</html>', size: 14, change: 'modified' });

    const state = useArtifactsStore.getState();
    expect(state.bySession.s1).toHaveLength(1); // 列表里仍只有这一个文件
    const entry = state.index[first.id];
    expect(entry.version).toBe(2);
    expect(entry.versions).toHaveLength(2);
    expect(entry.previousVersion).toBe(artifactContentHash(first));
    // 两版正文都在内容池 → 版本对比 / 回退可用
    expect(Object.keys(state.bodies)).toHaveLength(2);
    expect(state.bodies[entry.contentHash]).toBe('<html>v2</html>');
  });

  it('不同文件内容相同 → 各记一条（不参与按内容的同会话去重）', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', fileArt('s1', 'D:/aa/a.ts', { content: 'export {};' }));
    s.recordArtifact('s1', 'm2', fileArt('s1', 'D:/aa/b.ts', { content: 'export {};' }));

    const state = useArtifactsStore.getState();
    expect(state.bySession.s1).toHaveLength(2);
    expect(Object.keys(state.index)).toHaveLength(2);
    expect(Object.values(state.index).map((e) => e.contentHash)).toEqual([
      artifactContentHash(fileArt('s1', 'D:/aa/a.ts', { content: 'export {};' })),
      artifactContentHash(fileArt('s1', 'D:/aa/b.ts', { content: 'export {};' })),
    ]);
  });

  it('跨会话同路径 → 各记一条，且不串会话（索引的 sessionId 各自正确）', () => {
    const s = useArtifactsStore.getState();
    s.recordArtifact('s1', 'm1', fileArt('s1', 'D:/aa/shared.ts', { content: 'a' }));
    s.recordArtifact('s2', 'm2', fileArt('s2', 'D:/aa/shared.ts', { content: 'b' }));

    const state = useArtifactsStore.getState();
    expect(state.bySession.s1).toHaveLength(1);
    expect(state.bySession.s2).toHaveLength(1);
    expect(state.index[fileArtifactId('s1', 'D:/aa/shared.ts')].sessionId).toBe('s1');
    expect(state.index[fileArtifactId('s2', 'D:/aa/shared.ts')].sessionId).toBe('s2');
  });

  it('改写类工具（无正文、带指纹）：每次改写都推进一版', () => {
    const s = useArtifactsStore.getState();
    const created = fileArt('s1', 'D:/aa/x.ts', { content: 'v1' });
    s.recordArtifact('s1', 'm1', created);
    for (const callId of ['call-1', 'call-2', 'call-3']) {
      s.recordArtifact('s1', 'm1', {
        ...created,
        content: '',
        fingerprint: callId,
        change: 'modified',
        createdAt: '2026-09-29T00:01:00.000Z',
      });
    }

    const state = useArtifactsStore.getState();
    expect(state.bySession.s1).toHaveLength(1);
    expect(state.index[created.id].versions).toHaveLength(4); // v1 + 三次改写
    expect(state.index[created.id].version).toBe(4);
    // 只有首版有正文快照（改写拿不到全文），其余版本不回读磁盘时无正文可对比
    expect(Object.keys(state.bodies)).toHaveLength(1);
  });

  it('同一次改写重放（同指纹）不重复升版', () => {
    const s = useArtifactsStore.getState();
    const created = fileArt('s1', 'D:/aa/x.ts', { content: 'v1' });
    s.recordArtifact('s1', 'm1', created);
    const edit = { ...created, content: '', fingerprint: 'call-1', change: 'modified' as const };
    s.recordArtifact('s1', 'm1', edit);
    s.recordArtifact('s1', 'm1', edit);

    expect(useArtifactsStore.getState().index[created.id].version).toBe(2);
  });

  it('列表视图能算出版本与变更次数（供「查看所有变更」使用）', () => {
    const s = useArtifactsStore.getState();
    const created = fileArt('s1', 'D:/aa/x.ts', { content: 'v1' });
    s.recordArtifact('s1', 'm1', created);
    s.recordArtifact('s1', 'm1', { ...created, content: '', fingerprint: 'call-1', change: 'modified' });

    const state = useArtifactsStore.getState();
    const list = state.bySession.s1;
    const views = toFileViews(list, state.index);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ version: 2, changes: 1 });
    // 路径判重（新建 vs 改写）依赖它：再次写入时能找到既有产物
    expect(findFileArtifact(list, 'D:\\aa\\x.ts')?.id).toBe(created.id);
  });

  it('文件产物不进入按内容折叠的判据：contentHash 由内容决定（同内容会算出同值）', () => {
    // 这条是「跨会话折叠展示」的既有语义，文件产物同样适用：
    // 同内容在产物库里会被折叠成一组，而各自仍是独立的产物条目
    expect(
      artifactContentHash(fileArt('s1', 'D:/a.txt', { content: 'same' })),
    ).toBe(artifactContentHash(fileArt('s2', 'D:/b.txt', { content: 'same' })));
  });
});

describe('removeArtifacts：文件被删掉后收回产物', () => {
  it('摘引用、摘索引、写墓碑，但保留 bodies（同 hash 可能被别的产物引用）', () => {
    const s = useArtifactsStore.getState();
    const a = fileArt('s1', 'D:/aa/tmp.js', { content: 'x', size: 1 });
    s.recordArtifact('s1', 'm1', a);
    const hash = useArtifactsStore.getState().index[a.id].contentHash;

    s.removeArtifacts([a.id]);

    const state = useArtifactsStore.getState();
    expect(state.bySession.s1).toHaveLength(0);
    expect(state.index[a.id]).toBeUndefined();
    // 墓碑 = 删除可跨端传播的凭据（与 clearSession 同款）
    expect(state.indexTombstones[a.id]?.deletedAt).toBeTruthy();
    expect(state.bodies[hash]).toBe('x');
  });

  it('只摘指定产物：同会话里其它文件原样留着', () => {
    const s = useArtifactsStore.getState();
    const doomed = fileArt('s1', 'D:/aa/老脚本.js', { content: 'x' });
    const kept = fileArt('s1', 'D:/aa/snake.html', { content: '<html/>' });
    s.recordArtifact('s1', 'm1', doomed);
    s.recordArtifact('s1', 'm1', kept);

    s.removeArtifacts([doomed.id]);

    const state = useArtifactsStore.getState();
    expect(state.bySession.s1.map((a) => a.id)).toEqual([kept.id]);
    expect(state.index[kept.id]).toBeTruthy();
    expect(state.indexTombstones[kept.id]).toBeUndefined();
  });

  it('空数组是 no-op（不误写墓碑）', () => {
    useArtifactsStore.getState().removeArtifacts([]);
    expect(Object.keys(useArtifactsStore.getState().indexTombstones)).toHaveLength(0);
  });

  it('索引里没有该条目的旧数据也照样摘掉引用切片', () => {
    // 兼容：早期数据的 bySession 可能没有对应 index 条目，只删引用也要删干净
    const a = fileArt('s1', 'D:/aa/legacy.js', { content: 'x' });
    useArtifactsStore.setState({ bySession: { s1: [a] }, index: {}, bodies: {}, indexTombstones: {} });

    useArtifactsStore.getState().removeArtifacts([a.id]);

    const state = useArtifactsStore.getState();
    expect(state.bySession.s1).toHaveLength(0);
    expect(Object.keys(state.indexTombstones)).toHaveLength(0);
  });
});