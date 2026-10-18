/**
 * 单实例锁（FR-13.1）。
 *
 * 这里钉的是两条**安全关键**路径，缺任何一条这个模块就等于没写：
 * ① 抢锁失败 → 只 exit，**不注册监听、不建窗、不拉引擎**（否则第二个实例会与主实例抢端口）；
 * ② 抢锁成功 → 注册 second-instance，用于唤起既有窗口。
 *
 * 变异验证：把 `if (!isPrimary) { host.exit(0); return … }` 改成「不退出直接返回」，
 * 用例 2 的 `exit` 断言必须变红。
 */

import { describe, expect, it, vi } from 'vitest';
import { acquireSingleInstance, type SingleInstanceHost } from '../../electron/singleInstance';

type SecondInstanceListener = (argv: readonly string[], workingDirectory: string) => void;

function createHost(lockGranted: boolean) {
  const listeners: SecondInstanceListener[] = [];
  const exit = vi.fn();
  const host: SingleInstanceHost = {
    requestSingleInstanceLock: () => lockGranted,
    onSecondInstance: (listener) => {
      listeners.push(listener);
    },
    exit,
  };
  return { host, listeners, exit };
}

describe('acquireSingleInstance', () => {
  it('拿到锁时返回 isPrimary 并注册 second-instance 监听', () => {
    const { host, listeners, exit } = createHost(true);

    const result = acquireSingleInstance(host, () => {});

    expect(result.isPrimary).toBe(true);
    expect(listeners).toHaveLength(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('抢锁失败时立即退出，且不做任何其它事', () => {
    const { host, listeners, exit } = createHost(false);
    const onSecondInstance = vi.fn();

    const result = acquireSingleInstance(host, onSecondInstance);

    expect(result.isPrimary).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
    // 第二个实例马上就要没了：注册监听没有接收方，只会误导读者
    expect(listeners).toHaveLength(0);
    expect(onSecondInstance).not.toHaveBeenCalled();
  });

  it('second-instance 触发时把 argv / 工作目录一起交给回调', () => {
    const { host, listeners } = createHost(true);
    const onSecondInstance = vi.fn();

    acquireSingleInstance(host, onSecondInstance);
    expect(listeners).toHaveLength(1);

    const argv = ['nanowork.exe', '--foo', 'nanowork://open-session?id=abc'];
    listeners[0](argv, 'D:\\Workspace');

    expect(onSecondInstance).toHaveBeenCalledTimes(1);
    // B4-02：深链就在 argv 里。吞掉参数会让「双击链接」只唤起窗口、不打开会话。
    expect(onSecondInstance).toHaveBeenCalledWith(argv, 'D:\\Workspace');
  });
});
