/**
 * 用户级记忆仓储：Profile、Preference 与**用户作用域**的策展修订。
 *
 * 需求：`docs/prd-memory-v2.md` FR-M4 / FR-M20 – FR-M24；设计：`docs/architecture-memory-v2.md` §4.7。
 *
 * ## 与 `createMemoryStore` 的关系
 *
 * 两者共用同一个 `MemoryStoreIo` 端口与同一套 canonical 规则（原子替换、归属校验、
 * 崩溃恢复），区别只在**多出来的两件用户级状态**：`profile.json` 与 `preferences.json`。
 * 用户级也有一份 `curated.json`（身份类事实的蒸馏产物），它是**独立的一份**，
 * 由 `createMemoryStore` 以用户根 + 用户 `workspaceId` 建出来。
 *
 * ## 三个刻意的取舍
 *
 * 1. **Profile / Preference 不参与 `distill`**：它们已经是「结论」（用户明确说的，
 *    或模型声明后由 harness 落盘的），再走一遍晋升门槛只会把它们降格成候选。
 * 2. **写 Profile 前先读、写后整体替换**：Profile 是**单份文档**而非增量日志——它没有
 *    「证据」语义（用户改了就是改了），所以不像事实那样 append-only。
 * 3. **偏好过期不删记录**：`expiresAt` 只影响「是否注入」，canonical 里保留以便解释
 *    「它曾经为何生效」。
 */

import type {
  PreferenceChange,
  PreferenceRecord,
  PreferenceState,
  ProfileField,
  ProfileState,
  ProfileUpdateResult,
  UserProfile,
} from '@/types';
import type { MemoryStoreIo } from '@/lib/memoryStore';
import { PREFERENCES_FILE, PROFILE_FILE, USER_PROFILE_PROJECTION_FILE } from '@/lib/memoryPaths';
import {
  PreferenceValidationError,
  ProfileValidationError,
  applyProfilePatch,
  emptyPreferenceState,
  emptyProfileState,
  listActivePreferences,
  listExpiredPreferences,
  normalizePreferenceKey,
  setPreference,
  deletePreference,
  validatePreferenceState,
  validateProfileState,
  type SetPreferenceOptions,
} from '@/lib/memoryUser';

/** 用户级仓储的构造参数 */
export interface UserMemoryStoreOptions {
  io: MemoryStoreIo;
  /** 用户作用域（`ensureLocalMemoryScope()` 的产物） */
  userScope: string;
}

/** 用户级记忆仓储 */
export interface UserMemoryStore {
  readonly userScope: string;
  /** 读取画像（不存在返回空画像） */
  loadProfile(): Promise<UserProfile>;
  /** 读取完整画像状态（含 `updatedAt`） */
  loadProfileState(): Promise<ProfileState>;
  /** 局部更新画像（FR-M20）；返回真正变化的字段 */
  updateProfile(
    patch: Record<string, unknown>,
    now: Date,
  ): Promise<{ profile: UserProfile; result: ProfileUpdateResult }>;
  /** 读取偏好全集（含已过期） */
  loadPreferences(): Promise<PreferenceState>;
  /** 某一时刻可注入的偏好（不写盘；`asOf` 是纯读取参数） */
  activePreferences(asOf: Date): Promise<PreferenceRecord[]>;
  /** 已过期的偏好（UI 展示用） */
  expiredPreferences(asOf: Date): Promise<PreferenceRecord[]>;
  /** 写入 / 更新一条偏好（FR-M21） */
  setPreference(
    key: string,
    value: string,
    opts: SetPreferenceOptions,
    now: Date,
  ): Promise<{ change: PreferenceChange; record: PreferenceRecord }>;
  /** 按 key 精确删除（FR-M21） */
  deletePreference(key: string, now: Date): Promise<boolean>;
  /** 由 canonical 重建 `MEMORY.md` 与 `user.md` 两个投影 */
  rebuildProjection(asOf: Date): Promise<{ memory: string; userDoc: string }>;
}

/** 解析 canonical JSON；损坏时抛错而不是当成空状态 */
function parseState<T>(raw: string | null, label: string): T | null {
  if (raw === null || raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new PreferenceValidationError(`${label} 不是合法 JSON（可能被写坏或读到半截内容）`);
  }
}

/** 稳定序列化（canonical 文件用；对象键排序，保证同一状态逐字节相同） */
function stableStringify(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const child = (v as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = walk(child);
    }
    return out;
  };
  return `${JSON.stringify(walk(value), null, 2)}\n`;
}

