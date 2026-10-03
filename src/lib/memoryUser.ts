/**
 * 用户级两契约：**Profile**（我是谁）与 **Preference**（跨项目默认怎样）。
 *
 * 需求：`docs/prd-memory-v2.md` FR-M20 – FR-M24；设计：`docs/architecture-memory-v2.md` §4.7。
 *
 * ## 为什么两者不能混成一段自由文本
 *
 * | | Profile | Preference |
 * |---|---|---|
 * | 回答 | 「这个用户是谁」 | 「跨项目默认怎样」 |
 * | 更新方式 | **字段级 patch**（改时区不该动职业） | **按键替换**（同一个问题的答案只有一份） |
 * | 有效期 | 无（身份不是临时的） | 有（`expiresAt` 之后不再注入） |
 * | 来源 | 用户明确提供 | 用户明确要求 / Harness 从事件流附上 |
 *
 * 混在一起就同时失去字段级更新与键级去重：改一次时区会重写整段画像，而同一偏好的
 * 新旧两个版本会并存（v1 的重复问题正是这么来的）。
 *
 * ## 纯函数契约（NFR-M1 / NFR-M12）
 *
 * 两个模块都**显式接收 `now`**、不读时钟；校验失败**整体拒绝**（不部分写入）。
 */

import type {
  PreferenceChange,
  PreferenceRecord,
  PreferenceSource,
  PreferenceState,
  ProfileField,
  ProfileState,
  ProfileUpdateResult,
  UserProfile,
} from '@/types';
import {
  PREFERENCE_KEY_MAX_CHARS,
  PREFERENCE_KEY_RE,
  PREFERENCE_VALUE_MAX_CHARS,
  PROFILE_FIELDS,
  PROFILE_VALUE_MAX_CHARS,
} from '@/types';
import { compareStrings } from '@/lib/memoryNormalize';

/** Profile 校验失败 */
export class ProfileValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ProfileValidationError';
  }
}

/** Preference 校验失败 */
export class PreferenceValidationError extends Error {
  constructor(
    message: string,
    readonly key?: string,
  ) {
    super(message);
    this.name = 'PreferenceValidationError';
  }
}

/** 是不是白名单里的 Profile 字段 */
export function isProfileField(value: unknown): value is ProfileField {
  return typeof value === 'string' && (PROFILE_FIELDS as readonly string[]).includes(value);
}

/**
 * 规范化一个 Profile 字段值。
 *
 * 三条拒绝（都能对应真实故障）：
 * - **非字符串**：`123` / `true` / `['a']` 一律不隐式转文本——`String({})` 会写出
 *   `[object Object]` 这种垃圾进长期记忆；
 * - **超长**：`toLocaleString` 之类的误用会把整个对象塞进来；
 * - **空串**：空值是「删除」的语义，不该由值本身表达（`null` 才是删除）。
 */
function normalizeProfileValue(field: string, raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ProfileValidationError(
      `profile.${field} 必须是字符串（收到 ${raw === null ? 'null' : typeof raw}）`,
      field,
    );
  }
  const value = raw.replace(/[\r\n]+/g, ' ').trim();
  if (value === '') {
    throw new ProfileValidationError(`profile.${field} 不能是空串（要删除字段请传 null）`, field);
  }
  if (value.length > PROFILE_VALUE_MAX_CHARS) {
    throw new ProfileValidationError(
      `profile.${field} 超过 ${PROFILE_VALUE_MAX_CHARS} 字（${value.length}）`,
      field,
    );
  }
  return value;
}

/**
 * 应用一次 Profile 局部更新（FR-M20）。
 *
 * 规则逐条对齐 s11：
 * - 只改**出现**的字段，未出现的保持不变；
 * - `null` 表示**显式删除**该字段；
 * - schema 外字段**报错**；
 * - 局部更新里任一字段非法 → **整个请求拒绝**，不写入已校验的前几个字段。
 *
 * 最后一条是刻意的：`updateProfile({name:'老王', timezone: 8})` 如果只写 name、
 * 悄悄丢掉 timezone，调用方（与用户）会以为时区也更新了。宁可不写。
 */
