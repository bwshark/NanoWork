/**
 * 记忆作用域分层（FR-4.2 / design §14.1 的 L2 / L3）。
 *
 * 两条必须钉住的语义：
 *
 * 1. **缺省作用域是 `workspace`**——既有 40 余处调用点拿到的行为不能变，
 *    否则「会话结束自动沉淀」会静默写进用户级长期记忆。
 * 2. **两层互不串台**：`user` 落 `~/.nanowork/MEMORY.md`，`workspace` 落
 *    `~/.nanowork/memory/<key>.md`。串台的症状是「清空工作区记忆把用户级也清了」。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryService } from '@/lib/memory';
import { MEMORY_KEY_PREFIX, USER_MEMORY_KEY } from '@/lib/constants';

beforeEach(() => {
  window.localStorage.clear();
  MemoryService.useWorkspace('default');
});

describe('MemoryService：作用域隔离', () => {
  it('缺省作用域是工作区（既有调用点行为不变）', async () => {
    await MemoryService.save('工作区内容');
    expect(await window.localStorage.getItem(`${MEMORY_KEY_PREFIX}default`)).toBe(
      JSON.stringify('工作区内容'),
    );
  });

  it('user 作用域落到独立的 storage key', async () => {
    await MemoryService.save('跨项目内容', 'user');
    expect(await window.localStorage.getItem(USER_MEMORY_KEY)).toBe(
      JSON.stringify('跨项目内容'),
    );
    // 不得污染工作区
    expect(await MemoryService.load()).toBe('');
  });

  it('两层互不串台', async () => {
    await MemoryService.save('工作区层', 'workspace');
    await MemoryService.save('用户层', 'user');

    expect(await MemoryService.load('workspace')).toBe('工作区层');
    expect(await MemoryService.load('user')).toBe('用户层');
  });

  it('清空一层不影响另一层', async () => {
    await MemoryService.save('工作区层');
    await MemoryService.save('用户层', 'user');

    await MemoryService.clear('workspace');

    expect(await MemoryService.load('workspace')).toBe('');
    expect(await MemoryService.load('user')).toBe('用户层');
  });

  it('用户级作用域不随 useWorkspace 切换而改变', async () => {
    await MemoryService.save('用户层', 'user');

    MemoryService.useWorkspace('ws-other');

    expect(await MemoryService.load('user')).toBe('用户层');
    expect(await MemoryService.load('workspace')).toBe('');
  });

  it('工作区作用域仍然按 currentKey 隔离', async () => {
    await MemoryService.save('默认区');
    MemoryService.useWorkspace('ws-a');
    await MemoryService.save('A 区');

    expect(await MemoryService.load()).toBe('A 区');
    expect(await MemoryService.load('user')).toBe('');
  });
});

describe('MemoryService：作用域化追加', () => {
  it('append 到 user 作用域，带去重与时间戳', async () => {
    await MemoryService.append('用户偏好中文', { source: '记忆页' }, 'user');
    const text = await MemoryService.load('user');

    expect(text).toContain('用户偏好中文');
    expect(text).toContain('来自「记忆页」');
    expect(MemoryService.countEntries(text)).toBe(1);
  });

  it('append 的幂等去重在 user 作用域同样生效', async () => {
    await MemoryService.append('同样的内容', { source: 's' }, 'user');
    await MemoryService.append('同样的内容', { source: 's2' }, 'user');
    expect(MemoryService.countEntries(await MemoryService.load('user'))).toBe(1);
  });

  it('append 缺省仍写工作区作用域', async () => {
    await MemoryService.append('自动沉淀的内容', { source: 'auto' });
    expect(await MemoryService.load('user')).toBe('');
    expect(await MemoryService.load()).toContain('自动沉淀的内容');
  });

  it('空白内容不写入任何作用域', async () => {
    await MemoryService.append('   ', {}, 'user');
    expect(await MemoryService.load('user')).toBe('');
  });
});

describe('MemoryService：作用域概览', () => {
  it('返回用户级与工作区级两项，带展示元信息', async () => {
    await MemoryService.save('## 一条\n内容', 'user');
    await MemoryService.save('工作区内容');

    const summaries = await MemoryService.scopeSummaries();

    expect(summaries.map((s) => s.scope)).toEqual(['user', 'workspace']);
    for (const summary of summaries) {
      expect(summary.label.trim()).not.toBe('');
      expect(summary.description.trim()).not.toBe('');
    }
    const user = summaries.find((s) => s.scope === 'user');
    expect(user?.entries).toBe(1);
    expect(user?.chars).toBeGreaterThan(0);
  });

  it('空作用域返回零值而不是抛错', async () => {
    const summaries = await MemoryService.scopeSummaries();
    const user = summaries.find((s) => s.scope === 'user');
    expect(user?.entries).toBe(0);
    expect(user?.chars).toBe(0);
    expect(user?.lastWrittenAt).toBeNull();
  });

  it('用户级作用域的说明写明「显式要求才写」（FR-4.2）', async () => {
    const summaries = await MemoryService.scopeSummaries();
    const user = summaries.find((s) => s.scope === 'user');
    expect(user?.description).toMatch(/显式/);
  });
});
