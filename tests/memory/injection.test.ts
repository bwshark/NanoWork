/**
 * 有界注入（`src/lib/memory/memoryInjection.ts`）。需求 FR-M10 / NFR-M6。
 *
 * 这一层要证的是三件事，每件都对应 v1 的一个真实缺陷：
 *
 * 1. **只有该进的进**：`superseded` / `disabled` 修订与冲突候选**永不进 prompt**——
 *    否则用户会看到两个互相矛盾的值（或者一个已经被他自己删掉的结论）。
 * 2. **有预算且可观察**：超限按确定优先级裁剪，`truncated` 如实计数。
 *    注入量**不随日志天数增长**——日志只能通过「最近 N 条事实」这一个窗口进来。
 * 3. **legacy 不丢**：v1 的 Markdown 正文继续进 prompt（最低优先级），
 *    这是「升级后它以前记得的事就不记得了」的唯一防线。
 */

import { describe, expect, it } from 'vitest';
import type { CuratedEntry, MemoryFact, PreferenceRecord } from '../../src/types';
import {
  DEFAULT_INJECTION_BUDGET,
  buildInjectionBlock,
  composeInjectionSections,
  profileToLines,
  provenanceLine,
} from '../../src/lib/memory/memoryInjection';
import { INJECTION_HEADINGS } from '../../src/lib/memory/memoryInjectionContract';

const OLD = '2026-08-23T00:00:00.000Z';
const RECENT = '2026-10-01T00:00:00.000Z';

function revision(over: Partial<CuratedEntry> = {}): CuratedEntry {
  return {
    entryKey: 'k:a',
    memoryKey: 'a',
    kind: 'decision',
    revision: 1,
    status: 'active',
    content: '用 SQLite WAL 模式',
    importance: 4,
    evidenceIds: ['f_1'],
    evidenceCount: 1,
    firstSeen: OLD,
    lastSeen: OLD,
    ...over,
  };
}

function fact(content: string, over: Partial<MemoryFact> = {}): MemoryFact {
  return {
    factId: `f_${content.length}`,
    workspaceId: 'w_test',
    kind: 'decision',
    content,
    importance: 4,
    source: 'agent',
    origin: 'memory-save',
    observedAt: RECENT,
    schema: 2,
    ...over,
  };
}

function pref(key: string, value: string): PreferenceRecord {
  return { key, value, revision: 1, source: 'user', updatedAt: RECENT };
}

describe('只注入该注入的（I8）', () => {
  it('只收 active 修订', () => {
    const block = buildInjectionBlock({
      profile: {},
      preferences: [],
      userCurated: [],
      workspaceCurated: [
        revision({ status: 'active', content: '还在生效' }),
        revision({ entryKey: 'k:b', memoryKey: 'b', status: 'superseded', content: '已被替代' }),
        revision({ entryKey: 'k:c', memoryKey: 'c', status: 'disabled', content: '已被停用' }),
      ],
      recentFacts: [],
    });
    expect(block.text).toContain('还在生效');
    expect(block.text).not.toContain('已被替代');
    expect(block.text).not.toContain('已被停用');
  });

  it('域级墓碑（content 为空）不产生空行', () => {
    const block = buildInjectionBlock({
      profile: {},
      preferences: [],
      userCurated: [],
      workspaceCurated: [
        revision({ entryKey: 'x:k:a', status: 'disabled', content: '', deletedAt: RECENT }),
      ],
      recentFacts: [],
    });
    expect(block.text.trim()).toBe('');
    expect(block.entries).toBe(0);
  });

  it('两段都空时正文为空串（调用方据此不产注入块）', () => {
    const block = buildInjectionBlock({
      profile: {},
      preferences: [],
      userCurated: [],
      workspaceCurated: [],
      recentFacts: [],
    });
    expect(block.text).toBe('');
    expect(block.entries).toBe(0);
    expect(block.truncated).toBe(0);
  });

  it('用户级与工作区级各自成段，顺序固定（用户级在前）', () => {
    const block = buildInjectionBlock({
      profile: { name: '老王' },
      preferences: [pref('response.language', 'Chinese')],
      userCurated: [],
      workspaceCurated: [revision()],
      recentFacts: [],
    });
    const userIdx = block.text.indexOf(INJECTION_HEADINGS.user);
    const wsIdx = block.text.indexOf(INJECTION_HEADINGS.workspace);
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(wsIdx).toBeGreaterThan(userIdx);
  });

  it('只有一层有内容时照样带标题（让模型看得出适用边界）', () => {
    const onlyWorkspace = buildInjectionBlock({
      profile: {},
      preferences: [],
      userCurated: [],
      workspaceCurated: [revision()],
      recentFacts: [],
    });
    expect(onlyWorkspace.text).toContain(INJECTION_HEADINGS.workspace);
    expect(onlyWorkspace.text).not.toContain(INJECTION_HEADINGS.user);

    const onlyUser = buildInjectionBlock({
      profile: { name: '老王' },
      preferences: [],
      userCurated: [],
      workspaceCurated: [],
      recentFacts: [],
    });
    expect(onlyUser.text).toContain(INJECTION_HEADINGS.user);
    expect(onlyUser.text).not.toContain(INJECTION_HEADINGS.workspace);
  });
});

