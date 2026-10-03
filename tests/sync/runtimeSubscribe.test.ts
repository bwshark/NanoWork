/**
 * 单例可用性订阅（`subscribeSyncRuntime`）。
 *
 * 锁的是一条**真实会坏、坏了还不报错**的路径：侧栏账户入口在首屏就挂载，而同步运行时
 * 要等 App 启动块 `await` 完设备号与会话列表才出现。没有广播，那个组件读到的就永远是
 * `null`——冷启动时已登录的用户会一直看到「登录」，而且不会自己变回来。
 *
 * 这里用**真实单例**（不注入假 runtime）：被测的就是「单例出现 / 释放会不会广播」，
 * 换成假的等于把要验的东西替掉。fetch 注入成必失败，保证用例绝不出网。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeSyncRuntime,
  getSyncRuntime,
  initSyncRuntime,
  subscribeSyncRuntime,
} from '@/sync';

/** 绝不真出网的 fetch（本用例不登录，正常情况下它根本不会被调用） */
const offlineFetch = (() =>
  Promise.reject(new Error('offline'))) as unknown as typeof fetch;

afterEach(() => {
  disposeSyncRuntime();
});

describe('subscribeSyncRuntime', () => {
  it('单例出现与释放各广播一次', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeSyncRuntime(() => {
      seen.push(getSyncRuntime() !== null);
    });

    expect(getSyncRuntime()).toBeNull();

    await initSyncRuntime({ fetchImpl: offlineFetch });
    expect(seen, '单例出现未广播').toEqual([true]);

    disposeSyncRuntime();
    expect(seen, '单例释放未广播').toEqual([true, false]);

    unsubscribe();
  });

  it('取消订阅后不再收到广播', async () => {
    let calls = 0;
    const unsubscribe = subscribeSyncRuntime(() => {
      calls += 1;
    });
    unsubscribe();

    await initSyncRuntime({ fetchImpl: offlineFetch });
    expect(calls).toBe(0);
  });

  it('重复 init 不会重复广播（幂等单例）', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeSyncRuntime(() => {
      seen.push(true);
    });

    await initSyncRuntime({ fetchImpl: offlineFetch });
    await initSyncRuntime({ fetchImpl: offlineFetch });
    expect(seen).toHaveLength(1);

    unsubscribe();
  });
});
