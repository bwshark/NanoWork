/**
 * 侧边栏工作空间分组的合并规则。
 *
 * 用户报的现象：侧边栏出现两个组——「默认工作空间」（历史会话，`workdir` 为空）与
 * 「NanoWork」（新会话，`workdir` = 默认工作空间路径），而两者指向的是同一个目录。
 * 成因是默认工作空间**先后有两种落盘形态**：
 *   1. 该设置项存在之前建的会话，`workdir` 是 `undefined`（发消息时兜底补默认路径）；
 *   2. 之后建的会话，`workdir` 在建的时候就写成了默认路径。
 * 分组只认 `workdir` 字面量，于是把它们拆成了两组。
 *
 * 现在按「**语义**」分组：落在当前默认工作空间上的会话与未指定工作空间的会话同组，
 * 组名固定叫「默认工作空间」，组的 `fullPath` 是它当前的真实落点（悬停可见）。
 */

import { describe, expect, it } from 'vitest';
import { groupSessionsByWorkdir } from '@/layout/SidebarNav';
import { DEFAULT_WORKSPACE_LABEL } from '@/lib/workspaceLabel';
import type { Session } from '@/types';

const DEFAULT_DIR = 'C:\\Users\\tester\\NanoWork';
const OTHER_DIR = 'D:\\work\\ranch';

function session(id: string, workdir?: string, updatedAt = '2026-09-19T10:00:00.000Z'): Session {
  return {
    id,
    agentId: '',
    title: id,
    messages: [],
    permissionLog: [],
    createdAt: updatedAt,
    updatedAt,
    ...(workdir ? { workdir } : {}),
  };
}

describe('groupSessionsByWorkdir：默认工作空间是一个语义分组', () => {
  it('未指定工作空间的会话与落在默认路径上的会话合并成一个默认组', () => {
    const groups = groupSessionsByWorkdir(
      [session('legacy'), session('bound', DEFAULT_DIR)],
      undefined,
      DEFAULT_DIR,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('');
    expect(groups[0].label).toBe(DEFAULT_WORKSPACE_LABEL);
    expect(groups[0].defaultLabel).toBe(DEFAULT_WORKSPACE_LABEL);
    expect(groups[0].sessions.map((s) => s.id).sort()).toEqual(['bound', 'legacy']);
    // 组的落点是它当前的真实目录：悬停提示据此显示「任务到底存在哪儿」
    expect(groups[0].fullPath).toBe(DEFAULT_DIR);
  });

  it('字面量有差异（大小写 / 尾部分隔符）也归入同一个默认组', () => {
    const groups = groupSessionsByWorkdir(
      [
        session('a', DEFAULT_DIR),
        session('b', `${DEFAULT_DIR}\\`),
        session('c', 'c:\\users\\tester\\nanowork'),
      ],
      undefined,
      DEFAULT_DIR,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(3);
  });

  it('显式指定的其它目录各自成组，组名取末级目录名，默认组置底', () => {
    const groups = groupSessionsByWorkdir(
      [
        session('custom', OTHER_DIR, '2026-09-19T12:00:00.000Z'),
        session('bound', DEFAULT_DIR, '2026-09-19T11:00:00.000Z'),
      ],
      undefined,
      DEFAULT_DIR,
    );

    expect(groups.map((g) => g.label)).toEqual(['ranch', DEFAULT_WORKSPACE_LABEL]);
    expect(groups[0].key).toBe(OTHER_DIR);
    expect(groups[0].fullPath).toBe(OTHER_DIR);
  });

  it('默认路径未知（存储信息未就绪 / Web 端）时不合并，也不丢会话', () => {
    // 这是个几十毫秒的降级窗口：此时无法判断谁落在默认路径上，于是按原来的字面量
    // 分组。宁可短暂地看到两个组，也不要凭猜把「D:\work\ranch」当成默认路径并组。
    const groups = groupSessionsByWorkdir(
      [session('legacy'), session('bound', DEFAULT_DIR)],
      undefined,
      undefined,
    );

    expect(groups.map((g) => g.sessions.length)).toEqual([1, 1]);
    expect(groups.map((g) => g.label).sort()).toEqual([
      'NanoWork',
      DEFAULT_WORKSPACE_LABEL,
    ]);
  });

  it('用户改了默认路径后，留在旧默认路径上的会话自成一组（不再冒充默认组）', () => {
    const NEW_DEFAULT = 'D:\\dev\\new-home';
    const groups = groupSessionsByWorkdir(
      [session('old', DEFAULT_DIR), session('new', NEW_DEFAULT)],
      undefined,
      NEW_DEFAULT,
    );

    expect(groups.map((g) => g.label).sort()).toEqual([
      'NanoWork',
      DEFAULT_WORKSPACE_LABEL,
    ]);
    // 「NanoWork」那组仍是可操作的真实目录分组（有自己的 fullPath）
    const old = groups.find((g) => g.label === 'NanoWork');
    expect(old?.fullPath).toBe(DEFAULT_DIR);
  });
});

/**
 * 「0 个任务的工作空间」不再成组。
 *
 * 这里曾有一条反向规则：把某工作空间下最后一条任务切走/删掉后，用户以为「工作空间
 * 丢了」，于是引入 `settings.knownWorkspaces` 给空工作空间补分组。产品口径后来改成
 * 相反的一条：**工作空间下没有对话记录就不显示这个分组**——空分组会给用户一个点进去
 * 什么都没有的入口，比「分组消失」更容易误解成数据丢了。故补组逻辑连同参数一并移除。
 *
 * 「谁算有对话记录」的判据在 `@/lib/conversation`（不能只看 `messages.length`，
 * 消息是按需水合的），组合行为见 `tests/sessionsStartupList.test.ts`。
 */
describe('groupSessionsByWorkdir：没有任务的工作空间不成组', () => {
  it('没有会话就没有分组（不再补空分组占位）', () => {
    expect(groupSessionsByWorkdir([], undefined, DEFAULT_DIR)).toHaveLength(0);
  });

  it('每个分组至少带一条任务，默认组也不例外', () => {
    const groups = groupSessionsByWorkdir(
      [session('a', OTHER_DIR), session('b')],
      undefined,
      DEFAULT_DIR,
    );

    expect(groups.map((g) => g.label).sort()).toEqual(
      [DEFAULT_WORKSPACE_LABEL, 'ranch'].sort(),
    );
    for (const g of groups) expect(g.sessions.length).toBeGreaterThan(0);
  });
});