/** 创建用户级仓储 */
export function createUserMemoryStore(options: UserMemoryStoreOptions): UserMemoryStore {
  const { io, userScope } = options;

  async function loadProfileState(): Promise<ProfileState> {
    const raw = await io.read(PROFILE_FILE);
    const parsed = parseState<ProfileState>(raw, PROFILE_FILE);
    if (!parsed) return emptyProfileState(userScope, new Date());
    validateProfileState(parsed, userScope);
    return parsed;
  }

  async function loadPreferences(): Promise<PreferenceState> {
    const raw = await io.read(PREFERENCES_FILE);
    const parsed = parseState<PreferenceState>(raw, PREFERENCES_FILE);
    if (!parsed) return emptyPreferenceState(userScope, new Date());
    validatePreferenceState(parsed, userScope);
    return parsed;
  }

  async function writeProfileState(state: ProfileState): Promise<void> {
    await io.replace(PROFILE_FILE, stableStringify(state));
  }

  async function writePreferenceState(state: PreferenceState): Promise<void> {
    await io.replace(PREFERENCES_FILE, stableStringify(state));
  }

  /**
   * 重建两个投影。
   *
   * - `MEMORY.md`：**可注入的**偏好（active）+ 过期列表（只作说明）；
   * - `user.md`：画像（人读）。
   *
   * 两个都是派生视图：坏了删掉即可由 canonical 重生成（不变量 I6）。
   */
  async function rebuildProjection(asOf: Date): Promise<{ memory: string; userDoc: string }> {
    const [profileState, prefState] = await Promise.all([loadProfileState(), loadPreferences()]);

    const userDoc = renderUserDoc(profileState.profile);
    if (userDoc.trim() === '') await io.remove(USER_PROFILE_PROJECTION_FILE);
    else await io.write(USER_PROFILE_PROJECTION_FILE, `${userDoc}\n`);

    const memory = renderPreferenceDoc(prefState, asOf);
    if (memory.trim() === '') await io.remove('MEMORY.md');
    else await io.write('MEMORY.md', `${memory}\n`);

    return { memory, userDoc };
  }

  return {
    userScope,

    loadProfile: async () => (await loadProfileState()).profile,
    loadProfileState,
    loadPreferences,

    updateProfile: async (patch, now) => {
      const prev = await loadProfileState();
      const { next, result } = applyProfilePatch(prev.profile, patch);
      // 无变化且投影已是最新 → 不写盘（重试不该产生写入）
      if (result.changed.length === 0) {
        await ensureProjectionFresh(prev.profile);
        return { profile: next, result };
      }
      const state: ProfileState = { ...prev, profile: next, updatedAt: now.toISOString() };
      validateProfileState(state, userScope);
      await writeProfileState(state);
      // Profile 的 canonical 与投影**不是同一个事务**：JSON 成功后投影失败仍可能让
      // 本次写入报错；恢复以 JSON 为准，不回滚事实记录（对齐 s11 的取舍）。
      const userDoc = renderUserDoc(next);
      if (userDoc.trim() === '') await io.remove(USER_PROFILE_PROJECTION_FILE);
      else await io.write(USER_PROFILE_PROJECTION_FILE, `${userDoc}\n`);
      return { profile: next, result };
    },

    activePreferences: async (asOf) => listActivePreferences(await loadPreferences(), asOf),
    expiredPreferences: async (asOf) => listExpiredPreferences(await loadPreferences(), asOf),

    setPreference: async (key, value, opts, now) => {
      const prev = await loadPreferences();
      const { next, change, record } = setPreference(prev, key, value, opts, now);
      if (change !== 'UNCHANGED') {
        await writePreferenceState(next);
        await rebuildProjection(now);
      }
      return { change, record };
    },

    deletePreference: async (key, now) => {
      const prev = await loadPreferences();
      const { next, removed } = deletePreference(prev, key, now);
      if (removed) {
        await writePreferenceState(next);
        await rebuildProjection(now);
      }
      return removed;
    },

    rebuildProjection,
  };

  /** 画像未变时仍检查投影是否过期（JSON 已存、Markdown 写失败后的恢复路径） */
  async function ensureProjectionFresh(profile: UserProfile): Promise<void> {
    const expected = renderUserDoc(profile);
    const current = (await io.read(USER_PROFILE_PROJECTION_FILE)) ?? '';
    const want = expected.trim() === '' ? '' : `${expected}\n`;
    if (current === want) return;
    if (want === '') await io.remove(USER_PROFILE_PROJECTION_FILE);
    else await io.write(USER_PROFILE_PROJECTION_FILE, want);
  }
}

/** 画像 → `user.md` 的正文 */
export function renderUserDoc(profile: UserProfile): string {
  const labels: Array<[ProfileField, string]> = [
    ['name', '姓名'],
    ['callThem', '称呼'],
    ['timezone', '时区'],
    ['language', '默认语言'],
    ['occupation', '职业'],
    ['organization', '所在组织'],
    ['role', '角色'],
    ['city', '常驻城市'],
    ['responseStyle', '表达偏好'],
  ];
  const lines: string[] = [];
  for (const [field, label] of labels) {
    const value = profile?.[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    lines.push(`- ${label}：${value}`);
  }
  return lines.join('\n');
}

/**
 * 偏好 → `MEMORY.md` 的正文。
 *
 * 只列**可注入**的偏好；过期的那批另起一段仅作说明（让人看得出「它曾经生效过」）。
 * 这一段**不进注入**——注入侧只取 active（`docs/prd-memory-v2.md` FR-M22）。
 */
export function renderPreferenceDoc(state: PreferenceState, asOf: Date): string {
  const active = listActivePreferences(state, asOf);
  const expired = listExpiredPreferences(state, asOf);
  const lines: string[] = [];
  if (active.length > 0) {
    for (const record of active) {
      lines.push(`- \`${record.key}\`：${record.value}`);
    }
  }
  if (expired.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('（以下偏好已过期，不再注入，保留以备查）');
    for (const record of expired) {
      lines.push(`- \`${record.key}\`：${record.value}（至 ${record.expiresAt}）`);
    }
  }
  return lines.join('\n');
}

export {
  PreferenceValidationError,
  ProfileValidationError,
  applyProfilePatch,
  normalizePreferenceKey,
};
