/**
 * SKILL.md frontmatter 解析（FR-3.1）。
 *
 * 这一版新增了两个真实约束字段：`allowed-tools`（工具白名单，是**真实限制**
 * 而不是建议）与 `user-invocable`（是否出现在用户的直接调用入口）。
 * 两者都是「解析失败就静默消失」的类型——字段名带连字符，解析器的 key 正则
 * 只认 `\w` 就会把整行丢掉，界面上什么都不显示、也没人会发现。
 */

import { describe, expect, it } from 'vitest';
import { parseSkillFromMarkdown } from '@/lib/agent/skillParser';

const BODY = '正文：步骤与校验方式。';

function md(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\n${BODY}`;
}

describe('基础字段', () => {
  it('解析 name / description / version', () => {
    const skill = parseSkillFromMarkdown(
      md('name: financial-analysis\ndescription: 财报分析\nversion: 1.2.0'),
    );
    expect(skill.id).toBe('financial-analysis');
    expect(skill.name).toBe('financial-analysis');
    expect(skill.description).toBe('财报分析');
    expect(skill.version).toBe('1.2.0');
    expect(skill.prompt).toBe(BODY);
  });

  it('description_zh 优先于 description', () => {
    const skill = parseSkillFromMarkdown(
      md('name: a\ndescription: English\ndescription_zh: 中文说明'),
    );
    expect(skill.description).toBe('中文说明');
  });

  it('解析失败时回退到文件名', () => {
    const skill = parseSkillFromMarkdown('没有 frontmatter 的内容', 'my-skill.md');
    expect(skill.id).not.toBe('');
    expect(skill.name).toBe('my-skill');
  });
});

describe('allowed-tools：真实工具白名单', () => {
  it('解析逗号分隔的内联写法', () => {
    const skill = parseSkillFromMarkdown(md('name: a\nallowed-tools: Read, Write, Bash'));
    expect(skill.allowedTools).toEqual(['Read', 'Write', 'Bash']);
  });

  it('解析块状列表写法', () => {
    const skill = parseSkillFromMarkdown(md('name: a\nallowed-tools:\n  - Read\n  - Bash'));
    expect(skill.allowedTools).toEqual(['Read', 'Bash']);
  });

  it('容忍多余空白与空项', () => {
    const skill = parseSkillFromMarkdown(md('name: a\nallowed-tools:  Read , ,Bash , '));
    expect(skill.allowedTools).toEqual(['Read', 'Bash']);
  });

  it('未声明时为 undefined（不是空数组）', () => {
    // 空数组会被下游读成「一个工具都不许」，而这里的事实是「没有声明限制」
    const skill = parseSkillFromMarkdown(md('name: a'));
    expect(skill.allowedTools).toBeUndefined();
  });

  it('声明了但为空同样返回 undefined', () => {
    const skill = parseSkillFromMarkdown(md('name: a\nallowed-tools:'));
    expect(skill.allowedTools).toBeUndefined();
  });

  it('连字符 key 不会被丢掉（key 正则必须支持 -）', () => {
    const skill = parseSkillFromMarkdown(md('name: a\nallowed-tools: Read'));
    expect(skill.allowedTools).toBeDefined();
  });
});

describe('user-invocable', () => {
  it('缺省为 true（语义是"默认可由用户调用"）', () => {
    expect(parseSkillFromMarkdown(md('name: a')).userInvocable).toBe(true);
  });

  it('识别各种 false 写法', () => {
    for (const raw of ['false', 'FALSE', 'no', 'off', '0']) {
      expect(parseSkillFromMarkdown(md(`name: a\nuser-invocable: ${raw}`)).userInvocable).toBe(
        false,
      );
    }
  });

  it('识别各种 true 写法', () => {
    for (const raw of ['true', 'yes', 'on', '1']) {
      expect(parseSkillFromMarkdown(md(`name: a\nuser-invocable: ${raw}`)).userInvocable).toBe(true);
    }
  });

  it('写坏取值时回退 true，而不是把技能从用户入口摘掉', () => {
    // 写错取值 ≠ 声明 off。后者是「停用」，由三态覆盖表达，不是这里猜出来的
    expect(parseSkillFromMarkdown(md('name: a\nuser-invocable: maybe')).userInvocable).toBe(true);
  });
});

describe('metadata 折叠', () => {
  it('metadata.category 映射到分类（首字母大写）', () => {
    const skill = parseSkillFromMarkdown(md('name: a\nmetadata:\n  category: data'));
    expect(skill.category).toBe('Data');
  });

  it('缺省分类为 Other', () => {
    expect(parseSkillFromMarkdown(md('name: a')).category).toBe('Other');
  });
});

describe('初始三态', () => {
  it('解析产物默认 on / enabled=true，真正的用户选择由 store 写入', () => {
    const skill = parseSkillFromMarkdown(md('name: a'));
    expect(skill.override).toBe('on');
    expect(skill.enabled).toBe(true);
  });

  it('可以带上发现层级与路径', () => {
    const skill = parseSkillFromMarkdown(md('name: a'), 'a', 'local', {
      scope: 'project',
      path: '/ws/skills/a',
    });
    expect(skill.scope).toBe('project');
    expect(skill.path).toBe('/ws/skills/a');
  });
});
