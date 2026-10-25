import { describe, expect, it } from 'vitest';
import {
  INITIAL_REV,
  LEGACY_REV,
  isTombstone,
  markDeleted,
  markDirty,
  stampCreate,
} from '@/lib/sync/syncMeta';

const NOW = '2026-09-25T10:00:00.000Z';
const LATER = '2026-09-25T11:30:00.000Z';
const DEV = 'dev-a';

describe('stampCreate', () => {
  it('新建 = rev 1 + 非墓碑，时间与修改者取自入参', () => {
    expect(stampCreate(DEV, NOW)).toEqual({
      rev: INITIAL_REV,
      updatedAt: NOW,
      updatedBy: DEV,
      deletedAt: null,
    });
  });

  it('rev 从 1 起：0 是留给老数据的保留值，两者绝不能撞车', () => {
    // 撞车的后果是 LWW 判不出「新建的这条」与「从没被改写过的老条目」谁更新
    expect(stampCreate(DEV, NOW).rev).toBe(1);
    expect(INITIAL_REV).not.toBe(LEGACY_REV);
  });

  it('缺省时刻取当前时钟，形态是 ISO 字符串', () => {
    expect(stampCreate(DEV).updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('markDirty', () => {
  it('rev 递增 1，并刷新时间与修改者', () => {
    const dirty = markDirty(stampCreate(DEV, NOW), 'dev-b', LATER);
    expect(dirty).toEqual({ rev: 2, updatedAt: LATER, updatedBy: 'dev-b', deletedAt: null });
  });

  it('老数据改动后 rev = 1，不是 2、更不是 NaN', () => {
    expect(markDirty(undefined, DEV, NOW).rev).toBe(1);
    expect(markDirty(null, DEV, NOW).rev).toBe(1);
    expect(markDirty({}, DEV, NOW).rev).toBe(1);
  });

  it('脏 rev（NaN / 字符串 / null）按老数据读，绝不产出 NaN', () => {
    // `NaN + 1` 一旦落盘就再也认不出来源：任何比较都是 false，同步层会永远判它「无版本」
    expect(markDirty({ rev: Number.NaN }, DEV, NOW).rev).toBe(1);
    expect(markDirty({ rev: '3' as unknown as number }, DEV, NOW).rev).toBe(1);
    expect(markDirty({ rev: null as unknown as number }, DEV, NOW).rev).toBe(1);
    expect(markDirty({ rev: Number.POSITIVE_INFINITY }, DEV, NOW).rev).toBe(1);
  });

  it('老数据的 updatedAt / updatedBy 缺字段读成空串，不是 undefined', () => {
    const dirty = markDirty({}, DEV, NOW);
    expect(dirty.updatedAt).toBe(NOW);
    expect(dirty.updatedBy).toBe(DEV);
  });

  it('不复活墓碑：编辑一条已删条目时 deletedAt 原样保留', () => {
    const deleted = markDeleted(stampCreate(DEV, NOW), DEV, NOW);
    const edited = markDirty(deleted, 'dev-b', LATER);
    expect(edited.deletedAt).toBe(deleted.deletedAt);
    // 建(1) → 删(2) → 改(3)：改动照常递增版本，但不把墓碑清掉
    expect(edited.rev).toBe(3);
  });

  it('是纯函数：不改入参', () => {
    const created = stampCreate(DEV, NOW);
    const snapshot = { ...created };
    markDirty(created, 'dev-b', LATER);
    expect(created).toEqual(snapshot);
  });
});

describe('markDeleted', () => {
  it('首次删除：写 deletedAt 并 rev +1', () => {
    expect(markDeleted(stampCreate(DEV, NOW), DEV, LATER)).toEqual({
      rev: 2,
      updatedAt: LATER,
      updatedBy: DEV,
      deletedAt: LATER,
    });
  });

  it('幂等：已是墓碑再删一次什么都不改，连 rev 都不动', () => {
    const first = markDeleted(stampCreate(DEV, NOW), DEV, NOW);
    const second = markDeleted(first, 'dev-b', LATER);
    expect(second).toEqual(first);
    expect(second.rev).toBe(first.rev);
    expect(second.deletedAt).toBe(first.deletedAt);
  });

  it('老数据删除后 rev = 1 且带墓碑', () => {
    const deleted = markDeleted(undefined, DEV, NOW);
    expect(deleted.rev).toBe(1);
    expect(deleted.deletedAt).toBe(NOW);
  });

  it('空串 deletedAt 是脏数据：不能让它变成「删不掉的条目」', () => {
    // 判据说它不是墓碑，那么写入就必须真的写下墓碑 —— 两边同源才不会打架
    const deleted = markDeleted({ rev: 1, deletedAt: '' }, DEV, NOW);
    expect(deleted.deletedAt).toBe(NOW);
    expect(isTombstone(deleted)).toBe(true);
    expect(deleted.rev).toBe(2);
  });

  it('是纯函数：不改入参', () => {
    const created = stampCreate(DEV, NOW);
    const snapshot = { ...created };
    markDeleted(created, DEV, LATER);
    expect(created).toEqual(snapshot);
  });
});

describe('isTombstone', () => {
  it('缺字段 / null / 空串都算存活（老数据不能被判成已删除）', () => {
    expect(isTombstone(undefined)).toBe(false);
    expect(isTombstone(null)).toBe(false);
    expect(isTombstone({})).toBe(false);
    expect(isTombstone({ deletedAt: null })).toBe(false);
    expect(isTombstone({ deletedAt: '' })).toBe(false);
    expect(isTombstone({ deletedAt: '   ' })).toBe(false);
  });

  it('有时间即墓碑', () => {
    expect(isTombstone({ deletedAt: NOW })).toBe(true);
    expect(isTombstone(markDeleted(stampCreate(DEV, NOW), DEV, NOW))).toBe(true);
    expect(isTombstone(markDirty(undefined, DEV, NOW))).toBe(false);
  });
});