export function applyProfilePatch(
  prev: UserProfile,
  patch: Record<string, unknown>,
): { next: UserProfile; result: ProfileUpdateResult } {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ProfileValidationError('profile patch 必须是一个对象');
  }

  const next: UserProfile = { ...(prev ?? {}) };
  const changed: ProfileField[] = [];
  const unchanged: ProfileField[] = [];

  // 先整体校验，再落地——保证「任一非法则整个请求拒绝」
  const operations: Array<{ field: ProfileField; value: string | null }> = [];
  for (const [rawField, rawValue] of Object.entries(patch)) {
    if (!isProfileField(rawField)) {
      throw new ProfileValidationError(
        `profile 不认识的字段：${rawField}（白名单：${PROFILE_FIELDS.join(' / ')}）`,
        rawField,
      );
    }
    if (rawValue === null) {
      operations.push({ field: rawField, value: null });
      continue;
    }
    operations.push({ field: rawField, value: normalizeProfileValue(rawField, rawValue) });
  }

  for (const op of operations) {
    if (op.value === null) {
      if (next[op.field] === undefined) {
        unchanged.push(op.field);
      } else {
        delete next[op.field];
        changed.push(op.field);
      }
      continue;
    }
    if (next[op.field] === op.value) {
      unchanged.push(op.field);
      continue;
    }
    next[op.field] = op.value;
    changed.push(op.field);
  }

  return {
    next,
    result: { changed: changed.sort(compareStrings), unchanged: unchanged.sort(compareStrings) },
  };
}

/** 校验一份落在磁盘上的 Profile（读取路径也校验，坏数据不当成正常值注入） */
export function validateProfileState(state: ProfileState, expectedScope: string): void {
  if (!state || state.schema !== 2) throw new ProfileValidationError('profile.json 的 schema 不是 2');
  if (state.userScope !== expectedScope) {
    throw new ProfileValidationError(
      `profile.json 的归属是 ${String(state.userScope)}，与当前作用域 ${expectedScope} 不符`,
    );
  }
  if (state.profile === null || typeof state.profile !== 'object' || Array.isArray(state.profile)) {
    throw new ProfileValidationError('profile.json 的 profile 必须是对象');
  }
  for (const [field, value] of Object.entries(state.profile)) {
    if (!isProfileField(field)) {
      throw new ProfileValidationError(`profile.json 含白名单外字段：${field}`, field);
    }
    // `null` 是「删除」的请求语义，**不是可保存的值**——磁盘上出现它说明写入方错了
    normalizeProfileValue(field, value);
  }
}

/** 空 Profile 状态 */
export function emptyProfileState(userScope: string, now: Date): ProfileState {
  return { schema: 2, userScope, profile: {}, updatedAt: now.toISOString() };
}

// —— Preference ——

/** 归一化偏好键：小写 + trim（键是机器用的，不接受大小写差异造成两个域） */
export function normalizePreferenceKey(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new PreferenceValidationError(`偏好键必须是字符串（收到 ${typeof raw}）`);
  }
  const key = raw.trim().toLowerCase();
  if (key === '') throw new PreferenceValidationError('偏好键不能为空');
  if (key.length > PREFERENCE_KEY_MAX_CHARS) {
    throw new PreferenceValidationError(
      `偏好键超过 ${PREFERENCE_KEY_MAX_CHARS} 字（${key.length}）`,
      key,
    );
  }
  if (!PREFERENCE_KEY_RE.test(key)) {
    throw new PreferenceValidationError(
      `偏好键形态非法（只允许小写字母、数字与 . _ -）：${key}`,
      key,
    );
  }
  return key;
}

/** 归一化偏好值 */
function normalizePreferenceValue(key: string, raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new PreferenceValidationError(
      `偏好 ${key} 的值必须是字符串（收到 ${raw === null ? 'null' : typeof raw}）`,
      key,
    );
  }
  const value = raw.replace(/[\r\n]+/g, ' ').trim();
  if (value === '') throw new PreferenceValidationError(`偏好 ${key} 的值不能为空`, key);
  if (value.length > PREFERENCE_VALUE_MAX_CHARS) {
    throw new PreferenceValidationError(
      `偏好 ${key} 的值超过 ${PREFERENCE_VALUE_MAX_CHARS} 字（${value.length}）`,
      key,
    );
  }
  return value;
}

/** 时间戳必须含时区（否则 `Date.parse` 在不同运行环境给出不同时刻） */
function normalizeInstant(raw: unknown, label: string, key?: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new PreferenceValidationError(`${label} 必须是非空时间字符串`, key);
  }
  const text = raw.trim();
  // 允许 `Z` 或 `±HH:MM`；`2026-01-01T00:00:00`（无时区）会被 `Date.parse` 当日历时间，
  // 那在不同时区的机器上是不同的时刻——这类歧义必须在入口拦掉。
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    throw new PreferenceValidationError(`${label} 必须带时区（以 Z 或 ±HH:MM 结尾）：${text}`, key);
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    throw new PreferenceValidationError(`${label} 不是可解析的时间：${text}`, key);
  }
  return new Date(ms).toISOString();
}

