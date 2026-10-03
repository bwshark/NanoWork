/**
 * 保留、归档与导出（`src/lib/memoryArchive.ts` / `src/lib/memoryBundle.ts`）。需求 FR-M33 / FR-M35。
 *
 * 归档这一组要证的是**三个概念没有混在一起**：
 * - `archiveAfterDays`（日志**文件**级，默认 180 天）决定哪些日文件移出扫描范围；
 * - `retentionDays`（**事实**年龄门槛，默认 30 天）仍然照常工作，不受归档影响；
 * - 归档**不是删除**：移动过去的文件仍然可读、可审计。
 *
 * 导出这一组要证的是**跨作用域导入被拒绝**——把 A 项目的结论导进 B 项目是最难排查的
 * 一类污染（它看起来完全正常）。
 */

import { describe, expect, it } from 'vitest';
import type { AdjudicationEvent, MemoryFact, ProfileState, PreferenceState, CuratedState } from '../src/types';
import { DEFAULT_ARCHIVE_POLICY, dayOfFactLogFile, listArchivedFactLogs, runArchive } from '../src/lib/memoryArchive';
import type { MemoryStoreIo } from '../src/lib/memoryStore';
import { emptyCuratedState } from '../src/lib/memoryDistill';
import { emptyConflictState } from '../src/lib/memoryAdjudicate';
import { createMemoryStore } from '../src/lib/memoryStore';
import { renderCuratedProjection } from '../src/lib/memoryProject';
import {
  MEMORY_BUNDLE_SCHEMA,
  MemoryBundleError,
  buildExportBundle,
  parseExportBundle,
  serializeExportBundle,
} from '../src/lib/memoryBundle';

const NOW = new Date('2026-10-02T00:00:00Z');

/** 最小的内存端口 */
class MemIo implements MemoryStoreIo {
  files = new Map<string, string>();
  private k(name: string, subdir?: string): string {
    return subdir ? `${subdir}/${name}` : name;
  }
  async list(subdir?: string): Promise<string[]> {
    const prefix = subdir ? `${subdir}/` : '';
    return [...this.files.keys()]
      .filter((key) => (subdir ? key.startsWith(prefix) : !key.includes('/')))
      .map((key) => (subdir ? key.slice(prefix.length) : key))
      .sort();
  }
  async read(name: string, subdir?: string): Promise<string | null> {
    return this.files.get(this.k(name, subdir)) ?? null;
  }
  async replace(name: string, content: string, subdir?: string): Promise<void> {
    this.files.set(this.k(name, subdir), content);
  }
  async write(name: string, content: string, subdir?: string): Promise<void> {
    this.files.set(this.k(name, subdir), content);
  }
  async appendLine(name: string, line: string, subdir?: string): Promise<void> {
    const key = this.k(name, subdir);
    this.files.set(key, `${this.files.get(key) ?? ''}${line}\n`);
  }
  async readLines(name: string, subdir?: string): Promise<string[]> {
    return ((await this.read(name, subdir)) ?? '').split('\n').filter(Boolean);
  }
  async remove(name: string, subdir?: string): Promise<void> {
    this.files.delete(this.k(name, subdir));
  }
}

function fact(observedAt: string, content = 'x'): MemoryFact {
  return {
    factId: `f_${content.length}_${observedAt.length}`,
    workspaceId: 'w_test',
    kind: 'decision',
    content,
    importance: 4,
    source: 'agent',
    origin: 'sediment',
    observedAt,
    schema: 2,
  };
}

describe('归档：文件名与日界', () => {
  it('日期文件名解析出当天 UTC 零点；非日期名返回 null', () => {
    expect(dayOfFactLogFile('2026-09-19.jsonl')?.toISOString()).toBe('2026-09-19T00:00:00.000Z');
    expect(dayOfFactLogFile('notes.jsonl')).toBeNull();
    expect(dayOfFactLogFile('2026-09-19.md')).toBeNull();
  });
});

