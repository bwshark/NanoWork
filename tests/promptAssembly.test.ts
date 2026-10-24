/**
 * 提示词装配器（design §13.3 三层上下文注入 / §14.2 段序）。
 *
 * 装配器是纯函数，所以这里能逐段断言段序、标签与省略规则。段序不是审美问题：
 * 记忆块的边界指令行写着「以上方系统提示定义的身份与要求为准」，身份段若排在
 * 记忆之后，这句话就指向了记忆自己。下面的段序用例就是为这条约束服务的。
 */

import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_INSTRUCTION,
  PRODUCT_IDENTITY_TEXT,
  assemblePromptSections,
  identityContextBlock,
} from '@/lib/promptAssembly';
import {
  IDENTITY_TAG_CLOSE,
  IDENTITY_TAG_OPEN,
  PRODUCT_IDENTITY_TAG_OPEN,
  TONE_STYLE_TAG_OPEN,
  USER_INSTRUCTIONS_TAG_OPEN,
} from '@/lib/constants';

describe('assemblePromptSections：段序', () => {
  it('完整输入下段序固定', () => {
    const ids = assemblePromptSections({
      agentPersona: '人设',
      identity: { soul: 'soul', identity: 'identity', user: 'user' },
      style: '风格',
      mode: '模式',
      domain: '领域',
      userInstructions: '自定义',
      memory: '记忆',
      skills: ['技能A', '技能B'],
      localTime: '时间',
    }).map((s) => s.id);

    expect(ids).toEqual([
      'agent-persona',
      'identity',
      'product-identity',
      'tone-style',
      'mode',
      'domain',
      'user-instructions',
      'memory',
      'skills',
      'skills',
      'local-time',
    ]);
  });

  it('身份段必须排在记忆段之前（记忆的边界指令行依赖「上方」是真的身份）', () => {
    const ids = assemblePromptSections({
      identity: { soul: 'soul' },
      memory: '记忆正文',
    }).map((s) => s.id);

    expect(ids.indexOf('identity')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('identity')).toBeLessThan(ids.indexOf('memory'));
  });

  it('技能段排在产品身份之后，时间提示收尾', () => {
    const ids = assemblePromptSections({ skills: ['A'], localTime: 't' }).map((s) => s.id);
    // 产品身份有默认值，永远在；只断言相对次序
    expect(ids.indexOf('skills')).toBeGreaterThan(ids.indexOf('product-identity'));
    expect(ids.at(-1)).toBe('local-time');
  });
});

describe('assemblePromptSections：省略规则', () => {
  it('空串 / undefined / 纯空白一律不产生段', () => {
    const sections = assemblePromptSections({
      agentPersona: '   ',
      identity: {},
      style: '',
      mode: undefined,
      domain: '  \n ',
      userInstructions: '',
      memory: '',
      skills: ['', '   '],
      localTime: '',
    });
    // 只剩产品身份（它有默认值，永远在）
    expect(sections.map((s) => s.id)).toEqual(['product-identity']);
  });

  it('技能列表里的空白项被跳过，非空项各成一段', () => {
    const sections = assemblePromptSections({ skills: ['', 'A', '  ', 'B'] });
    const skillSections = sections.filter((s) => s.id === 'skills');
    expect(skillSections.map((s) => s.content)).toEqual(['A', 'B']);
  });

  it('极简输入也能装配（不抛错）', () => {
    const sections = assemblePromptSections({});
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe('product-identity');
  });
});

describe('assemblePromptSections：标签', () => {
  it('产品身份自带默认正文并套标签', () => {
    const section = assemblePromptSections({}).find((s) => s.id === 'product-identity');
    expect(section?.content.startsWith(PRODUCT_IDENTITY_TAG_OPEN)).toBe(true);
    expect(section?.content).toContain('红涨绿跌');
    expect(section?.content).toContain('¥');
  });

  it('产品身份可被显式覆盖（留出白标空间）', () => {
    const section = assemblePromptSections({ productIdentity: '我的产品' }).find(
      (s) => s.id === 'product-identity',
    );
    expect(section?.content).toContain('我的产品');
    expect(section?.content).not.toContain(PRODUCT_IDENTITY_TEXT);
  });

  it('风格段套 <tone_and_style>', () => {
    const section = assemblePromptSections({ style: '专业一点' }).find(
      (s) => s.id === 'tone-style',
    );
    expect(section?.content).toBe(`<tone_and_style>\n专业一点\n</tone_and_style>`);
    expect(section?.content.startsWith(TONE_STYLE_TAG_OPEN)).toBe(true);
  });

  it('用户自定义指令套 <user_custom_instructions>', () => {
    const section = assemblePromptSections({ userInstructions: '总是用中文' }).find(
      (s) => s.id === 'user-instructions',
    );
    expect(section?.content.startsWith(USER_INSTRUCTIONS_TAG_OPEN)).toBe(true);
    expect(section?.content).toContain('总是用中文');
  });

  it('记忆段原样透传（包裹与边界指令由 MemoryService 负责，装配器不重复加工）', () => {
    const wrapped = '<!-- MEMORY -->\n边界指令\n正文\n<!-- /MEMORY -->';
    const section = assemblePromptSections({ memory: wrapped }).find((s) => s.id === 'memory');
    expect(section?.content).toBe(wrapped);
  });

  it('模式与领域不加自造标签（§13.3 只定义了五个标签，不额外发明）', () => {
    const sections = assemblePromptSections({ mode: '模式正文', domain: '领域正文' });
    expect(sections.find((s) => s.id === 'mode')?.content).toBe('模式正文');
    expect(sections.find((s) => s.id === 'domain')?.content).toBe('领域正文');
  });
});