describe('画像与偏好', () => {
  it('画像字段翻成可读标签', () => {
    expect(profileToLines({ name: '老王', timezone: 'UTC+8' })).toEqual([
      '- 姓名: 老王',
      '- 时区: UTC+8',
    ]);
  });

  it('空值字段不产生行', () => {
    expect(profileToLines({ name: '', timezone: '   ' })).toEqual([]);
  });

  it('偏好以 `key`: value 形态出现（可追溯这条偏好回答哪个问题）', () => {
    const block = buildInjectionBlock({
      profile: {},
      preferences: [pref('response.language', 'Chinese')],
      userCurated: [],
      workspaceCurated: [],
      recentFacts: [],
    });
    expect(block.text).toContain('`response.language`: Chinese');
  });
});

describe('预算与截断（NFR-M6）', () => {
  it('超预算时按重要度优先保留，并如实计数 truncated', () => {
    const block = buildInjectionBlock(
      {
        profile: {},
        preferences: [],
        userCurated: [],
        workspaceCurated: [
          revision({ entryKey: 'k:low', memoryKey: 'low', content: '低'.repeat(50), importance: 1 }),
          revision({ entryKey: 'k:high', memoryKey: 'high', content: '高'.repeat(50), importance: 5 }),
        ],
        recentFacts: [],
      },
      { userChars: 0, workspaceChars: 70, recentFactLimit: 0 },
    );
    expect(block.text).toContain('高');
    expect(block.text).not.toContain('低');
    expect(block.truncated).toBe(1);
  });

  it('同重要度时按时间新的优先', () => {
    const block = buildInjectionBlock(
      {
        profile: {},
        preferences: [],
        userCurated: [],
        workspaceCurated: [
          revision({ entryKey: 'k:old', memoryKey: 'old', content: '旧的'.repeat(20), lastSeen: OLD }),
          revision({
            entryKey: 'k:new',
            memoryKey: 'new',
            content: '新的'.repeat(20),
            lastSeen: RECENT,
          }),
        ],
        recentFacts: [],
      },
      { userChars: 0, workspaceChars: 80, recentFactLimit: 0 },
    );
    expect(block.text).toContain('新的');
    expect(block.text).not.toContain('旧的');
  });

  it('预算足够时全装下，truncated 为 0', () => {
    const block = buildInjectionBlock(
      {
        profile: {},
        preferences: [],
        userCurated: [],
        workspaceCurated: [revision({ content: '短' })],
        recentFacts: [],
      },
      DEFAULT_INJECTION_BUDGET,
    );
    expect(block.truncated).toBe(0);
    expect(block.entries).toBe(1);
  });

  it('最近事实的重要度被折价（它们只是「刚发生」，不是「已确认」）', () => {
    const block = buildInjectionBlock(
      {
        profile: {},
        preferences: [],
        userCurated: [],
        workspaceCurated: [
          revision({
            entryKey: 'k:curated',
            memoryKey: 'curated',
            content: '长期结论'.repeat(10),
            importance: 4,
          }),
        ],
        recentFacts: [fact('刚刚发生'.repeat(10), { importance: 5 })],
      },
      // 预算只够一条：折价后 5-3=2 < 4，所以长期结论先留、近期事实被截
      { userChars: 0, workspaceChars: 70, recentFactLimit: 6 },
    );
    expect(block.text).toContain('长期结论');
    expect(block.text).not.toContain('刚刚发生');
    expect(block.truncated).toBe(1);
  });

  it('确定性：同输入两次调用结果逐字节相同', () => {
    const inputs = {
      profile: { name: '老王' },
      preferences: [pref('a.b', '1'), pref('a.c', '2')],
      userCurated: [revision({ entryKey: 'k:u', memoryKey: 'u', content: '用户级结论' })],
      workspaceCurated: [revision({ content: '工作区结论' })],
      recentFacts: [fact('一条事实')],
    };
    expect(buildInjectionBlock(inputs).text).toBe(buildInjectionBlock(inputs).text);
  });
});