describe('归档：只动过期的日志文件', () => {
  it('超过 archiveAfterDays 的文件被移入 archive/，且内容仍在（不是删除）', async () => {
    const io = new MemIo();
    await io.appendLine('2026-01-01.jsonl', JSON.stringify(fact('2026-01-01T00:00:00.000Z', '老')), 'daily');
    await io.appendLine('2026-09-25.jsonl', JSON.stringify(fact('2026-09-25T00:00:00.000Z', '新')), 'daily');

    const result = await runArchive(io, NOW);
    expect(result.archived).toEqual(['2026-01-01.jsonl']);
    // 归档目录里能读到原文
    const archived = await io.read('2026-01-01.jsonl', 'archive');
    expect(archived).toContain('老');
    // daily 里没了
    expect(await io.read('2026-01-01.jsonl', 'daily')).toBeNull();
    // 新的还在 daily
    expect(await io.read('2026-09-25.jsonl', 'daily')).toContain('新');
  });

  it('返回结果里区分 archived / kept 与移动行数（可观察）', async () => {
    const io = new MemIo();
    for (const f of ['2026-01-01.jsonl', '2026-01-02.jsonl']) {
      await io.appendLine(f, JSON.stringify(fact(`${f.slice(0, 10)}T00:00:00.000Z`)), 'daily');
    }
    const result = await runArchive(io, NOW);
    expect(result.archived).toHaveLength(2);
    expect(result.movedLines).toBe(2);
    expect(result.kept).toEqual([]);
  });

  it('**文件里还有年轻事实时整份留下**（晚到的事实不该被归档带走）', async () => {
    const io = new MemIo();
    // 文件名很老，但里面的 observedAt 很新（补录 / 时钟回拨 / 跨时区写入都可能）
    await io.appendLine(
      '2026-01-01.jsonl',
      JSON.stringify({ ...fact('2026-01-01T00:00:00.000Z'), observedAt: '2026-09-30T00:00:00.000Z' }),
      'daily',
    );
    const result = await runArchive(io, NOW, DEFAULT_ARCHIVE_POLICY, (line) => JSON.parse(line) as MemoryFact);
    expect(result.archived).toEqual([]);
    expect(result.kept).toEqual(['2026-01-01.jsonl']);
    expect(await io.read('2026-01-01.jsonl', 'daily')).not.toBeNull();
  });

  it('关闭 verifyFactAge 时按文件名整份归档（性能优先的显式取舍）', async () => {
    const io = new MemIo();
    await io.appendLine(
      '2026-01-01.jsonl',
      JSON.stringify({ ...fact('2026-01-01T00:00:00.000Z'), observedAt: '2026-09-30T00:00:00.000Z' }),
      'daily',
    );
    const result = await runArchive(io, NOW, { archiveAfterDays: 180, verifyFactAge: false });
    expect(result.archived).toEqual(['2026-01-01.jsonl']);
  });

  it('空日志文件也归档（留着只会让每次蒸馏多一次无意义的读）', async () => {
    const io = new MemIo();
    await io.write('2026-01-01.jsonl', '', 'daily');
    const result = await runArchive(io, NOW);
    expect(result.archived).toEqual(['2026-01-01.jsonl']);
    expect(await io.read('2026-01-01.jsonl', 'daily')).toBeNull();
  });

  it('归档阈值可配：把阈值调小就能归档更近的文件', async () => {
    const io = new MemIo();
    await io.appendLine('2026-09-01.jsonl', JSON.stringify(fact('2026-09-01T00:00:00.000Z')), 'daily');
    expect((await runArchive(io, NOW)).archived).toEqual([]);
    const aggressive = await runArchive(io, NOW, { archiveAfterDays: 7, verifyFactAge: false });
    expect(aggressive.archived).toEqual(['2026-09-01.jsonl']);
  });

  it('非日期文件名不被认领（不是我们的日志就不碰）', async () => {
    const io = new MemIo();
    await io.appendLine('notes.jsonl', 'x', 'daily');
    const result = await runArchive(io, NOW);
    expect(result.archived).toEqual([]);
    expect(await io.read('notes.jsonl', 'daily')).toBe('x\n');
  });

  it('listArchivedFactLogs 只列归档目录里的日期日志', async () => {
    const io = new MemIo();
    await io.write('2026-01-01.jsonl', 'a\n', 'archive');
    await io.write('notes.jsonl', 'b\n', 'archive');
    expect(await listArchivedFactLogs(io)).toEqual(['2026-01-01.jsonl']);
  });

  it('归档是幂等的：跑两次第二次无事可做', async () => {
    const io = new MemIo();
    await io.appendLine('2026-01-01.jsonl', JSON.stringify(fact('2026-01-01T00:00:00.000Z')), 'daily');
    await runArchive(io, NOW);
    const again = await runArchive(io, NOW);
    expect(again.archived).toEqual([]);
    expect(again.movedLines).toBe(0);
  });
});

