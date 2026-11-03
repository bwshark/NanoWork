import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { platform } from '@/platform';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { startSelectionRewrite } from '@/lib/artifact/selectionRewriteService';
import type { Artifact } from '@/types';

/**
 * FR-7.5 圈选改写的**接线**契约。
 *
 * 为什么单独一组：`selectionRewrite.ts` 的纯逻辑全绿**不能**证明接上了线
 * ——「函数对但没人调」是本仓反复踩过的静默失效。这里断言的是
 * 「一次改写 → 索引里真的多一版、`bodies` 里真的有新正文、审计真的记了一条」。
 */

/** 造一个可控的假客户端：按 `onToken` 吐给定文本 */
function fakeClient(tokens: string[]) {
  const abort = vi.fn(async () => undefined);
  const chat = vi.fn(async (_req: unknown, handlers: { onToken: (s: string) => void }) => {
    for (const t of tokens) handlers.onToken(t);
  });
  return { client: { kind: 'fake', chat, abort }, chat, abort };
}

const { getClientMock } = vi.hoisted(() => ({ getClientMock: vi.fn() }));

vi.mock('@/ai/connectionManager', () => ({
  connectionManager: { getClient: getClientMock },
}));

function art(over: Partial<Artifact> & { id: string }): Artifact {
  const { id, ...rest } = over;
  return { type: 'code', content: '', createdAt: '2026-11-03T00:00:00.000Z', ...rest, id };
}

let auditSpy: MockInstance<typeof platform.auditAppendApp>;

beforeEach(() => {
  useArtifactsStore.setState({ bySession: {}, bodies: {}, index: {}, indexTombstones: {} });
  auditSpy = vi.spyOn(platform, 'auditAppendApp').mockResolvedValue({ ok: true });
  getClientMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 先把产物入库（走真实 store 动作，拿到 v1 的索引条目） */
function seed(content: string): Artifact {
  const artifact = art({ id: 'a1', content, title: 'main.py' });
  useArtifactsStore.getState().recordArtifact('s1', 'm1', artifact);
  return artifact;
}

describe('startSelectionRewrite', () => {
  it('⛔ 改写成功后索引真的多一版，bodies 里真的有新正文', async () => {
    const src = 'def f():\n    return 1';
    const artifact = seed(src);
    const { client } = fakeClient(['    return 2']);
    getClientMock.mockResolvedValue(client);

    // 用 indexOf 算选区：手算偏移极易错一位，而错位会让断言失败得莫名其妙
    const start = src.indexOf('    return 1');
    const handle = startSelectionRewrite({
      artifact,
      selection: { start, end: start + '    return 1'.length },
      instruction: '把 1 改成 2',
    });
    const result = await handle.result;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(2);
    expect(result.content).toBe('def f():\n    return 2');

    const entry = useArtifactsStore.getState().index['a1'];
    expect(entry.version).toBe(2);
    // 版本链里两版都在（v1 的正文仍留内容池，可回退）
    expect(entry.versions).toHaveLength(2);
    const newHash = entry.contentHash;
    expect(useArtifactsStore.getState().bodies[newHash]).toBe('def f():\n    return 2');
  });

  it('⛔ 与原文相同时不升版（不污染版本链）', async () => {
    const artifact = seed('hello');
    const { client } = fakeClient(['hello']);
    getClientMock.mockResolvedValue(client);

    const result = await startSelectionRewrite({
      artifact,
      selection: { start: 0, end: 5 },
      instruction: '改一下',
    }).result;

    expect(result.ok).toBe(false);
    expect(useArtifactsStore.getState().index['a1'].version).toBe(1);
  });

  it('⛔ 模型报错时不改正文（宁可失败也不能写半截）', async () => {
    const artifact = seed('abc');
    const chat = vi.fn(async (_req: unknown, h: { onToken: (s: string) => void; onError: () => void }) => {
      h.onToken('半截内容');
      h.onError();
    });
    getClientMock.mockResolvedValue({ kind: 'fake', chat, abort: vi.fn() });

    const result = await startSelectionRewrite({
      artifact,
      selection: { start: 0, end: 3 },
      instruction: '改',
    }).result;

    expect(result.ok).toBe(false);
    expect(useArtifactsStore.getState().index['a1'].version).toBe(1);
  });

  it('选区越界直接拒绝，不发起请求', async () => {
    const artifact = seed('abc');
    const { client, chat } = fakeClient(['x']);
    getClientMock.mockResolvedValue(client);

    const result = await startSelectionRewrite({
      artifact,
      selection: { start: 0, end: 99 },
      instruction: '改',
    }).result;

    expect(result.ok).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });

  it('空指令直接拒绝，不发起请求', async () => {
    const artifact = seed('abc');
    const { client, chat } = fakeClient(['x']);
    getClientMock.mockResolvedValue(client);

    const result = await startSelectionRewrite({
      artifact,
      selection: { start: 0, end: 3 },
      instruction: '   ',
    }).result;

    expect(result.ok).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });

  it('取消后结果收敛成 ok:false，且不落库', async () => {
    const artifact = seed('abc');
    let finish: (() => void) | null = null;
    const abort = vi.fn(async () => {
      finish?.();
    });
    const chat = vi.fn(
      async (_req: unknown, h: { onToken: (s: string) => void; onDone: () => void }) =>
        new Promise<void>((resolve) => {
          finish = () => {
            h.onDone();
            resolve();
          };
        }),
    );
    getClientMock.mockResolvedValue({ kind: 'fake', chat, abort });

    const handle = startSelectionRewrite({
      artifact,
      selection: { start: 0, end: 3 },
      instruction: '改',
    });
    // 等 chat 真的被调起来再取消
    await Promise.resolve();
    handle.cancel();
    const result = await handle.result;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('已取消');
    expect(useArtifactsStore.getState().index['a1'].version).toBe(1);
  });

  it('改写成功后留一条审计（含意图与版本号）', async () => {
    const artifact = seed('abc');
    const { client } = fakeClient(['xyz']);
    getClientMock.mockResolvedValue(client);

    const result = await startSelectionRewrite({
      artifact,
      selection: { start: 0, end: 3 },
      instruction: '改成 xyz',
    }).result;
    expect(result.ok).toBe(true);

    const calls = auditSpy.mock.calls as unknown as [string[]][];
    const lines = calls[calls.length - 1][0];
    const record = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(record).toMatchObject({
      action: 'artifact.rewrite',
      targetId: 'a1',
      outcome: 'ok',
    });
    expect((record.detail as Record<string, unknown>).instruction).toBe('改成 xyz');
    expect((record.detail as Record<string, unknown>).version).toBe(2);
  });
});