/** `setPreference` 的选项 */
export interface SetPreferenceOptions {
  source?: PreferenceSource;
  /** Harness provenance；**模型不得提交**（FR-M23） */
  sourceEventId?: string;
  /** 显式证据时间；缺省取 `now` */
  updatedAt?: string;
  /** 到期时刻；到达即不再注入（但仍留在 canonical） */
  expiresAt?: string;
}

/**
 * 写入 / 更新一条偏好（FR-M21）。
 *
 * ## 完整幂等身份 = value + source + expiresAt + sourceEventId
 *
 * 四项全等才是 `UNCHANGED`：不写盘、不加 revision，**即使重试传入更晚时间也不推进
 * 证据时间**（程序自动取的当前时间不能证明用户再次确认）。
 *
 * ## 无 `sourceEventId` 时的「再次确认」语义
 *
 * 显式传入比 canonical `updatedAt` **更晚**的时间表示用户又确认了一次：
 * 即使 value 不变也推进 `updatedAt` 并 `revision + 1`。
 *
 * ## 时间防回滚
 *
 * 状态**不同**时的写入时间必须严格晚于 canonical `updatedAt`；否则拒绝——
 * 重放一段旧 transcript 不能把新偏好回滚掉。
 */
export function setPreference(
  state: PreferenceState,
  rawKey: string,
  rawValue: string,
  opts: SetPreferenceOptions,
  now: Date,
): { next: PreferenceState; change: PreferenceChange; record: PreferenceRecord } {
  const key = normalizePreferenceKey(rawKey);
  const value = normalizePreferenceValue(key, rawValue);
  const source: PreferenceSource = opts.source ?? 'user';
  const expiresAt = opts.expiresAt === undefined ? undefined : normalizeInstant(opts.expiresAt, 'expiresAt', key);
  const updatedAt = opts.updatedAt === undefined ? now.toISOString() : normalizeInstant(opts.updatedAt, 'updatedAt', key);

  const records = [...(state.records ?? [])];
  const idx = records.findIndex((r) => r.key === key);
  const prev = idx === -1 ? undefined : records[idx];

  if (!prev) {
    const record: PreferenceRecord = {
      key,
      value,
      revision: 1,
      source,
      ...(opts.sourceEventId ? { sourceEventId: opts.sourceEventId } : {}),
      updatedAt,
      ...(expiresAt ? { expiresAt } : {}),
    };
    records.push(record);
    return {
      next: { ...state, records: sortRecords(records), updatedAt: now.toISOString() },
      change: 'CREATED',
      record,
    };
  }

  // 完整状态相同 → no-op（重试不会推进证据时间）。
  //
  // 但有一个例外：**调用方显式传了一个比 canonical 更晚的证据时间**，那是「用户又确认
  // 了一次」的证据，必须被记下来（推进 `updatedAt` 与 revision）。程序自动取的当前时间
  // 不算证据——否则每次无害的重试都会推进时间，`revision` 变成「被调用次数」。
  const explicitlyNewer = opts.updatedAt !== undefined && Date.parse(updatedAt) > Date.parse(prev.updatedAt);
  if (
    prev.value === value &&
    prev.source === source &&
    (prev.expiresAt ?? undefined) === (expiresAt ?? undefined) &&
    (prev.sourceEventId ?? undefined) === (opts.sourceEventId ?? undefined) &&
    !explicitlyNewer
  ) {
    return { next: state, change: 'UNCHANGED', record: prev };
  }

  // 状态变了：写入时间必须严格晚于 canonical，否则拒绝（防回滚）
  if (Date.parse(updatedAt) <= Date.parse(prev.updatedAt)) {
    throw new PreferenceValidationError(
      `偏好 ${key} 的写入时间 ${updatedAt} 不晚于当前证据时间 ${prev.updatedAt}` +
        '（拒绝用过期证据回滚新偏好）',
      key,
    );
  }

  const record: PreferenceRecord = {
    key,
    value,
    revision: prev.revision + 1,
    source,
    ...(opts.sourceEventId ? { sourceEventId: opts.sourceEventId } : {}),
    updatedAt,
    ...(expiresAt ? { expiresAt } : {}),
  };
  records[idx] = record;
  return {
    next: { ...state, records: sortRecords(records), updatedAt: now.toISOString() },
    change: 'UPDATED',
    record,
  };
}

