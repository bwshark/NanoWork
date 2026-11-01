/**
 * 专家定义 Markdown 的解析（插件包内 `agents/*.md`）。
 *
 * 这里守的是「同一份 md 两个读者」（主进程扫描 + 渲染层预览）不会漂移。
 * 断言集中在模型真实会写出来的那几种形态上：中英双写、带引号、缺 frontmatter。
 */

import { describe, expect, it } from 'vitest';
import {
  expertAgentDisplayName,
  parseExpertAgentMarkdown,
} from '@/lib/agent/expertAgentMarkdown';

const WITH_FRONTMATTER = [
  '---',
  'name: react-dev',
  'description: Frontend expert',
  'displayName:',
  '  en: "React Engineer"',
  '  zh: "前端工程师"',
  'profession:',
  '  en: Frontend Engineer',
  '  zh: 前端工程师',
  'maxTurns: 80',
  '---',
  '',
  '# 前端工程师',
  '',
  '你负责前端架构。',
].join('\n');

describe('parseExpertAgentMarkdown', () => {
  it('解析中英双写字段，正文不含 frontmatter', () => {
    const parsed = parseExpertAgentMarkdown(WITH_FRONTMATTER);
    expect(parsed.frontmatter.name).toBe('react-dev');
    expect(parsed.frontmatter.description).toBe('Frontend expert');
    expect(parsed.frontmatter.displayName).toEqual({
      en: 'React Engineer',
      zh: '前端工程师',
    });
    expect(parsed.frontmatter.profession).toEqual({
      en: 'Frontend Engineer',
      zh: '前端工程师',
    });
    expect(parsed.frontmatter.maxTurns).toBe(80);
    expect(parsed.body.startsWith('# 前端工程师')).toBe(true);
    expect(parsed.body).not.toContain('---');
  });

  it('没有 frontmatter 的手写 md 也照常解析（不该因为缺格式就丢文件）', () => {
    const parsed = parseExpertAgentMarkdown('# 随便写的\n\n正文');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe('# 随便写的\n\n正文');
  });

  it('frontmatter 写坏时降级为空字段，正文仍完整', () => {
    const parsed = parseExpertAgentMarkdown(['---', '这不是键值对', '---', '正文'].join('\n'));
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe('正文');
  });

  it('CRLF 换行同样能切开 frontmatter', () => {
    const crlf = WITH_FRONTMATTER.replace(/\n/g, '\r\n');
    const parsed = parseExpertAgentMarkdown(crlf);
    expect(parsed.frontmatter.name).toBe('react-dev');
    expect(parsed.body).toContain('你负责前端架构');
  });
});

describe('expertAgentDisplayName', () => {
  it('优先级：displayName.zh > name > 文件名', () => {
    expect(
      expertAgentDisplayName(parseExpertAgentMarkdown(WITH_FRONTMATTER), 'file-name'),
    ).toBe('前端工程师');
    expect(
      expertAgentDisplayName(
        parseExpertAgentMarkdown('---\nname: only-name\n---\nbody'),
        'file-name',
      ),
    ).toBe('only-name');
    expect(expertAgentDisplayName(parseExpertAgentMarkdown('body'), 'file-name')).toBe(
      'file-name',
    );
  });

  it('不拿 profession 兜底（否则会出现两个都叫「架构师」的专家）', () => {
    const parsed = parseExpertAgentMarkdown('---\nprofession:\n  zh: 架构师\n---\nbody');
    expect(expertAgentDisplayName(parsed, 'agent-1')).toBe('agent-1');
  });
});
