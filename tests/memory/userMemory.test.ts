/**
 * 用户级两契约：Profile 与 Preference（`src/lib/memoryUser.ts`）。
 *
 * 需求 FR-M20 – FR-M24。测试按**契约**组织，每条都对应一种真实故障：
 *
 * 1. **Profile 字段级 patch**：改时区不该动职业；`null` 才是删除；白名单外字段报错
 *    （模型每一轮都会发明新字段，静默收下会让 profile 变垃圾桶）；任一字段非法 →
 *    **整个请求拒绝**（否则调用方以为都更新了）。
 * 2. **Preference 完整幂等身份** = value + source + expiresAt + sourceEventId：
 *    「重试」不能推进证据时间，「延长期限」必须是一次可观察更新。
 * 3. **时间防回滚**：重放旧 transcript 不能把新偏好改回去。
 * 4. **`expiresAt`**：到达瞬间即失效，但记录**不删**（要能解释它曾经为何生效）。
 * 5. **读取路径也校验**：磁盘上 `{"name": null}` 必须报错，而不是变成 `Name: None` 注入。
 */

import { describe, expect, it } from 'vitest';
import type { PreferenceState, ProfileState } from '../../src/types';
import {
  PreferenceValidationError,
  ProfileValidationError,
  applyProfilePatch,
  deletePreference,
  emptyPreferenceState,
  emptyProfileState,
  findPreference,
  listActivePreferences,
  listExpiredPreferences,
  normalizePreferenceKey,
  setPreference,
  validatePreferenceState,
  validateProfileState,
} from '../../src/lib/memoryUser';

const NOW = new Date('2026-10-02T00:00:00Z');
const SCOPE = 'u_testscope';

function profile(state: ProfileState['profile'] = {}): ProfileState {
  return { ...emptyProfileState(SCOPE, NOW), profile: state };
}

function prefs(records: PreferenceState['records'] = []): PreferenceState {
  return { ...emptyPreferenceState(SCOPE, NOW), records };
}

describe('Profile：字段级 patch', () => {
  it('只改出现的字段，未出现的保持不变', () => {
    const prev = { name: '老王', occupation: 'GIS 开发' };
    const { next, result } = applyProfilePatch(prev, { callThem: '王哥' });
    expect(next).toEqual({ name: '老王', occupation: 'GIS 开发', callThem: '王哥' });
    expect(result.changed).toEqual(['callThem']);
    expect(result.unchanged).toEqual([]);
  });

  it('null 表示**显式删除**该字段', () => {
    const { next, result } = applyProfilePatch({ name: '老王', city: '北京' }, { city: null });
    expect(next).toEqual({ name: '老王' });
    expect(result.changed).toEqual(['city']);
  });

  it('删除不存在的字段是 unchanged（不是错误，也不制造变化）', () => {
    const { next, result } = applyProfilePatch({ name: '老王' }, { city: null });
    expect(next).toEqual({ name: '老王' });
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual(['city']);
  });

  it('等值 patch 记 unchanged，且不改动入参', () => {
    const prev = { name: '老王' };
    const { next, result } = applyProfilePatch(prev, { name: '老王' });
    expect(result.unchanged).toEqual(['name']);
    expect(result.changed).toEqual([]);
    expect(next).toEqual(prev);
    expect(prev).toEqual({ name: '老王' });
  });

  it('白名单外字段直接报错（模型会发明字段）', () => {
    expect(() => applyProfilePatch({}, { nickname: '老王' })).toThrow(ProfileValidationError);
    expect(() => applyProfilePatch({}, { gender: '男' })).toThrow(/不认识的字段/);
  });

  it('值必须是字符串：数字 / 布尔 / 对象都不隐式转文本', () => {
    expect(() => applyProfilePatch({}, { timezone: 8 })).toThrow(/必须是字符串/);
    expect(() => applyProfilePatch({}, { name: true })).toThrow(/必须是字符串/);
    expect(() => applyProfilePatch({}, { name: { first: '王' } })).toThrow(/必须是字符串/);
    // 否则 String({}) 会把 `[object Object]` 写进长期记忆
  });

  it('空串被拒绝（要删除请传 null）', () => {
    expect(() => applyProfilePatch({}, { name: '   ' })).toThrow(/不能是空串/);
  });

  it('超长值被拒绝', () => {
    expect(() => applyProfilePatch({}, { name: 'x'.repeat(1001) })).toThrow(/超过 1000 字/);
  });

  it('局部更新里**任一**字段非法 → 整个请求拒绝，不写入已校验的前几个', () => {
    // 这条是刻意的：只写 name、悄悄丢掉 timezone，调用方会以为都更新了
    expect(() => applyProfilePatch({}, { name: '老王', timezone: 8 })).toThrow(
      ProfileValidationError,
    );
  });

  it('换行被折叠成空格（画像值不该是多行文本）', () => {
    const { next } = applyProfilePatch({}, { responseStyle: '简洁\n直接' });
    expect(next.responseStyle).toBe('简洁 直接');
  });

  it('patch 不是对象时拒绝', () => {
    expect(() => applyProfilePatch({}, null as never)).toThrow(/必须是一个对象/);
    expect(() => applyProfilePatch({}, [] as never)).toThrow(/必须是一个对象/);
  });
});