/**
 * 按 key **精确**删除一条偏好（FR-M21）。
 *
 * 不做自然语言模糊匹配：UI 要能向用户展示「将删除哪一条」，审计也要能记下明确目标。
 */
export function deletePreference(
  state: PreferenceState,
  rawKey: string,
  now: Date,
): { next: PreferenceState; removed: boolean } {
  const key = normalizePreferenceKey(rawKey);
  const records = (state.records ?? []).filter((r) => r.key !== key);
  if (records.length === (state.records ?? []).length) return { next: state, removed: false };
  return {
    next: { ...state, records: sortRecords(records), updatedAt: now.toISOString() },
    removed: true,
  };
}

/** 按 key 取一条偏好（不看有效期） */
export function findPreference(state: PreferenceState, rawKey: string): PreferenceRecord | null {
  const key = normalizePreferenceKey(rawKey);
  return (state.records ?? []).find((r) => r.key === key) ?? null;
}

/**
 * 某一时刻**可注入**的偏好集合（FR-M22）。
 *
 * 边界是硬约定：`asOf < expiresAt` 为 active，**到达 `expiresAt` 的瞬间即 expired**。
 * 过期不是删除——记录继续留在 `preferences.json`，以便解释「它曾经为何生效」；
 * 只是不再进 `MEMORY.md` 与 prompt。
 */
export function listActivePreferences(
  state: PreferenceState,
  asOf: Date,
): PreferenceRecord[] {
  const t = asOf.getTime();
  return sortRecords((state.records ?? []).filter((r) => {
    if (!r.expiresAt) return true;
    const exp = Date.parse(r.expiresAt);
    return Number.isFinite(exp) && t < exp;
  }));
}

/** 已过期的偏好（UI 展示与诊断用） */
export function listExpiredPreferences(state: PreferenceState, asOf: Date): PreferenceRecord[] {
  const t = asOf.getTime();
  return sortRecords((state.records ?? []).filter((r) => {
    if (!r.expiresAt) return false;
    const exp = Date.parse(r.expiresAt);
    return !Number.isFinite(exp) || t >= exp;
  }));
}

/** 校验一份落在磁盘上的偏好集合（读取路径也校验） */
export function validatePreferenceState(state: PreferenceState, expectedScope: string): void {
  if (!state || state.schema !== 2) {
    throw new PreferenceValidationError('preferences.json 的 schema 不是 2');
  }
  if (state.userScope !== expectedScope) {
    throw new PreferenceValidationError(
      `preferences.json 的归属是 ${String(state.userScope)}，与当前作用域 ${expectedScope} 不符`,
    );
  }
  if (!Array.isArray(state.records)) {
    throw new PreferenceValidationError('preferences.json 的 records 必须是数组');
  }
  const seen = new Set<string>();
  for (const record of state.records) {
    if (record === null || typeof record !== 'object') {
      throw new PreferenceValidationError('preferences.json 含非对象记录');
    }
    const key = normalizePreferenceKey(record.key);
    if (seen.has(key)) {
      throw new PreferenceValidationError(`preferences.json 里 ${key} 出现多次（同一问题只能有一个答案）`, key);
    }
    seen.add(key);
    normalizePreferenceValue(key, record.value);
    if (!Number.isInteger(record.revision) || record.revision < 1) {
      throw new PreferenceValidationError(`偏好 ${key} 的 revision 非法：${String(record.revision)}`, key);
    }
    normalizeInstant(record.updatedAt, 'updatedAt', key);
    if (record.expiresAt !== undefined) normalizeInstant(record.expiresAt, 'expiresAt', key);
    if (record.sourceEventId !== undefined && typeof record.sourceEventId !== 'string') {
      throw new PreferenceValidationError(`偏好 ${key} 的 sourceEventId 必须是字符串`, key);
    }
  }
}

/** 空偏好状态 */
export function emptyPreferenceState(userScope: string, now: Date): PreferenceState {
  return { schema: 2, userScope, records: [], updatedAt: now.toISOString() };
}

/** 记录排序：按 key 字典序（`<`，禁用 localeCompare —— NFR-M12） */
function sortRecords(records: readonly PreferenceRecord[]): PreferenceRecord[] {
  return [...records].sort((a, b) => compareStrings(a.key, b.key));
}
