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

describe('MemoryService：两层合并注入（P0 修复）', () => {
  /**
   * 修复前的症状：`loadMemoryInto` 只读 `workspace` 一层，而 `sedimentSession`
   * 从 P1-B 起把身份类事实写进 `user` 层——「在 A 工作区告诉过它我叫什么，
   * 换到 B 工作区就问不出来」，记忆其实就躺在 `~/.nanowork/MEMORY.md` 里。
   */
  it('两层都有内容时，用户级在前、工作区级在后', async () => {
    await MemoryService.save('用户级：用户叫明明', 'user');
    await MemoryService.save('工作区级：先修 P0');

    const { text } = await MemoryService.loadForInjection('default');

    expect(text).toContain('用户级：用户叫明明');
    expect(text).toContain('工作区级：先修 P0');
    // 定序是硬约束：护栏句写着「冲突时以用户级为准」，顺序反了那句就指向空处
    expect(text.indexOf('用户级：用户叫明明')).toBeLessThan(text.indexOf('工作区级：先修 P0'));
  });

  it('只写了用户级也会被读到（修复前只读工作区级，这里会是空块）', async () => {
    await MemoryService.save('用户级身份事实', 'user');

    const { text, entries } = await MemoryService.loadForInjection('default');

    expect(text).toContain('用户级身份事实');
    expect(entries).toBe(1);
  });

  it('两层皆空返回空串与零条数', async () => {
    const { text, entries } = await MemoryService.loadForInjection('default');
    expect(text).toBe('');
    expect(entries).toBe(0);
  });

  it('段标题不进条数：entries 是两段各自计数之和', async () => {
    await MemoryService.save('用户段', 'user');
    await MemoryService.save('工作区段');

    const { entries } = await MemoryService.loadForInjection('default');

    // 标题用 `【…】` 而非 `## `，正是为了不干扰 countEntries 的二级标题计数
    expect(entries).toBe(2);
  });

  it('工作区段按显式 key 取，不受 currentKey 影响', async () => {
    await MemoryService.save('A 区内容', 'workspace', 'ws-a');
    await MemoryService.save('B 区内容', 'workspace', 'ws-b');
    MemoryService.useWorkspace('ws-b');

    const { text } = await MemoryService.loadForInjection('ws-a');

    expect(text).toContain('A 区内容');
    expect(text).not.toContain('B 区内容');
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

  /**
   * FR-4.2 的实现对齐：用户级**可以**被自动写入，但仅限**身份类**事实。
   *
   * 旧断言要求说明里出现「显式」二字（当时语义是「只有用户亲手写才进这一层」）。
   * 那种解读过窄：称呼/职业是跨项目事实，自动沉淀丢掉它们就等于每次新会话都要
   * 重新自我介绍——这正是本轮修复的 bug。说明文案因此改成「列写入方」，
   * 断言也随之改为检查两个写入方都在、且身份类被点名。
   */
  it('用户级作用域的说明列明两个写入方，并点名身份类事实（FR-4.2）', async () => {
    const summaries = await MemoryService.scopeSummaries();
    const user = summaries.find((s) => s.scope === 'user');
    expect(user?.description).toMatch(/手动编辑/);
    expect(user?.description).toMatch(/身份/);
  });
});