describe('identityContextBlock', () => {
  it('三段齐全时按 SOUL → IDENTITY → USER 排列并套标签', () => {
    const block = identityContextBlock({ soul: 's', identity: 'i', user: 'u' });
    expect(block.startsWith(IDENTITY_TAG_OPEN)).toBe(true);
    expect(block.endsWith(IDENTITY_TAG_CLOSE)).toBe(true);
    expect(block.indexOf('## SOUL.md')).toBeLessThan(block.indexOf('## IDENTITY.md'));
    expect(block.indexOf('## IDENTITY.md')).toBeLessThan(block.indexOf('## USER.md'));
  });

  it('只有一段时也成块', () => {
    const block = identityContextBlock({ user: '仅用户画像' });
    expect(block).toContain(IDENTITY_TAG_OPEN);
    expect(block).toContain('## USER.md');
    expect(block).not.toContain('## SOUL.md');
  });

  it('全空时返回空串（不产生只有标签的空块）', () => {
    expect(identityContextBlock(undefined)).toBe('');
    expect(identityContextBlock({})).toBe('');
    expect(identityContextBlock({ soul: '  ', identity: '\n' })).toBe('');
  });

  it('空白段被跳过，不产生空的 ## 小节', () => {
    const block = identityContextBlock({ soul: '  ', user: '有内容' });
    expect(block).not.toContain('## SOUL.md');
    expect(block).toContain('## USER.md');
  });

  it('引导态：BOOTSTRAP 正文与引导指令都进块内', () => {
    const block = identityContextBlock({ bootstrap: '请先了解我是谁' });
    expect(block).toContain('请先了解我是谁');
    expect(block).toContain('## BOOTSTRAP.md');
    expect(block).toContain(ONBOARDING_INSTRUCTION);
    // 引导内容属于身份语义，必须在同一个标签块内
    expect(block.indexOf('请先了解我是谁')).toBeLessThan(block.indexOf(IDENTITY_TAG_CLOSE));
  });

  it('引导态下已有身份文件时，两者共存', () => {
    const block = identityContextBlock({ soul: '既有原则', bootstrap: '引导种子' });
    expect(block).toContain('## SOUL.md');
    expect(block).toContain('## BOOTSTRAP.md');
  });

  it('引导指令要求用户确认而非让模型自己写文件（模型没有该权限）', () => {
    expect(ONBOARDING_INSTRUCTION).toMatch(/没有直接写这些文件的权限/);
  });

  it('非引导态不出现任何引导字样', () => {
    const block = identityContextBlock({ soul: 's' });
    expect(block).not.toContain('BOOTSTRAP');
    expect(block).not.toContain('一次性引导');
  });
});

describe('assemblePromptSections：知识库段（FR-2.3 / FR-4.7）', () => {
  it('知识段落位：记忆写入之后、技能之前（事实先于方法）', () => {
    const ids = assemblePromptSections({
      memory: '记忆正文',
      memoryWrite: '写入协议',
      knowledge: '<knowledge_context>资料</knowledge_context>',
      skills: ['技能A'],
    }).map((s) => s.id);

    expect(ids).toEqual([
      'product-identity',
      'memory',
      'memory-write',
      'knowledge',
      'skills',
    ]);
  });

  it('空的知识段整段不出现（不留一个空标签让模型以为检索过）', () => {
    const ids = assemblePromptSections({ knowledge: '   ' }).map((s) => s.id);
    expect(ids).not.toContain('knowledge');
  });
});
