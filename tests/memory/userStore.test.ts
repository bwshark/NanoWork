/**
 * 用户级仓储（`src/lib/memory/memoryUserStore.ts`）。需求 FR-M20 – FR-M24。
 *
 * 与 `store.test.ts` 同一套内存假端口，因为这里要验的是**落盘与投影**：
 *
 * 1. 画像改动落 `profile.json`（canonical）+ `user.md`（投影）；
 * 2. 偏好落 `preferences.json`，且**过期不删记录**、只是不进投影的 active 段；
 * 3. 投影可以被人为删掉后从 canonical 重建（不变量 I6）；
 * 4. 「变更重试不写盘」与「无变化重试修复过期投影」两条都要成立。
 */

import { describe, expect, it } from 'vitest';
import type { PreferenceState, ProfileState } from '../../src/types';
import { createUserMemoryStore } from '../../src/lib/memory/memoryUserStore';
import type { MemoryStoreIo } from '../../src/lib/memory/memoryStore';
import {
  CURATED_MEMORY_FILE,
  PREFERENCES_FILE,
  PROFILE_FILE,
  USER_PROFILE_PROJECTION_FILE,
} from '../../src/lib/memory/memoryPaths';

const NOW = new Date('2026-10-02T00:00:00Z');
const SCOPE = 'u_testscope';
const EXPIRES = '2026-11-01T00:00:00Z';

/** 最小的内存端口（与 store.test.ts 的 FakeIo 同类，但不需要故障注入） */
class MemIo implements MemoryStoreIo {
  files = new Map<string, string>();
  writes: string[] = [];

  private key(name: string, subdir?: string): string {
    return subdir ? `${subdir}/${name}` : name;
  }

  async list(subdir?: string): Promise<string[]> {
    const prefix = subdir ? `${subdir}/` : '';
    return [...this.files.keys()]
      .filter((k) => (subdir ? k.startsWith(prefix) : !k.includes('/')))
      .map((k) => (subdir ? k.slice(prefix.length) : k))
      .sort();
  }

  async read(name: string, subdir?: string): Promise<string | null> {
    return this.files.get(this.key(name, subdir)) ?? null;
  }

  async replace(name: string, content: string, subdir?: string): Promise<void> {
    this.writes.push(`replace:${name}`);
    this.files.set(this.key(name, subdir), content);
  }

  async write(name: string, content: string, subdir?: string): Promise<void> {
    this.writes.push(`write:${name}`);
    this.files.set(this.key(name, subdir), content);
  }

  async appendLine(name: string, line: string, subdir?: string): Promise<void> {
    const k = this.key(name, subdir);
    this.files.set(k, `${this.files.get(k) ?? ''}${line}\n`);
  }

  async readLines(name: string, subdir?: string): Promise<string[]> {
    return ((await this.read(name, subdir)) ?? '').split('\n').filter(Boolean);
  }

  async remove(name: string, subdir?: string): Promise<void> {
    this.files.delete(this.key(name, subdir));
  }
}

function storeOn(io: MemIo) {
  return createUserMemoryStore({ io, userScope: SCOPE });
}

