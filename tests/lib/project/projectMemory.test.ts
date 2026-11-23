import { describe, expect, it } from 'vitest';

import {
  buildProjectMemorySection,
  formatProjectMemoryUpdated,
  normalizeProjectMemoryText,
  validateProjectMemoryText,
} from '@/lib/project/projectMemory';
import {
  PROJECT_MEMORY_TAG_CLOSE,
  PROJECT_MEMORY_TAG_OPEN,
} from '@/lib/core/constants';

describe('normalizeProjectMemoryText', () => {
  it('把 CRLF 收成 LF', () => {
    expect(normalizeProjectMemoryText('第一行\r\n第二行')).toBe('第一行\n第二行');
  });

  it('去掉 BOM', () => {
    expect(normalizeProjectMemoryText('\uFEFF正文')).toBe('正文');
  });

  it('不动缩进与空行（Markdown 里缩进是语义）', () => {
    const text = '## 约定\n\n```js\n    const a = 1;\n```\n';
    expect(normalizeProjectMemoryText(text)).toBe(text);
  });
});

describe('validateProjectMemoryText', () => {
  it('空正文是合法的（清空共享记忆是一个真实动作）', () => {
    expect(validateProjectMemoryText('', 20).ok).toBe(true);
  });

  it('恰好等于上限时通过', () => {
    expect(validateProjectMemoryText('字'.repeat(20), 20)).toEqual({
      ok: true,
      message: '',
    });
  });

  it('超长报错而不是截断，且提示里带上限与当前长度', () => {
    const result = validateProjectMemoryText('字'.repeat(21), 20);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('20');
    expect(result.message).toContain('21');
  });

  it('上限为 0 表示服务端没给值，此时不拦（不要在客户端猜一个上限）', () => {
    expect(validateProjectMemoryText('很长'.repeat(100), 0).ok).toBe(true);
  });
});

describe('buildProjectMemorySection', () => {
  it('空正文不注入任何段——不要塞「暂无共享记忆」占位句', () => {
    expect(buildProjectMemorySection({ text: '' })).toBe('');
    // 只有空白也算空：否则模型会读到一段看起来「有内容」的空标签
    expect(buildProjectMemorySection({ text: '   \n\n ' })).toBe('');
  });

  it('有正文时包上标签、写明项目名并给出两条边界指令', () => {
    const section = buildProjectMemorySection({
      text: '本项目一律用 pnpm。',
      projectName: '登月计划',
    });
    expect(section.startsWith(PROJECT_MEMORY_TAG_OPEN)).toBe(true);
    expect(section.endsWith(PROJECT_MEMORY_TAG_CLOSE)).toBe(true);
    expect(section).toContain('登月计划');
    expect(section).toContain('本项目一律用 pnpm。');
    // 团队约定优先于模型自己的假设
    expect(section).toContain('以它为准');
    // 用户本轮最新说法优先于这段快照
    expect(section).toContain('以用户最新说法为准');
  });

  it('没有项目名时不出现空引号', () => {
    const section = buildProjectMemorySection({ text: '正文' });
    expect(section).not.toContain('「」');
    expect(section).toContain('本项目（团队共享）的记忆');
  });
});

describe('formatProjectMemoryUpdated', () => {
  it('从未写过时说「尚未填写」，而不是一个空时间', () => {
    expect(formatProjectMemoryUpdated('', '')).toBe('尚未填写');
  });

  it('带写入人时显示邮箱', () => {
    const label = formatProjectMemoryUpdated('2026-11-17T10:00:00Z', 'boss@corp.example');
    expect(label).toContain('boss@corp.example');
    expect(label).toContain('更新');
  });

  it('没有写入人时只说更新，不补一个假名字', () => {
    const label = formatProjectMemoryUpdated('2026-11-17T10:00:00Z', '');
    expect(label).toBe(label.trim());
    expect(label.endsWith('更新')).toBe(true);
    expect(label).not.toContain('·');
  });

  it('时间解析不了就原样回 ISO 串（吞成「—」会让格式变化彻底看不见）', () => {
    expect(formatProjectMemoryUpdated('not-a-date', 'boss@corp.example')).toContain(
      'not-a-date',
    );
  });
});