describe('Profile：读取路径也校验', () => {
  it('归属不符 → 报错（发现错误复制 / 传错用户）', () => {
    const state = { ...profile({ name: '老王' }), userScope: 'u_other' };
    expect(() => validateProfileState(state, SCOPE)).toThrow(/归属/);
  });

  it('磁盘上的 null 值 → 报错，而不是变成 "None" 注入', () => {
    const state = profile({ name: null as never });
    expect(() => validateProfileState(state, SCOPE)).toThrow(ProfileValidationError);
  });

  it('白名单外字段 → 报错', () => {
    const state = profile({ nickname: '老王' } as never);
    expect(() => validateProfileState(state, SCOPE)).toThrow(/白名单外字段/);
  });

  it('合法状态通过', () => {
    expect(() => validateProfileState(profile({ name: '老王', timezone: 'UTC+8' }), SCOPE)).not.toThrow();
  });

  it('schema 不是 2 → 报错', () => {
    expect(() => validateProfileState({ ...profile(), schema: 1 as never }, SCOPE)).toThrow(/schema/);
  });
});

describe('Preference：CREATED / UNCHANGED / UPDATED', () => {
  it('首次写入 = CREATED，revision 1', () => {
    const { next, change, record } = setPreference(prefs(), 'response.language', 'Chinese', {}, NOW);
    expect(change).toBe('CREATED');
    expect(record.revision).toBe(1);
    expect(next.records).toHaveLength(1);
  });

  it('完整状态相同 = UNCHANGED，不写盘、不加 revision', () => {
    const first = setPreference(prefs(), 'response.language', 'Chinese', {}, NOW);
    // 同一 sourceEventId 的重试，即使时间更晚也不推进证据时间
    const later = new Date('2026-10-05T00:00:00Z');
    const second = setPreference(
      first.next,
      'response.language',
      'Chinese',
      { sourceEventId: undefined },
      later,
    );
    expect(second.change).toBe('UNCHANGED');
    expect(second.record.revision).toBe(1);
    expect(second.record.updatedAt).toBe(first.record.updatedAt);
    expect(second.next).toBe(first.next);
  });

  it('带 sourceEventId 的同参重试不推进证据时间', () => {
    const opts = { sourceEventId: 'session-7:event-42' } as const;
    const first = setPreference(prefs(), 'response.detail', 'verbose', opts, NOW);
    const later = new Date('2026-10-09T00:00:00Z');
    const second = setPreference(first.next, 'response.detail', 'verbose', opts, later);
    expect(second.change).toBe('UNCHANGED');
    expect(second.record.updatedAt).toBe(first.record.updatedAt);
    expect(second.record.revision).toBe(1);
  });

  it('值变化 = UPDATED，revision +1 且时间推进', () => {
    const first = setPreference(prefs(), 'response.language', 'Chinese', {}, NOW);
    const later = new Date('2026-10-03T00:00:00Z');
    const second = setPreference(first.next, 'response.language', 'English', {}, later);
    expect(second.change).toBe('UPDATED');
    expect(second.record.revision).toBe(2);
    expect(second.record.value).toBe('English');
    expect(second.next.records).toHaveLength(1);
  });

  it('同值但补充了新来源（sourceEventId 变了）= 可观察更新', () => {
    const first = setPreference(prefs(), 'editor.indent', 'tabs', {}, NOW);
    const later = new Date('2026-10-03T00:00:00Z');
    const second = setPreference(
      first.next,
      'editor.indent',
      'tabs',
      { sourceEventId: 'ev-9' },
      later,
    );
    expect(second.change).toBe('UPDATED');
    expect(second.record.revision).toBe(2);
    expect(second.record.sourceEventId).toBe('ev-9');
  });

  it('同值但**延长期限** = 可观察更新', () => {
    const exp1 = '2026-11-01T00:00:00Z';
    const exp2 = '2026-12-01T00:00:00Z';
    const first = setPreference(prefs(), 'response.detail', 'verbose', { expiresAt: exp1 }, NOW);
    const later = new Date('2026-10-03T00:00:00Z');
    const second = setPreference(first.next, 'response.detail', 'verbose', { expiresAt: exp2 }, later);
    expect(second.change).toBe('UPDATED');
    // 时间戳统一存成 UTC ISO（含毫秒），便于逐字节比较
    expect(second.record.expiresAt).toBe('2026-12-01T00:00:00.000Z');
  });

  it('同值但没有新证据（无事件 ID、无更晚时间）= UNCHANGED', () => {
    // 「延长期限」算更新，是因为它是一次**可观察**的状态变化；而这里什么都没变
    const first = setPreference(prefs(), 'response.detail', 'verbose', {}, NOW);
    const second = setPreference(first.next, 'response.detail', 'verbose', {}, new Date('2026-10-03T00:00:00Z'));
    expect(second.change).toBe('UNCHANGED');
    expect(second.record.revision).toBe(1);
  });

  it('无事件 ID 时显式传入更晚时间 = 用户再次确认，推进 revision', () => {
    const first = setPreference(
      prefs(),
      'response.language',
      'Chinese',
      { updatedAt: '2026-10-01T00:00:00Z' },
      NOW,
    );
    const confirmedAt = '2026-10-04T00:00:00Z';
    const second = setPreference(
      first.next,
      'response.language',
      'Chinese',
      { updatedAt: confirmedAt },
      new Date('2026-10-06T00:00:00Z'),
    );
    expect(second.change).toBe('UPDATED');
    expect(second.record.updatedAt).toBe('2026-10-04T00:00:00.000Z');
    expect(second.record.revision).toBe(2);
  });
});