describe('Profile：canonical 与投影', () => {
  it('首次更新写 profile.json 与 user.md', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    const { profile, result } = await store.updateProfile({ name: '老王', timezone: 'UTC+8' }, NOW);

    expect(profile).toEqual({ name: '老王', timezone: 'UTC+8' });
    expect(result.changed.sort()).toEqual(['name', 'timezone']);

    const raw = await io.read(PROFILE_FILE);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as ProfileState;
    expect(parsed.schema).toBe(2);
    expect(parsed.userScope).toBe(SCOPE);
    expect(parsed.profile.name).toBe('老王');

    const doc = await io.read(USER_PROFILE_PROJECTION_FILE);
    expect(doc).toContain('姓名：老王');
    expect(doc).toContain('时区：UTC+8');
  });

  it('跨「重启」读回（新建仓储读同一份磁盘）', async () => {
    const io = new MemIo();
    await storeOn(io).updateProfile({ name: '老王' }, NOW);
    expect(await storeOn(io).loadProfile()).toEqual({ name: '老王' });
  });

  it('局部更新不动未出现的字段', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await store.updateProfile({ name: '老王', occupation: 'GIS 开发' }, NOW);
    await store.updateProfile({ city: '北京' }, new Date('2026-10-03T00:00:00Z'));
    expect(await store.loadProfile()).toEqual({
      name: '老王',
      occupation: 'GIS 开发',
      city: '北京',
    });
  });

  it('null 删除字段，投影同步移除该行', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await store.updateProfile({ name: '老王', city: '北京' }, NOW);
    await store.updateProfile({ city: null }, new Date('2026-10-03T00:00:00Z'));
    expect(await store.loadProfile()).toEqual({ name: '老王' });
    expect(await io.read(USER_PROFILE_PROJECTION_FILE)).not.toContain('常驻城市');
  });

  it('无变化的重试**不写盘**，但会修复过期投影', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await store.updateProfile({ name: '老王' }, NOW);
    const writesAfterFirst = [...io.writes];

    // 人为把投影改坏（模拟「JSON 已存、Markdown 写失败」或用户手改）
    await io.write(USER_PROFILE_PROJECTION_FILE, '- 姓名：别人\n');

    const { result } = await store.updateProfile({ name: '老王' }, new Date('2026-10-05T00:00:00Z'));
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual(['name']);
    // 没有重写 canonical（JSON 已是对的）
    expect(io.writes.filter((w) => w === `replace:${PROFILE_FILE}`).length).toBe(
      writesAfterFirst.filter((w) => w === `replace:${PROFILE_FILE}`).length,
    );
    // 但投影被修回来了
    expect(await io.read(USER_PROFILE_PROJECTION_FILE)).toContain('姓名：老王');
  });

  it('清空画像后投影被删除（不留一份含旧值的文档）', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await store.updateProfile({ name: '老王' }, NOW);
    await store.updateProfile({ name: null }, new Date('2026-10-03T00:00:00Z'));
    expect(await io.read(USER_PROFILE_PROJECTION_FILE)).toBeNull();
    expect(await store.loadProfile()).toEqual({});
  });

  it('非法字段整体拒绝，且不落盘', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await expect(store.updateProfile({ name: '老王', timezone: 8 }, NOW)).rejects.toThrow();
    expect(await io.read(PROFILE_FILE)).toBeNull();
  });

  it('归属不符的 profile.json → 拒绝读取（错误复制 / 传错用户）', async () => {
    const io = new MemIo();
    await io.write(
      PROFILE_FILE,
      JSON.stringify({ schema: 2, userScope: 'u_other', profile: { name: 'x' }, updatedAt: NOW.toISOString() }),
    );
    await expect(storeOn(io).loadProfile()).rejects.toThrow(/归属/);
  });
});

