/**
 * 记忆 v2 的**可配置策略**（`src/lib/memoryPolicy.ts` + `src/types/memory.ts` 的归一化）。
 * 需求 FR-M5 / FR-M10 / FR-M33；计划任务 M0-09 / M2-10。
 *
 * ## 这组用例守的是什么
 *
 * 用户能在设置页调「多久算稳定结论」「注入预算多大」。这类**数字型配置**有一种特别
 * 安静的坏法：非法值（`"30"` / `-1` / `NaN`）参与日期运算会变成 `NaN`，于是比较
 * `observedAt <= cutoff` 恒为 false——**门槛静默失效**，不报错、不告警、只是
 * 「怎么都不晋升」。所以归一化必须逐字段做「类型 + 区间」双检查，且必须被真正调用。
 *
 * 第二件事：策略必须真的**被用上**。`resolveMemoryPolicy` 存在但没人调用，
 * 表现与「用出厂默认值」完全一样——所以下面有一条端到端用例，用自定义预算驱动
 * `buildInjectionBlock` 并断言产出确实变小。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_POLICY,
  MEMORY_POLICY_LIMITS,
  normalizeMemoryPolicy,
} from '../src/types';
import { resolveMemoryPolicy } from '../src/lib/memoryPolicy';
import { DEFAULT_DISTILL_POLICY } from '../src/lib/memoryDistill';
import { buildInjectionBlock } from '../src/lib/memoryInjection';
import type { CuratedEntry, EntryKey } from '../src/types';

describe('归一化：逐字段类型 + 区间双检查', () => {
  it('缺省 / 非对象 → 出厂默认值', () => {
    expect(normalizeMemoryPolicy(undefined)).toEqual(DEFAULT_MEMORY_POLICY);
    expect(normalizeMemoryPolicy(null)).toEqual(DEFAULT_MEMORY_POLICY);
    expect(normalizeMemoryPolicy('nonsense')).toEqual(DEFAULT_MEMORY_POLICY);
    expect(normalizeMemoryPolicy(42)).toEqual(DEFAULT_MEMORY_POLICY);
  });

  it('**字符串数字被接受并转成数字**（"30" 参与日期运算会变 NaN）', () => {
    const out = normalizeMemoryPolicy({ retentionDays: '45' });
    expect(out.retentionDays).toBe(45);
    expect(typeof out.retentionDays).toBe('number');
  });

  it('NaN / Infinity / 非数字字符串 → 回落到默认值', () => {
    expect(normalizeMemoryPolicy({ retentionDays: Number.NaN }).retentionDays).toBe(
      DEFAULT_MEMORY_POLICY.retentionDays,
    );
    expect(normalizeMemoryPolicy({ retentionDays: Number.POSITIVE_INFINITY }).retentionDays).toBe(
      DEFAULT_MEMORY_POLICY.retentionDays,
    );
    expect(normalizeMemoryPolicy({ retentionDays: 'abc' }).retentionDays).toBe(
      DEFAULT_MEMORY_POLICY.retentionDays,
    );
  });

  it('越界值 → 回落到默认值（而不是夹到边界）', () => {
    expect(normalizeMemoryPolicy({ retentionDays: -1 }).retentionDays).toBe(
      DEFAULT_MEMORY_POLICY.retentionDays,
    );
    expect(normalizeMemoryPolicy({ userChars: 1 }).userChars).toBe(
      DEFAULT_MEMORY_POLICY.userChars,
    );
    expect(normalizeMemoryPolicy({ minImportance: 99 }).minImportance).toBe(
      DEFAULT_MEMORY_POLICY.minImportance,
    );
  });

  it('小数被四舍五入（门槛是天/次/字符，没有半次这回事）', () => {
    expect(normalizeMemoryPolicy({ retentionDays: 30.6 }).retentionDays).toBe(31);
  });

  it('只改一个字段时其余保持默认（不会把别的字段清成 undefined）', () => {
    const out = normalizeMemoryPolicy({ retentionDays: 60 });
    expect(out.retentionDays).toBe(60);
    expect(out.workspaceChars).toBe(DEFAULT_MEMORY_POLICY.workspaceChars);
    expect(out.archiveAfterDays).toBe(DEFAULT_MEMORY_POLICY.archiveAfterDays);
  });

  it('每个字段的区间上下界都是闭区间内的合法值', () => {
    for (const [key, limits] of Object.entries(MEMORY_POLICY_LIMITS)) {
      const atMin = normalizeMemoryPolicy({ [key]: limits.min });
      const atMax = normalizeMemoryPolicy({ [key]: limits.max });
      expect(atMin[key as keyof typeof MEMORY_POLICY_LIMITS]).toBe(limits.min);
      expect(atMax[key as keyof typeof MEMORY_POLICY_LIMITS]).toBe(limits.max);
      // 界外一个单位 → 回落
      const belowMin = normalizeMemoryPolicy({ [key]: limits.min - 1 });
      expect(belowMin[key as keyof typeof MEMORY_POLICY_LIMITS]).toBe(
        DEFAULT_MEMORY_POLICY[key as keyof typeof MEMORY_POLICY_LIMITS],
      );
    }
  });
});

describe('解析：偏好 → 纯函数参数', () => {
  it('缺省时等于各模块的出厂默认值', () => {
    const r = resolveMemoryPolicy(undefined);
    expect(r.distill.retentionDays).toBe(DEFAULT_DISTILL_POLICY.retentionDays);
    expect(r.distill.promotableKinds).toEqual(DEFAULT_DISTILL_POLICY.promotableKinds);
    expect(r.budget.userChars).toBe(DEFAULT_MEMORY_POLICY.userChars);
    expect(r.archive.archiveAfterDays).toBe(DEFAULT_MEMORY_POLICY.archiveAfterDays);
  });

  it('用户改过的值进入 distill / budget / archive 三个参数', () => {
    const r = resolveMemoryPolicy({
      retentionDays: 7,
      minImportance: 3,
      repeatThreshold: 5,
      supersessionRepeatThreshold: 4,
      archiveAfterDays: 30,
      userChars: 800,
      workspaceChars: 900,
      recentFactLimit: 2,
    });
    expect(r.distill.retentionDays).toBe(7);
    expect(r.distill.minImportance).toBe(3);
    expect(r.distill.repeatThreshold).toBe(5);
    expect(r.distill.supersessionRepeatThreshold).toBe(4);
    expect(r.budget.userChars).toBe(800);
    expect(r.budget.workspaceChars).toBe(900);
    expect(r.budget.recentFactLimit).toBe(2);
    expect(r.archive.archiveAfterDays).toBe(30);
  });

  it('归档阈值与蒸馏年龄门槛**互相独立**（v1/设计稿混过这两个数）', () => {
    const r = resolveMemoryPolicy({ retentionDays: 30, archiveAfterDays: 180 });
    expect(r.distill.retentionDays).toBe(30);
    expect(r.archive.archiveAfterDays).toBe(180);
    // 把蒸馏门槛调到 200 天不该把归档阈值也拖走
    const r2 = resolveMemoryPolicy({ retentionDays: 200, archiveAfterDays: 180 });
    expect(r2.distill.retentionDays).toBe(200);
    expect(r2.archive.archiveAfterDays).toBe(180);
  });

  it('`verifyFactAge` 不由用户决定（它是正确性开关，不是偏好）', () => {
    expect(resolveMemoryPolicy({ archiveAfterDays: 10 }).archive.verifyFactAge).toBe(true);
  });

  it('非法输入经归一化后仍产出可用参数（不会把 NaN 漏给纯函数）', () => {
    const r = resolveMemoryPolicy({ retentionDays: Number.NaN, userChars: -5 });
    expect(Number.isFinite(r.distill.retentionDays)).toBe(true);
    expect(Number.isFinite(r.budget.userChars)).toBe(true);
  });
});

describe('端到端：自定义预算真的改变注入产出', () => {
  const lines: CuratedEntry[] = Array.from({ length: 10 }, (_, i) => ({
    entryKey: `k:rule.${i}` as EntryKey,
    memoryKey: `rule.${i}`,
    kind: 'convention' as const,
    revision: 1,
    status: 'active' as const,
    content: `第 ${i} 条工作区约定，正文长度大致相同以让裁剪行为可预期`,
    importance: 4,
    evidenceIds: ['f_1'],
    evidenceCount: 1,
    firstSeen: '2026-09-01T00:00:00.000Z',
    lastSeen: '2026-09-01T00:00:00.000Z',
  }));

  it('把 workspaceChars 调小 → 更多条目被裁掉，`truncated` 变大', () => {
    const roomy = buildInjectionBlock(
      { profile: {}, preferences: [], userCurated: [], recentFacts: [], workspaceCurated: lines },
      resolveMemoryPolicy({ workspaceChars: 100_000 }).budget,
    );
    const tight = buildInjectionBlock(
      { profile: {}, preferences: [], userCurated: [], recentFacts: [], workspaceCurated: lines },
      resolveMemoryPolicy({ workspaceChars: 300 }).budget,
    );
    expect(roomy.text.length).toBeGreaterThan(tight.text.length);
    expect(tight.truncated).toBeGreaterThan(roomy.truncated);
  });

  it('把 workspaceChars 调大 → 条数不减（「预算足够时条目集合不缩小」）', () => {
    const base = buildInjectionBlock({ profile: {}, preferences: [], userCurated: [], recentFacts: [], workspaceCurated: lines }, resolveMemoryPolicy({}).budget);
    const bigger = buildInjectionBlock(
      { profile: {}, preferences: [], userCurated: [], recentFacts: [], workspaceCurated: lines },
      resolveMemoryPolicy({ workspaceChars: 50_000 }).budget,
    );
    expect(bigger.entries).toBeGreaterThanOrEqual(base.entries);
  });
});
