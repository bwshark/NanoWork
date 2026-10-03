/**
 * 记忆页的**事实视图**（`src/pages/memory/FactListView.tsx`）。
 *
 * 这一层是用户唯一能「看到系统记住了什么、并且动手治理」的地方，所以测试围绕三件事：
 *
 * 1. **看得见**：`curated.json` 里的 active 修订出现在页面上，含 memoryKey / revision /
 *    证据条数——「系统记住了什么」不再是只能靠模型复述来猜。
 * 2. **管得动**：停用 / 恢复 / 删除都真的落到 canonical（经过二次确认），
 *    且**删除留域级墓碑**（否则用户删掉的东西会被下一次蒸馏写回来）。
 * 3. **裁决得了**：待裁决案件列出候选，提交后案件关闭、结论换成挑战者
 *    （选 incumbent 时**不产生新修订**）。
 *
 * ## 数据一律走**真实写入路径**
 *
 * 事实用 `appendFact` 写、案件用 `distill` 生成，而不是手搓一份 `conflicts.json`。
 * 手搓夹具会在裁决时被 `evidenceFingerprint` 校验拦下（「证据已变化，请重看候选」）——
 * 那个校验是对的，但它意味着**手搓的夹具测不到真实的裁决链路**。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { FactListView } from '@/pages/memory/FactListView';
import { platformMemoryIo, workspaceMemoryRef } from '@/lib/memoryPlatformIo';
import { workspaceIdFor } from '@/lib/memoryPaths';
import { createMemoryStore } from '@/lib/memoryStore';
import type { ConflictState, CuratedEntry } from '@/types';
import { buttonByText, click, flush, mount, unmount } from './helpers/reactMount';

const WORKDIR = null; // 没有工作目录 → 落兜底目录，测试里最好控制
const WS = workspaceIdFor(WORKDIR);
/** 夹具时间：40 天前（过 30 天门槛）与门槛内的更晚时刻 */
const OLD = '2026-08-23T00:00:00.000Z';
const OLD_LATER = '2026-08-26T00:00:00.000Z';
const NOW = new Date('2026-10-02T00:00:00.000Z');

function io() {
  return platformMemoryIo(workspaceMemoryRef(WORKDIR));
}

function store() {
  return createMemoryStore({ io: io(), workspaceId: WS });
}

async function reset(): Promise<void> {
  for (const name of [
    'curated.json',
    'conflicts.json',
    'MEMORY.md',
    'profile.json',
    'preferences.json',
    'conflict-adjudications.jsonl',
    'conflict-resolution-transactions.jsonl',
    '2026-08-23.jsonl',
    '2026-08-26.jsonl',
  ]) {
    await io().remove(name).catch(() => undefined);
    await io().remove(name, 'daily').catch(() => undefined);
  }
}

async function readCurated() {
  return store().loadCuratedState();
}

async function readConflicts(): Promise<ConflictState> {
  const raw = await io().read('conflicts.json');
  return raw === null
    ? { schema: 2, workspaceId: WS, cases: [], renderedAt: NOW.toISOString() }
    : (JSON.parse(raw) as ConflictState);
}

/** 造一条 active 结论（真实路径：写事实 → 蒸馏） */
async function seedActiveConclusion(): Promise<void> {
  await store().appendFact(
    {
      workspaceId: WS,
      kind: 'decision',
      content: '用 SQLite WAL 模式',
      importance: 4,
      memoryKey: 'storage.db',
      observedAt: OLD,
      evidence: 'a',
    },
    NOW,
  );
  await store().distill(NOW);
}

/**
 * 造一个**同分冲突案件**：两个挑战者各自两条独立证据、重要度与最新时间都相同
 * → `distill` fail-closed 建案，incumbent 保持不动。
 */