describe('Preference：时间防回滚', () => {
  it('状态不同但时间不更新 → 拒绝（重放旧 transcript 不能回滚新偏好）', () => {
    const first = setPreference(
      prefs(),
      'response.language',
      'Chinese',
      { updatedAt: '2026-10-01T00:00:00Z' },
      NOW,
    );
    // 延迟到达的 09-30「English」：时间早于 canonical
    expect(() =>
      setPreference(
        first.next,
        'response.language',
        'English',
        { updatedAt: '2026-09-30T00:00:00Z' },
        new Date('2026-10-02T01:00:00Z'),
      ),
    ).toThrow(/不晚于当前证据时间/);
  });

  it('同一时刻的不同值也拒绝（必须严格更晚）', () => {
    const first = setPreference(
      prefs(),
      'k',
      'a',
      { updatedAt: '2026-10-01T00:00:00Z' },
      NOW,
    );
    expect(() =>
      setPreference(first.next, 'k', 'b', { updatedAt: '2026-10-01T00:00:00Z' }, NOW),
    ).toThrow(PreferenceValidationError);
  });
});

describe('Preference：有效期', () => {
  const expiring = '2026-11-01T00:00:00Z';

  it('到期前 active、到达瞬间 expired（边界是 `<`）', () => {
    const { next } = setPreference(prefs(), 'response.detail', 'verbose', { expiresAt: expiring }, NOW);
    expect(listActivePreferences(next, new Date('2026-10-31T23:59:59Z'))).toHaveLength(1);
    // 到达 expiresAt 的**那一瞬间**即失效
    expect(listActivePreferences(next, new Date(expiring))).toHaveLength(0);
    expect(listExpiredPreferences(next, new Date(expiring))).toHaveLength(1);
  });

  it('过期是「不再注入」而不是删除：记录仍在 canonical', () => {
    const { next } = setPreference(prefs(), 'response.detail', 'verbose', { expiresAt: expiring }, NOW);
    expect(next.records).toHaveLength(1);
    expect(findPreference(next, 'response.detail')).not.toBeNull();
  });

  it('没有 expiresAt 的偏好永远 active', () => {
    const { next } = setPreference(prefs(), 'response.language', 'Chinese', {}, NOW);
    expect(listActivePreferences(next, new Date('2030-01-01T00:00:00Z'))).toHaveLength(1);
  });

  it('时间戳必须带时区（无时区的写法在不同机器上是不同时刻）', () => {
    expect(() => setPreference(prefs(), 'k', 'v', { expiresAt: '2026-11-01T00:00:00' }, NOW)).toThrow(
      /必须带时区/,
    );
    expect(() => setPreference(prefs(), 'k', 'v', { updatedAt: '2026-10-01' }, NOW)).toThrow(/必须带时区/);
  });
});