describe('Preference：canonical 与投影', () => {
  it('CREATED 落盘并重建投影', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    const { change, record } = await store.setPreference('response.language', 'Chinese', {}, NOW);
    expect(change).toBe('CREATED');
    expect(record.revision).toBe(1);

    const raw = await io.read(PREFERENCES_FILE);
    const parsed = JSON.parse(raw as string) as PreferenceState;
    expect(parsed.records).toHaveLength(1);
    expect(parsed.userScope).toBe(SCOPE);
    expect(await io.read(CURATED_MEMORY_FILE)).toContain('`response.language`：Chinese');
  });

  it('UNCHANGED 不写盘（重试不该产生写入）', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await store.setPreference('response.language', 'Chinese', {}, NOW);
    const writesBefore = [...io.writes];
    const { change } = await store.setPreference(
      'response.language',
      'Chinese',
      {},
      new Date('2026-10-09T00:00:00Z'),
    );
    expect(change).toBe('UNCHANGED');
    expect(io.writes).toEqual(writesBefore);
  });

  it('UPDATED 递增 revision 并重写投影', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await store.setPreference('editor.indent', 'tabs', {}, NOW);
    const { change, record } = await store.setPreference(
      'editor.indent',
      'spaces',
      {},
      new Date('2026-10-03T00:00:00Z'),
    );
    expect(change).toBe('UPDATED');
    expect(record.revision).toBe(2);
    const doc = await io.read(CURATED_MEMORY_FILE);
    expect(doc).toContain('spaces');
    expect(doc).not.toContain('tabs');
  });

  it('过期偏好**留在 canonical**、移出投影的 active 段并加说明', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await store.setPreference('response.detail', 'verbose', { expiresAt: EXPIRES }, NOW);

    // 过期前：出现在 active 段
    const before = await store.rebuildProjection(new Date('2026-10-31T00:00:00Z'));
    expect(before.memory).toContain('`response.detail`：verbose');
    expect(before.memory).not.toContain('已过期');

    // 过期后：记录仍在 canonical，但投影里被标为「不再注入」
    const after = await store.rebuildProjection(new Date('2026-11-02T00:00:00Z'));
    expect(after.memory).toContain('已过期');
    const parsed = JSON.parse((await io.read(PREFERENCES_FILE)) as string) as PreferenceState;
    expect(parsed.records).toHaveLength(1);

    // `activePreferences` 是纯读取：历史 asOf 不会写回当前状态
    const writesBefore = [...io.writes];
    expect(await store.activePreferences(new Date('2026-10-20T00:00:00Z'))).toHaveLength(1);
    expect(io.writes).toEqual(writesBefore);
  });

  it('activePreferences / expiredPreferences 的边界是 `< expiresAt`', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await store.setPreference('k.a', 'v', { expiresAt: EXPIRES }, NOW);
    expect(await store.activePreferences(new Date('2026-10-31T23:59:59Z'))).toHaveLength(1);
    expect(await store.activePreferences(new Date(EXPIRES))).toHaveLength(0);
    expect(await store.expiredPreferences(new Date(EXPIRES))).toHaveLength(1);
  });

  it('删除按 key 精确执行，并重建投影', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await store.setPreference('a.one', '1', {}, NOW);
    await store.setPreference('a.two', '2', {}, NOW);

    expect(await store.deletePreference('a.one', NOW)).toBe(true);
    const doc = await io.read(CURATED_MEMORY_FILE);
    expect(doc).not.toContain('a.one');
    expect(doc).toContain('a.two');

    // 重复删 = no-op
    expect(await store.deletePreference('a.one', NOW)).toBe(false);
  });

  it('全部偏好删完后投影文件被删除（不留空文件当幽灵条目）', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await store.setPreference('a.one', '1', {}, NOW);
    await store.deletePreference('a.one', NOW);
    expect(await io.read(CURATED_MEMORY_FILE)).toBeNull();
  });

  it('归属不符的 preferences.json → 拒绝读取', async () => {
    const io = new MemIo();
    await io.write(
      PREFERENCES_FILE,
      JSON.stringify({ schema: 2, userScope: 'u_other', records: [], updatedAt: NOW.toISOString() }),
    );
    await expect(storeOn(io).loadPreferences()).rejects.toThrow(/归属/);
  });

  it('半截 JSON → 报错，而不是当成空偏好', async () => {
    const io = new MemIo();
    await io.write(PREFERENCES_FILE, '{"schema":2,"userScope":"u_testscope","recor');
    await expect(storeOn(io).loadPreferences()).rejects.toThrow(/不是合法 JSON/);
  });
});

describe('投影可重建（不变量 I6）', () => {
  it('两个投影被人为删掉后都能由 canonical 重建', async () => {
    const io = new MemIo();
    const store = storeOn(io);
    await store.updateProfile({ name: '老王', city: '北京' }, NOW);
    await store.setPreference('response.language', 'Chinese', {}, NOW);

    await io.remove(USER_PROFILE_PROJECTION_FILE);
    await io.remove(CURATED_MEMORY_FILE);
    expect(await io.read(USER_PROFILE_PROJECTION_FILE)).toBeNull();
    expect(await io.read(CURATED_MEMORY_FILE)).toBeNull();

    const { memory, userDoc } = await store.rebuildProjection(NOW);
    expect(userDoc).toContain('姓名：老王');
    expect(memory).toContain('`response.language`：Chinese');
    expect(await io.read(USER_PROFILE_PROJECTION_FILE)).toContain('姓名：老王');
    expect(await io.read(CURATED_MEMORY_FILE)).toContain('response.language');
  });

  it('canonical 写坏时重建抛错（不静默产出空投影）', async () => {
    const io = new MemIo();
    await io.write(PROFILE_FILE, '{ 坏 JSON');
    await expect(storeOn(io).rebuildProjection(NOW)).rejects.toThrow();
  });
});