async function seedTieCase(): Promise<void> {
  const rows: Array<[string, string]> = [
    ['用 Postgres', 'x'],
    ['用 Postgres', 'y'],
    ['用 MySQL', 'z'],
    ['用 MySQL', 'w'],
  ];
  for (const [content, evidence] of rows) {
    await store().appendFact(
      {
        workspaceId: WS,
        kind: 'decision',
        content,
        importance: 4,
        memoryKey: 'storage.db',
        observedAt: OLD_LATER,
        evidence,
      },
      NOW,
    );
  }
  await store().distill(NOW);
}

function host(): HTMLElement {
  return mount(
    <FactListView scope="workspace" workdir={WORKDIR} reloadToken={0} onChanged={() => undefined} />,
  );
}

/** 点开二次确认对话框里的确认按钮 */
function confirmInDialog(label: string): void {
  const dialogs = document.querySelectorAll('[role="dialog"]');
  expect(dialogs.length).toBeGreaterThan(0);
  click(buttonByText(dialogs[dialogs.length - 1] as HTMLElement, label));
}

beforeEach(async () => {
  unmount();
  await reset();
});

describe('事实视图：看得见', () => {
  it('列出 active 修订，并显示 memoryKey / revision / 证据条数', async () => {
    await seedActiveConclusion();
    const el = host();
    await flush();

    expect(el.textContent).toContain('用 SQLite WAL 模式');
    expect(el.textContent).toContain('storage.db');
    expect(el.textContent).toContain('r1');
    expect(el.textContent).toContain('证据 1 条');
    expect(el.textContent).toContain('生效中的结论（1）');
  });

  it('展示落点与蒸馏门槛（用户要知道「它存在哪、什么时候提炼」）', async () => {
    await seedActiveConclusion();
    const el = host();
    await flush();
    expect(el.textContent).toContain('落点：');
    expect(el.textContent).toContain('蒸馏门槛');
  });

  it('没有结论时给出可操作的说明，而不是空白', async () => {
    const el = host();
    await flush();
    expect(el.textContent).toContain('还没有蒸馏出的结论');
  });

  it('候选**不进**生效列表（只有 active 才注入）', async () => {
    await seedActiveConclusion();
    await seedTieCase();
    const el = host();
    await flush();
    expect(el.textContent).toContain('生效中的结论（1）');
    expect(el.textContent).toContain('待裁决（1）');
  });
});

describe('事实视图：管得动', () => {
  it('停用需要二次确认，确认后落到 canonical', async () => {
    await seedActiveConclusion();
    const el = host();
    await flush();

    click(buttonByText(el, '停用'));
    await flush();
    expect((await readCurated()).revisions[0].status).toBe('active');

    confirmInDialog('停用');
    await flush();
    await flush();
    expect((await readCurated()).revisions[0].status).toBe('disabled');
  });

  it('删除留**域级墓碑**，且再次蒸馏不会把域写回来', async () => {
    await seedActiveConclusion();
    const el = host();
    await flush();

    click(buttonByText(el, '删除'));
    await flush();
    confirmInDialog('删除');
    await flush();
    await flush();

    const after = await readCurated();
    expect(after.revisions.some((r) => r.entryKey === 'k:storage.db')).toBe(false);
    expect(after.revisions.some((r) => r.entryKey.startsWith('x:'))).toBe(true);

    await store().distill(NOW);
    expect((await readCurated()).revisions.some((r) => r.entryKey === 'k:storage.db')).toBe(false);
  });

  it('已停用的修订可以恢复', async () => {
    await seedActiveConclusion();
    const first = host();
    await flush();
    click(buttonByText(first, '停用'));
    await flush();
    confirmInDialog('停用');
    await flush();
    await flush();
    expect((await readCurated()).revisions[0].status).toBe('disabled');

    unmount();
    const second = host();
    await flush();
    click(buttonByText(second, '恢复'));
    await flush();
    await flush();
    expect((await readCurated()).revisions[0].status).toBe('active');
  });
});