describe('导出 bundle：组装与序列化', () => {
  const baseInput = () => ({
    workspaceId: 'w_test',
    userScope: 'u_test',
    facts: [fact('2026-08-23T00:00:00.000Z', '用 SQLite')],
    curated: emptyCuratedState('w_test', NOW),
    conflicts: emptyConflictState('w_test', NOW),
    adjudications: [] as AdjudicationEvent[],
    profile: { schema: 2, userScope: 'u_test', profile: { name: '老王' }, updatedAt: NOW.toISOString() } as ProfileState,
    preferences: { schema: 2, userScope: 'u_test', records: [], updatedAt: NOW.toISOString() } as PreferenceState,
    now: NOW,
  });

  it('带上 schema / 时间 / 归属与全部 canonical 内容', () => {
    const bundle = buildExportBundle(baseInput());
    expect(bundle.schema).toBe(MEMORY_BUNDLE_SCHEMA);
    expect(bundle.exportedAt).toBe(NOW.toISOString());
    expect(bundle.workspaceId).toBe('w_test');
    expect(bundle.userScope).toBe('u_test');
    expect(bundle.facts).toHaveLength(1);
    expect(bundle.profile.profile.name).toBe('老王');
  });

  it('复制事实与审计数组（bundle 交出后不受调用方后续改动影响）', () => {
    const input = baseInput();
    const bundle = buildExportBundle(input);
    input.facts.push(fact('2026-08-24T00:00:00.000Z', 'y'));
    expect(bundle.facts).toHaveLength(1);
  });

  it('序列化后可被自己解析回来（往返一致）', () => {
    const bundle = buildExportBundle(baseInput());
    const roundTrip = parseExportBundle(serializeExportBundle(bundle), {
      workspaceId: 'w_test',
      userScope: 'u_test',
    });
    expect(roundTrip).toEqual(bundle);
  });
});