describe('legacy 必须继续进 prompt（FR-M3 / FR-M10 的互斥修复）', () => {
  it('用户级 legacy 正文出现在用户级段', () => {
    const block = buildInjectionBlock({
      profile: {},
      preferences: [],
      userCurated: [],
      workspaceCurated: [],
      recentFacts: [],
      userLegacyText: '我是明明，20 岁',
    });
    expect(block.text).toContain('我是明明，20 岁');
    expect(block.text).toContain(INJECTION_HEADINGS.user);
  });

  it('工作区级 legacy 正文出现在工作区级段，且排在策展结论**之后**', () => {
    const block = buildInjectionBlock({
      profile: {},
      preferences: [],
      userCurated: [],
      workspaceCurated: [revision({ content: '结论在前' })],
      recentFacts: [],
      workspaceLegacyText: '历史记录在后',
    });
    const curatedIdx = block.text.indexOf('结论在前');
    const legacyIdx = block.text.indexOf('历史记录在后');
    expect(curatedIdx).toBeGreaterThanOrEqual(0);
    expect(legacyIdx).toBeGreaterThan(curatedIdx);
  });

  it('预算足够时 legacy 与策展结论共存（「条目集合不减少」的可执行判据）', () => {
    const withoutLegacy = buildInjectionBlock({
      profile: {},
      preferences: [],
      userCurated: [],
      workspaceCurated: [revision({ content: '结论' })],
      recentFacts: [],
    });
    const withLegacy = buildInjectionBlock({
      profile: {},
      preferences: [],
      userCurated: [],
      workspaceCurated: [revision({ content: '结论' })],
      recentFacts: [],
      workspaceLegacyText: 'v1 的老内容',
    });
    expect(withLegacy.text).toContain('结论');
    expect(withLegacy.text).toContain('v1 的老内容');
    expect(withLegacy.entries).toBeGreaterThanOrEqual(withoutLegacy.entries);
  });

  it('预算装不下 legacy 时被计入 truncated（不静默丢）', () => {
    const block = buildInjectionBlock(
      {
        profile: {},
        preferences: [],
        userCurated: [],
        workspaceCurated: [revision({ content: '结论' })],
        recentFacts: [],
        workspaceLegacyText: '很长的历史内容'.repeat(50),
      },
      { userChars: 0, workspaceChars: 40, recentFactLimit: 0 },
    );
    expect(block.text).not.toContain('很长的历史内容');
    expect(block.truncated).toBe(1);
  });
});

describe('合成与 provenance', () => {
  it('composeInjectionSections 的定序与 v1 一致（用户级在前）', () => {
    const text = composeInjectionSections('用户内容', '工作区内容');
    expect(text.indexOf(INJECTION_HEADINGS.user)).toBeLessThan(
      text.indexOf(INJECTION_HEADINGS.workspace),
    );
  });

  it('composeInjectionSections 跳过空段', () => {
    expect(composeInjectionSections('', '工作区内容')).not.toContain(INJECTION_HEADINGS.user);
    expect(composeInjectionSections('用户内容', '')).not.toContain(INJECTION_HEADINGS.workspace);
  });

  it('provenanceLine 带上 scope / workspace / 计数（可追溯注入了哪个快照）', () => {
    const line = provenanceLine({
      userScope: 'u_x',
      workspaceId: 'w_y',
      capturedAt: RECENT,
      entries: 3,
      truncated: 1,
    });
    expect(line).toContain('user_scope=u_x');
    expect(line).toContain('workspace_id=w_y');
    expect(line).toContain('entries=3');
    expect(line).toContain('truncated=1');
  });
});