describe('事实视图：裁决得了', () => {
  it('列出待裁决案件与它的候选（含各自证据条数）', async () => {
    await seedActiveConclusion();
    await seedTieCase();
    const el = host();
    await flush();

    expect(el.textContent).toContain('待裁决（1）');
    expect(el.textContent).toContain('用 Postgres');
    expect(el.textContent).toContain('冲突域 storage.db');
    expect(el.textContent).toContain('证据 2 条');
  });

  it('未选候选时提交按钮不可用（不给「无候选的裁决」留口子）', async () => {
    await seedActiveConclusion();
    await seedTieCase();
    const el = host();
    await flush();
    expect((buttonByText(el, '提交裁决') as HTMLButtonElement).disabled).toBe(true);
  });

  it('incumbent 也在候选里（否则「保持现状」根本没法选）', async () => {
    await seedActiveConclusion();
    await seedTieCase();
    const el = host();
    await flush();
    // 三个候选：incumbent（当前生效的）+ 两个挑战者
    expect(el.textContent).toContain('用 SQLite WAL 模式');
    expect(el.textContent).toContain('用 Postgres');
    expect(el.textContent).toContain('用 MySQL');
  });

  it('选挑战者 + 填理由 → 结论换成挑战者、案件关闭、审计留痕', async () => {
    await seedActiveConclusion();
    await seedTieCase();
    const el = host();
    await flush();


    click(buttonByText(el, '用 Postgres'));
    await flush();
    expect((buttonByText(el, '提交裁决') as HTMLButtonElement).disabled).toBe(false);

    // 理由输入框：MUI TextField 默认渲染成 `<input>`，取第一个非占位之外的 input
    const rationale =
      (el.querySelector('input[placeholder^="裁决理由"]') as HTMLInputElement | null) ??
      (el.querySelector('textarea[placeholder^="裁决理由"]') as HTMLTextAreaElement | null) ??
      (Array.from(el.querySelectorAll('input')).find((i) => i.placeholder.includes('裁决理由')) as
        | HTMLInputElement
        | undefined) ??
      null;
    expect(rationale).toBeTruthy();
    const isTextarea = rationale?.tagName === 'TEXTAREA';
    const proto = isTextarea
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(rationale, '生产要 Postgres 扩展');
    rationale?.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    click(buttonByText(el, '提交裁决'));
    await flush();
    await flush();

    const active = (await readCurated())
      .revisions.filter((r) => r.status === 'active')
      .map((r) => r.content);
    expect(active).toContain('用 Postgres');
    expect(active).not.toContain('用 SQLite WAL 模式');

    const conflicts = await readConflicts();
    expect(conflicts.cases[0].status).toBe('resolved');
    expect(conflicts.cases[0].resolution?.rationale).toBe('生产要 Postgres 扩展');
    expect(await store().loadAdjudications()).toHaveLength(1);
  });

  it('选 incumbent（保持现状）→ **不产生新修订**，但案件关闭', async () => {
    await seedActiveConclusion();
    await seedTieCase();
    const before = await readCurated();

    const el = host();
    await flush();
    // 选当前生效的那一项 = 保持现状
    click(buttonByText(el, '用 SQLite WAL 模式'));
    await flush();
    click(buttonByText(el, '提交裁决'));
    await flush();
    await flush();

    const after = await readCurated();
    expect(after.revisions).toHaveLength(before.revisions.length);
    expect(after.revisions.map((r) => r.revision)).toEqual(before.revisions.map((r) => r.revision));
    const conflicts = await readConflicts();
    expect(conflicts.cases[0].status).toBe('resolved');
    expect(conflicts.cases[0].resolution?.resultEntryKey).toBe('k:storage.db');
  });
});

describe('事实视图：域级墓碑的展示', () => {
  it('删除后的域显示为「已被删除的域」而不是一个空条目', async () => {
    await seedActiveConclusion();
    const entry = (await readCurated()).revisions[0] as CuratedEntry;
    await store().remove(entry.entryKey, '不再适用', NOW);

    const el = host();
    await flush();
    expect(el.textContent).toContain('已被删除的域');
    expect(el.textContent).toContain('不再适用');
  });
});
