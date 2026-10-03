/**
 * 「手编 `MEMORY.md` 算权威」的完整链路（`src/lib/memoryManual.ts` + `src/lib/memoryEdit.ts`）。
 *
 * 这组用例要证的是**一条用户看得见的行为**：
 *
 * > 我在记忆页手写一条规则，保存后它**不会**在下次蒸馏重建投影时消失。
 *
 * 拆成四件事：
 * 1. **挑得准**：只把「正文段落」当候选（标题、引用块、分隔线、超长段落都不算）；
 * 2. **不重复**：已经登记过的内容不会被再登记一遍（归一化后比对）；
 * 3. **进得去**：手编段落变成 `origin: 'manual'` 的事实，并落进 daily 日志；
 * 4. **活下来**：再蒸馏一次、甚至把文件删掉重跑，那条规则仍然在投影里。
 */

import { describe, expect, it } from 'vitest';
import {
  MANUAL_FACT_IMPORTANCE,
  extractNewManualParagraphs,
  isEligibleManualParagraph,
  manualParagraphToFactInput,
} from '../src/lib/memoryManual';
import { applyManualMemoryEdit, workspaceStoreFor } from '../src/lib/memoryEdit';
import { platformMemoryIo, workspaceMemoryRef } from '../src/lib/memoryPlatformIo';
import type { CuratedEntry } from '../src/types';

const NOW = new Date('2026-10-02T00:00:00Z');
const WORKDIR = null;

function entry(content: string, over: Partial<CuratedEntry> = {}): CuratedEntry {
  return {
    entryKey: 'd:convention:x',
    memoryKey: 'd:convention:x',
    kind: 'convention',
    revision: 1,
    status: 'active',
    content,
    importance: 4,
    evidenceIds: ['f_1'],
    evidenceCount: 1,
    firstSeen: NOW.toISOString(),
    lastSeen: NOW.toISOString(),
    ...over,
  };
}

async function reset(): Promise<void> {
  const io = platformMemoryIo(workspaceMemoryRef(WORKDIR));
  for (const name of [
    'curated.json',
    'conflicts.json',
    'MEMORY.md',
    'conflict-adjudications.jsonl',
    'conflict-resolution-transactions.jsonl',
  ]) {
    await io.remove(name).catch(() => undefined);
  }
  const daily = await io.list('daily').catch(() => [] as string[]);
  for (const name of daily) await io.remove(name, 'daily').catch(() => undefined);
}

describe('挑得准：哪些段落算「手编内容」', () => {
  it('排除标题 / 引用块 / 分隔线 / 空段', () => {
    expect(isEligibleManualParagraph('# 这个项目的长期记忆')).toBe(false);
    // 引用块由 `extractNewManualParagraphs` 在**切分时**按原始块排除
    // （`parseEntryBodies` 会剥掉 `> `，剥完就分不出来了），此处只验模板说明句
    expect(isEligibleManualParagraph('（以下偏好已过期，不再注入，保留以备查）')).toBe(false);
    expect(isEligibleManualParagraph('---')).toBe(false);
    expect(isEligibleManualParagraph('   ')).toBe(false);
    expect(isEligibleManualParagraph('')).toBe(false);
  });

  it('排除超长段落（免得一次粘贴让整次保存报错）', () => {
    expect(isEligibleManualParagraph('x'.repeat(2001))).toBe(false);
    expect(isEligibleManualParagraph('x'.repeat(2000))).toBe(true);
  });

  it('收下正常的结论句', () => {
    expect(isEligibleManualParagraph('本项目不要引入 ORM')).toBe(true);
  });
});

describe('不重复：与 canonical 比对', () => {
  it('canonical 里已有（归一化后相同）的段落不再登记', () => {
    const known = [entry('本项目不要引入 ORM')];
    const saved = ['# 项目约定', '', '本项目，不要引入 ORM！', '', '新增的一条规则'].join('\n');
    // 标点与换行不同也算同一条（归一化判据）
    expect(extractNewManualParagraphs(saved, known)).toEqual(['新增的一条规则']);
  });

  it('同一次保存里的重复段落只登记一次', () => {
    const saved = ['同一条规则', '', '同一条规则！'].join('\n');
    expect(extractNewManualParagraphs(saved, [])).toEqual(['同一条规则']);
  });

  it('标题与引用块不进候选', () => {
    const saved = ['# 标题', '', '> 说明句', '', '真正的规则'].join('\n');
    expect(extractNewManualParagraphs(saved, [])).toEqual(['真正的规则']);
  });

  it('canonical 为空时全部正文段落都算新', () => {
    const saved = ['第一条', '', '第二条'].join('\n');
    expect(extractNewManualParagraphs(saved, [])).toEqual(['第一条', '第二条']);
  });

  it('段落内的连续空行被折叠（否则下次解析会拆成两条）', () => {
    const saved = '一条\n\n\n含空行的段落';
    const out = extractNewManualParagraphs(saved, []);
    expect(out).toEqual(['一条', '含空行的段落']);
    expect(out.join('')).not.toContain('\n\n');
  });

  it('即使已 superseded / disabled 也算「登记过」', () => {
    const known = [entry('旧规则', { status: 'superseded' }), entry('停用规则', { status: 'disabled' })];
    expect(extractNewManualParagraphs('旧规则\n\n停用规则', known)).toEqual([]);
  });
});

