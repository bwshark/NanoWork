/**
 * 提示词模板目录（内置默认）的不变量。
 *
 * 这些断言存在的意义不是「测常量」，而是**钉住几条一旦破了就会静默劣化产品行为的
 * 约束**——它们不会让构建失败，只会让模型慢慢变得不可信：
 *
 * 1. 每个风格模板都必须带内容质量护栏（§13.1）。
 * 2. 槽位 key 必须唯一——重复会让「用户覆盖了哪个」变成不确定的。
 * 3. 模式维度必须覆盖全部 `ExecutionMode`——漏一个就意味着该模式下没有约束文本。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMPT_DOMAIN,
  DEFAULT_PROMPT_STYLE,
  PROMPT_DOMAINS,
  PROMPT_SLOTS,
  QUALITY_CLAUSE_MARKER,
  findSlot,
  slotsOfKind,
  styleKeepsQualityClause,
} from '@/lib/promptCatalog';
import { PromptLibrary } from '@/lib/promptLibrary';
import type { PromptMode } from '@/types';

/** 模式维度的期望取值：与 `ExecutionMode` 同源，改枚举时这里会一起暴露 */
const EXECUTION_MODES: PromptMode[] = ['ask', 'plan', 'craft'];

describe('promptCatalog：槽位结构', () => {
  it('槽位 key 在 kind 内唯一', () => {
    const seen = new Set<string>();
    for (const slot of PROMPT_SLOTS) {
      const id = `${slot.kind}.${slot.key}`;
      expect(seen.has(id), `重复槽位：${id}`).toBe(false);
      seen.add(id);
    }
  });

  it('每个槽位都有非空正文与展示元信息', () => {
    for (const slot of PROMPT_SLOTS) {
      expect(slot.builtin.trim(), `${slot.key} 正文为空`).not.toBe('');
      expect(slot.label.trim()).not.toBe('');
      expect(slot.description.trim()).not.toBe('');
    }
  });

  it('模式维度覆盖全部执行模式', () => {
    const keys = slotsOfKind('mode').map((slot) => slot.key);
    for (const mode of EXECUTION_MODES) expect(keys).toContain(mode);
  });

  it('领域维度覆盖声明过的全部取值', () => {
    const keys = slotsOfKind('domain').map((slot) => slot.key);
    expect([...keys].sort()).toEqual([...PROMPT_DOMAINS].sort());
  });

  it('风格维度为 7 种（§13.1）', () => {
    expect(slotsOfKind('style')).toHaveLength(7);
  });

  it('默认领域 / 风格都真实存在', () => {
    expect(findSlot('domain', DEFAULT_PROMPT_DOMAIN)).toBeDefined();
    expect(findSlot('style', DEFAULT_PROMPT_STYLE)).toBeDefined();
  });

  it('findSlot 未命中返回 undefined（调用方据此跳过，不猜近似值）', () => {
    expect(findSlot('style', 'style-nonexistent')).toBeUndefined();
    expect(findSlot('mode', 'deploy')).toBeUndefined();
  });
});

describe('promptCatalog：风格内容质量护栏（§13.1）', () => {
  it('每个内置风格模板都包含护栏条款', () => {
    for (const slot of slotsOfKind('style')) {
      expect(
        styleKeepsQualityClause(slot.builtin),
        `${slot.key} 缺少内容质量护栏（锚点：${QUALITY_CLAUSE_MARKER}）`,
      ).toBe(true);
    }
  });

  it('护栏条款写明「只改 HOW 不改 WHAT」的实质', () => {
    for (const slot of slotsOfKind('style')) {
      expect(slot.builtin).toMatch(/准确性/);
    }
  });

  it('styleKeepsQualityClause 对空值与无关文本返回 false', () => {
    expect(styleKeepsQualityClause('')).toBe(false);
    expect(styleKeepsQualityClause('随便说点什么')).toBe(false);
  });

  it('用户覆盖掉护栏时能被检出（UI 据此提示，而不是静默放行）', () => {
    expect(styleKeepsQualityClause('用毒舌的语气，想怎么嘲就怎么嘲')).toBe(false);
  });
});

describe('promptCatalog：内置默认与「磁盘无覆盖」等价', () => {
  it('未加载磁盘覆盖时，resolveSync 返回内置正文', () => {
    PromptLibrary.__resetForTest();
    for (const slot of PROMPT_SLOTS) {
      expect(PromptLibrary.resolveSync(slot.kind, slot.key)).toBe(slot.builtin);
    }
  });
});