describe('Preference：键与值的校验', () => {
  it('键形态非法 → 拒绝（空格 / 中文 / 开头是分隔符一律不行）', () => {
    expect(() => normalizePreferenceKey('response language')).toThrow(/形态非法/);
    expect(() => normalizePreferenceKey('回复语言')).toThrow(/形态非法/);
    expect(() => normalizePreferenceKey('.leading.dot')).toThrow(/形态非法/);
    expect(() => normalizePreferenceKey('trailing.dot.')).toThrow(/形态非法/);
    expect(() => normalizePreferenceKey('double..dot')).toThrow(/形态非法/);
    expect(() => normalizePreferenceKey('')).toThrow(/不能为空/);
  });

  it('键归一化为小写 trim（避免大小写差异造成两个域）', () => {
    // 大写不是错误：归一化到小写，同一条偏好只有一个域
    expect(normalizePreferenceKey('  Editor.Indent  ')).toBe('editor.indent');
    expect(normalizePreferenceKey('Response.Language')).toBe('response.language');
  });

  it('值必须是非空字符串', () => {
    expect(() => setPreference(prefs(), 'k', '', {}, NOW)).toThrow(/不能为空/);
    expect(() => setPreference(prefs(), 'k', 42 as never, {}, NOW)).toThrow(/必须是字符串/);
  });

  it('键超长被拒绝', () => {
    expect(() => normalizePreferenceKey('a'.repeat(65))).toThrow(/超过 64 字/);
  });
});

describe('Preference：删除与排序', () => {
  it('按 key 精确删除，不做模糊匹配', () => {
    const a = setPreference(prefs(), 'response.language', 'Chinese', {}, NOW);
    const b = setPreference(a.next, 'response.detail', 'verbose', {}, NOW);
    const { next, removed } = deletePreference(b.next, 'response.language', NOW);
    expect(removed).toBe(true);
    expect(next.records.map((r) => r.key)).toEqual(['response.detail']);
  });

  it('删除不存在的 key 是幂等的 no-op', () => {
    const a = setPreference(prefs(), 'k1', 'v', {}, NOW);
    const { next, removed } = deletePreference(a.next, 'k2', NOW);
    expect(removed).toBe(false);
    expect(next).toBe(a.next);
  });

  it('记录按 key 字典序（`<` 而不是 localeCompare：跨 locale 结果必须一致）', () => {
    let state = prefs();
    for (const key of ['zebra.x', 'alpha.y', 'beta.z']) {
      state = setPreference(state, key, 'v', {}, NOW).next;
    }
    expect(state.records.map((r) => r.key)).toEqual(['alpha.y', 'beta.z', 'zebra.x']);
  });
});

describe('Preference：读取路径也校验', () => {
  it('归属不符 → 报错', () => {
    const state = { ...prefs(), userScope: 'u_other' };
    expect(() => validatePreferenceState(state, SCOPE)).toThrow(/归属/);
  });

  it('同一 key 出现多次 → 报错（同一问题只能有一个答案）', () => {
    const record = {
      key: 'k',
      value: 'v',
      revision: 1,
      source: 'user' as const,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    expect(() => validatePreferenceState(prefs([record, { ...record, value: 'other' }]), SCOPE)).toThrow(
      /出现多次/,
    );
  });

  it('revision 非法 → 报错', () => {
    expect(() =>
      validatePreferenceState(
        prefs([
          {
            key: 'k',
            value: 'v',
            revision: 0,
            source: 'user',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ]),
        SCOPE,
      ),
    ).toThrow(/revision/);
  });

  it('合法集合通过', () => {
    const { next } = setPreference(prefs(), 'editor.indent', 'tabs', {}, NOW);
    expect(() => validatePreferenceState(next, SCOPE)).not.toThrow();
  });
});