describe('进得去：手编段落变成事实', () => {
  it('手工事实的形态固定：kind=convention、origin=manual、source=user', () => {
    const input = manualParagraphToFactInput('本项目不要引入 ORM', 'w_x', NOW.toISOString());
    expect(input.kind).toBe('convention');
    expect(input.origin).toBe('manual');
    expect(input.source).toBe('user');
    expect(input.importance).toBe(MANUAL_FACT_IMPORTANCE);
    expect(input.evidence).toContain('manual-edit');
    // 刻意**不设** memoryKey：手编时用户面对的是正文，替他猜键会在改写措辞时变成另一个域
    expect('memoryKey' in input).toBe(false);
  });

  it('保存后手编段落落进 daily 事实日志', async () => {
    await reset();
    const saved = ['# 项目约定', '', '本项目不要引入 ORM'].join('\n');
    const result = await applyManualMemoryEdit(WORKDIR, saved, NOW);
    expect(result.registered).toBe(1);
    expect(result.distilled).toBe(true);

    const io = platformMemoryIo(workspaceMemoryRef(WORKDIR));
    const daily = await io.list('daily');
    const facts = await workspaceStoreFor(WORKDIR).loadFacts(null, NOW);
    expect(daily.length).toBeGreaterThan(0);
    expect(facts.map((f) => f.content)).toContain('本项目不要引入 ORM');
    expect(facts[0].origin).toBe('manual');
  });

  it('第二次保存同样的内容不再登记（归一化去重）', async () => {
    await reset();
    await applyManualMemoryEdit(WORKDIR, '本项目不要引入 ORM', NOW);
    const again = await applyManualMemoryEdit(WORKDIR, '本项目不要引入 ORM！', NOW);
    expect(again.registered).toBe(0);
  });

  it('空内容保存不报错，也不登记任何事实', async () => {
    await reset();
    const result = await applyManualMemoryEdit(WORKDIR, '   \n  ', NOW);
    expect(result.registered).toBe(0);
    expect(result.distilled).toBe(true);
  });
});

describe('活下来：手编内容不会被蒸馏重建吃掉', () => {
  it('**核心行为**：手编规则在 distill 重建投影后仍然在文件里', async () => {
    await reset();
    const saved = ['# 项目约定', '', '本项目不要引入 ORM'].join('\n');
    // ⚠️ 刻意**不传** `observedAt`：记忆页的「保存」就是这个调用形态
    // （`MemoryPage` 传 `new Date()`）。手编豁免年龄门槛（`isAgeExempt`），
    // 所以「今天写下」也必须活下来——这正是曾经的缺陷点。
    await applyManualMemoryEdit(WORKDIR, saved, NOW);

    const io = platformMemoryIo(workspaceMemoryRef(WORKDIR));
    // 保存后文件里当然是用户写的
    expect(await io.read('MEMORY.md')).toContain('本项目不要引入 ORM');

    // 再蒸馏一次（模拟「下次会话结束时的自动沉淀」）——投影被重建
    await workspaceStoreFor(WORKDIR).distill(NOW);
    const after = await io.read('MEMORY.md');
    expect(after).toContain('本项目不要引入 ORM');
  });

  it('手工删掉投影文件后，重建仍能把它渲回来（canonical 才是权威）', async () => {
    await reset();
    await applyManualMemoryEdit(WORKDIR, '本项目不要引入 ORM', NOW, '2026-08-23T00:00:00.000Z');
    const io = platformMemoryIo(workspaceMemoryRef(WORKDIR));
    await io.remove('MEMORY.md');

    const rebuilt = await workspaceStoreFor(WORKDIR).rebuildProjection(NOW);
    expect(rebuilt).toContain('本项目不要引入 ORM');
  });

  it('年龄门槛对手编不适用：当天写下的内容立即成为 active 结论', async () => {
    await reset();
    // observedAt = NOW，按 **模型沉淀** 的口径不满 30 天；但手编豁免年龄门槛，
    // 否则「保存 → 内容当场消失」——见 `memoryDistill.ts` 的 `isAgeExempt`。
    const result = await applyManualMemoryEdit(WORKDIR, '今天刚写的规则', NOW);
    expect(result.registered).toBe(1);
    const state = await workspaceStoreFor(WORKDIR).loadCuratedState();
    const active = state.revisions.filter((r) => r.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].content).toBe('今天刚写的规则');

    // 证据同样在：手编段落进了 daily 日志（不只是结论层）
    const facts = await workspaceStoreFor(WORKDIR).loadFacts(null, NOW);
    expect(facts.map((f) => f.content)).toContain('今天刚写的规则');

    // 代价是「投影里看得见」——这才是用户判据
    const io = platformMemoryIo(workspaceMemoryRef(WORKDIR));
    expect(await io.read('MEMORY.md')).toContain('今天刚写的规则');
  });

  it('蒸馏失败不影响保存本身（内容已落盘）', async () => {
    await reset();
    const io = platformMemoryIo(workspaceMemoryRef(WORKDIR));
    // 把 canonical 写坏 → 蒸馏会抛错，但保存应当已经完成
    await io.replace('curated.json', '{ 坏 JSON');
    const result = await applyManualMemoryEdit(WORKDIR, '一条规则', NOW);
    expect(result.distilled).toBe(false);
    expect(result.distillError).toBeTruthy();
    // 文件仍然写着用户的内容（保存没有被回滚）
    expect(await io.read('MEMORY.md')).toContain('一条规则');
  });
});