describe('导入 bundle：跨作用域必须拒绝', () => {  const serialize = (over: Record<string, unknown> = {}) =>
    serializeExportBundle({
      ...buildExportBundle({
        workspaceId: 'w_a',
        userScope: 'u_a',
        facts: [],
        curated: emptyCuratedState('w_a', NOW),
        conflicts: emptyConflictState('w_a', NOW),
        adjudications: [],
        profile: { schema: 2, userScope: 'u_a', profile: {}, updatedAt: NOW.toISOString() },
        preferences: { schema: 2, userScope: 'u_a', records: [], updatedAt: NOW.toISOString() },
        now: NOW,
      }),
      ...over,
    } as never);

  it('workstation 不符 → 拒绝（跨项目污染比「导不进来」难查得多）', () => {
    expect(() => parseExportBundle(serialize(), { workspaceId: 'w_b' })).toThrow(/工作区/);
  });

  it('userScope 不符 → 拒绝（跨用户泄漏）', () => {
    expect(() => parseExportBundle(serialize(), { userScope: 'u_b' })).toThrow(/用户作用域/);
  });

  it('相符时通过', () => {
    const bundle = parseExportBundle(serialize(), { workspaceId: 'w_a', userScope: 'u_a' });
    expect(bundle.workspaceId).toBe('w_a');
  });

  it('不是 JSON → 明确报错（用户可能选错文件）', () => {
    expect(() => parseExportBundle('not json', {})).toThrow(/不是合法的 JSON/);
  });

  it('顶层不是对象 → 拒绝', () => {
    expect(() => parseExportBundle('[]', {})).toThrow(/顶层必须是一个对象/);
  });

  it('schema 不认识 → 拒绝（升版时必须显式处理，不能当成兼容）', () => {
    expect(() => parseExportBundle(serialize({ schema: 99 }), {})).toThrow(/只认识/);
  });

  it('缺少数组字段 → 拒绝（半截写入 / 手工编辑过）', () => {
    expect(() => parseExportBundle(serialize({ facts: undefined }), {})).toThrow(/facts/);
    expect(() => parseExportBundle(serialize({ adjudications: undefined }), {})).toThrow(/adjudications/);
  });

  it('缺少归属字段 → 拒绝', () => {
    expect(() => parseExportBundle(serialize({ workspaceId: undefined }), {})).toThrow(/workspaceId/);
    expect(() => parseExportBundle(serialize({ userScope: undefined }), {})).toThrow(/userScope/);
  });
});

