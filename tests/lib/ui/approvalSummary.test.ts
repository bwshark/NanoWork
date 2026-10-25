/**
 * 审批卡片摘要的纯函数契约（`@/lib/ui/approvalSummary`）。
 *
 * 这组用例锁的是**判据**而不是文案格式，因为摘要句是用户决定放不放行的
 * 唯一依据，两类错都不能容忍：
 *
 * - **认错**：把 `apply_patch` 的多文件改动说成一个文件 → 用户以为影响面很
 *   小，批准了一个自己没看懂的改动；
 * - **硬编**：认不出的工具编一句「执行操作」冒充结论 → 用户以为看懂了，
 *   实际什么都没说。这类必须返回 `summary: null` 让调用方走完整参数兜底。
 *
 * 因此断言分三档：认得准（多文件 / 路径截断）、认得全（六类工具各一条）、
 * 认不出就承认（MCP 与非 MCP 各一条）。
 */

import { describe, expect, it } from 'vitest';
import { approvalActionLabel, describeApproval } from '@/lib/ui/approvalSummary';

describe('describeApproval：认得出的工具给出准确摘要', () => {
  it('write_file / edit_file 用参数里的路径', () => {
    expect(
      describeApproval('write_file', { path: 'D:/tmp/a.js', content: 'x' }).summary,
    ).toBe('写入文件 D:/tmp/a.js');
    expect(
      describeApproval('edit_file', { path: '/home/u/b.md' }).summary,
    ).toBe('编辑文件 /home/u/b.md');
  });

  it('路径的三种写法（path / file_path / file）都认', () => {
    for (const key of ['path', 'file_path', 'filepath', 'file']) {
      expect(
        describeApproval('write_file', { [key]: 'C:/x/y.txt' }).summary,
      ).toBe('写入文件 C:/x/y.txt');
    }
  });

  it('delete_file 的摘要要写明「删除」，这是唯一不可逆的一类', () => {
    expect(
      describeApproval('delete_file', { path: 'C:/tmp/old.js' }).summary,
    ).toBe('删除文件 C:/tmp/old.js');
  });

  it('exec 用 command（也认 cmd 这个别名）', () => {
    expect(describeApproval('exec', { command: 'ls -la' }).summary).toBe(
      '执行命令 ls -la',
    );
    expect(describeApproval('exec', { cmd: 'pwd' }).summary).toBe('执行命令 pwd');
  });

  it('apply_patch 单文件时说一个文件', () => {
    expect(
      describeApproval('apply_patch', {
        edits: [{ path: 'a.py', action: 'replace', old_text: 'x', new_text: 'y' }],
      }).summary,
    ).toBe('修改文件 a.py');
  });

  it('apply_patch 多文件时必须报出文件数，否则用户会低估影响面', () => {
    const summary = describeApproval('apply_patch', {
      edits: [
        { path: 'a.py', action: 'replace' },
        { path: 'b.py', action: 'replace' },
        { path: 'c.py', action: 'replace' },
      ],
    }).summary;
    expect(summary).toContain('3 个文件');
    expect(summary).toContain('a.py');
    expect(summary).toContain('b.py');
  });

  it('apply_patch 的重复路径只算一次（同文件多次编辑很常见）', () => {
    expect(
      describeApproval('apply_patch', {
        edits: [{ path: 'a.py' }, { path: 'a.py' }, { path: 'a.py' }],
      }).summary,
    ).toBe('修改文件 a.py');
  });
});

describe('describeApproval：认不出就不编', () => {
  it('MCP 工具用服务名 + 方法名概括（名字本身是唯一可读信息）', () => {
    expect(
      describeApproval('mcp__github__create_issue', { title: 'x' }).summary,
    ).toBe('调用 github 的 create_issue');
  });

  it('未知工具返回 null —— 调用方据此退回完整参数兜底', () => {
    expect(describeApproval('some_future_tool', { a: 1 }).summary).toBeNull();
  });

  it('缺关键参数时返回 null，而不是拼一句半截话', () => {
    // 只有 content 没有 path：说明这不是一次正常的 write_file，宁可不猜
    expect(describeApproval('write_file', { content: 'x' }).summary).toBeNull();
    expect(describeApproval('exec', {}).summary).toBeNull();
    expect(describeApproval('apply_patch', { edits: 'not-an-array' }).summary).toBeNull();
  });

  it('args 缺省 / 为 null 时按空对象处理，不抛', () => {
    expect(() => describeApproval('exec', null)).not.toThrow();
    expect(describeApproval('exec', undefined).rows).toEqual([]);
  });
});

describe('describeApproval：参数行不丢信息', () => {
  it('参数行覆盖全部入参，键名原样保留（用户要能和模型的说法对上）', () => {
    const { rows } = describeApproval('write_file', { path: 'a.js', content: 'hi' });
    expect(rows.map((r) => r.label)).toEqual(['path', 'content']);
    expect(rows.find((r) => r.label === 'content')?.value).toBe('hi');
  });

  it('超长值被截断但保留尾部——路径 / 命令的区分度都在尾部', () => {
    const long = `${'a'.repeat(400)}/unique-tail.js`;
    const row = describeApproval('write_file', { content: long }).rows[0];
    expect(row.value.length).toBeLessThanOrEqual(161);
    expect(row.value).toContain('…');
    expect(row.value.endsWith('unique-tail.js')).toBe(true);
  });

  it('非字符串参数按 JSON 简写归一，不会渲染成 [object Object]', () => {
    const { rows } = describeApproval('unknown_tool', { nested: { a: 1 }, n: 3 });
    expect(rows.find((r) => r.label === 'nested')?.value).toBe('{"a":1}');
    expect(rows.find((r) => r.label === 'n')?.value).toBe('3');
  });
});

describe('approvalActionLabel：兜底标题', () => {
  it('认得的工具给人话，认不得的给「执行操作」', () => {
    expect(approvalActionLabel('exec')).toBe('执行命令');
    expect(approvalActionLabel('mcp__fs__read')).toBe('调用 MCP 工具');
    expect(approvalActionLabel('brand_new')).toBe('执行操作');
  });
});