describe('导入：仓储侧语义（FR-M35 / M4-03）', () => {
  const WS = 'w_test';

  async function freshStore(): Promise<{ store: ReturnType<typeof createMemoryStore>; io: MemIo }> {
    const memIo = new MemIo();
    // **带上 renderProjection**：不带它 `distill` / `rebuildProjection` 会静默早退，
    // 于是「导入后投影被重建」这条用例会因为「压根没渲染」而失败——那正是
    // `memoryEdit.ts` 踩过的坑（见 architecture-memory-v2.md §13.2）。
    const store = createMemoryStore({
      io: memIo,
      workspaceId: WS,
      renderProjection: renderCuratedProjection,
    });
    return { store, io: memIo };
  }

  function bundleWith(facts: MemoryFact[], curated: CuratedState) {
    return buildExportBundle({
      workspaceId: WS,
      userScope: WS,
      facts,
      curated,
      conflicts: emptyConflictState(WS, NOW),
      adjudications: [],
      profile: { schema: 2, userScope: WS, profile: {}, updatedAt: NOW.toISOString() },
      preferences: { schema: 2, userScope: WS, records: [], updatedAt: NOW.toISOString() },
      now: NOW,
    });
  }

  it('作用域不符 → 拒绝（仓储自己也校验一遍，防调用方绕过 parse）', async () => {
    const { store } = await freshStore();
    const foreign = { ...bundleWith([], emptyCuratedState('w_other', NOW)), workspaceId: 'w_other' };
    await expect(store.importBundle(foreign, NOW)).rejects.toThrow(/拒绝导入/);
  });

  it('事实照进，且标 origin=import', async () => {
    const { store } = await freshStore();
    const result = await store.importBundle(
      bundleWith([fact('2026-08-23T00:00:00.000Z', '用 SQLite')], emptyCuratedState(WS, NOW)),
      NOW,
    );
    expect(result.factsImported).toBe(1);
    const facts = await store.loadFacts(null, NOW);
    expect(facts).toHaveLength(1);
    expect(facts[0].origin).toBe('import');
    expect(facts[0].content).toBe('用 SQLite');
  });

  it('**保留原始 observedAt**：导入的旧事实不该再等 30 天才生效', async () => {
    const { store } = await freshStore();
    await store.importBundle(
      bundleWith([fact('2026-08-23T00:00:00.000Z', '用 SQLite')], emptyCuratedState(WS, NOW)),
      NOW,
    );
    const facts = await store.loadFacts(null, NOW);
    expect(facts[0].observedAt).toBe('2026-08-23T00:00:00.000Z');
    // 并且它确实按本地策略晋升成了结论
    const state = await store.loadCuratedState();
    expect(state.revisions.filter((r) => r.status === 'active').map((r) => r.content)).toContain(
      '用 SQLite',
    );
  });

  it('重复导入同一条事实不产生两份（按 factId 去重）', async () => {
    const { store } = await freshStore();
    const bundle = bundleWith([fact('2026-08-23T00:00:00.000Z', '用 SQLite')], emptyCuratedState(WS, NOW));
    expect((await store.importBundle(bundle, NOW)).factsImported).toBe(1);
    expect((await store.importBundle(bundle, NOW)).factsImported).toBe(0);
    expect(await store.loadFacts(null, NOW)).toHaveLength(1);
  });

  it('本地为空时采用 bundle 的结论', async () => {
    const { store } = await freshStore();
    const incoming = emptyCuratedState(WS, NOW);
    incoming.revisions.push({
      entryKey: 'k:storage.db',
      memoryKey: 'storage.db',
      kind: 'decision',
      revision: 1,
      status: 'active',
      content: '用 Postgres',
      importance: 4,
      evidenceIds: ['f_x'],
      evidenceCount: 1,
      firstSeen: NOW.toISOString(),
      lastSeen: NOW.toISOString(),
    });
    const result = await store.importBundle(bundleWith([], incoming), NOW);
    expect(result.curatedAdopted).toBe(true);
    const state = await store.loadCuratedState();
    expect(state.revisions.filter((r) => r.status === 'active').map((r) => r.content)).toContain(
      '用 Postgres',
    );
  });

  it('**本地已有 active 结论时不覆盖**：bundle 结论被跳过，只作为证据进入', async () => {
    const { store } = await freshStore();
    // 本地先有一条自己蒸馏出来的结论
    await store.appendFact(
      {
        workspaceId: WS,
        kind: 'decision',
        content: '用 SQLite',
        importance: 4,
        memoryKey: 'storage.db',
        observedAt: '2026-08-23T00:00:00.000Z',
        evidence: 'a',
      },
      NOW,
    );
    await store.distill(NOW);

    const incoming = emptyCuratedState(WS, NOW);
    incoming.revisions.push({
      entryKey: 'k:storage.db',
      memoryKey: 'storage.db',
      kind: 'decision',
      revision: 1,
      status: 'active',
      content: '用 Postgres（来自另一台机器）',
      importance: 4,
      evidenceIds: ['f_x'],
      evidenceCount: 1,
      firstSeen: NOW.toISOString(),
      lastSeen: NOW.toISOString(),
    });

    const result = await store.importBundle(bundleWith([], incoming), NOW);
    expect(result.curatedAdopted).toBe(false);
    expect(result.curatedSkipped).toBe(1);
    // 本地结论仍然生效——导入不是判断谁对的场合
    const actives = (await store.loadCuratedState())
      .revisions.filter((r) => r.status === 'active')
      .map((r) => r.content);
    expect(actives).toContain('用 SQLite');
    expect(actives).not.toContain('用 Postgres（来自另一台机器）');
  });

  it('导入后投影被重建（用户立刻能在文件里看到）', async () => {
    const { store, io } = await freshStore();
    await store.importBundle(
      bundleWith([fact('2026-08-23T00:00:00.000Z', '用 SQLite')], emptyCuratedState(WS, NOW)),
      NOW,
    );
    expect(await io.read('MEMORY.md')).toContain('用 SQLite');
  });

  it('单条坏事实不让整次导入失败', async () => {
    const { store } = await freshStore();
    const bad = { ...fact('2026-08-23T00:00:00.000Z', '坏'), observedAt: 'not-a-date' };
    const result = await store.importBundle(
      bundleWith([bad as MemoryFact, fact('2026-08-24T00:00:00.000Z', '好')], emptyCuratedState(WS, NOW)),
      NOW,
    );
    // 坏的那条被跳过，好的那条进来了
    expect(result.factsImported).toBe(1);
  });
});
