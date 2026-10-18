/**
 * `agents.defaults` 隐式默认字段与 `modelPresets` 指针的同步。
 *
 * 这些用例守的是一条**安静**的错误：不同步时一切正常，直到某天用户删掉当前默认预设
 * ——`modelPreset` 被清空，引擎回落到 `agents.defaults.model` 那条**上一个默认**的
 * 陈旧裸串，助手悄悄换成另一个模型，零报错。
 *
 * 变异验证目标：
 * - `expandPresetIntoDefaults` 去掉「缺失的键不写」→ 「不抹掉用户手调值」用例变红；
 * - `syncDefaultsToPointer` 去掉悬空判据 → 「悬空不动」用例变红；
 * - `pickFallbackDefaultPreset` 改成按名字排序 → 「原序顶上」用例变红。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_FIELDS,
  expandPresetIntoDefaults,
  pickFallbackDefaultPreset,
  syncDefaultsToPointer,
} from '../../electron/modelDefaultsConfig';

function preset(model: string, extra: Record<string, unknown> = {}) {
  return { model, provider: 'dashscope', maxTokens: 8192, contextWindowTokens: 200000, ...extra };
}

describe('expandPresetIntoDefaults', () => {
  it('只同步引擎 resolve_default_preset 读的那 6 个字段', () => {
    const defaults: Record<string, unknown> = {};
    expandPresetIntoDefaults(defaults, {
      ...preset('qwen3.8-flash'),
      supportsTools: true, // 预设专属元数据：agents.defaults 没有对应字段
    });
    // 判据是「写进去的键必须是那 6 个的子集」，而不是「6 个都得写」——
    // 预设没声明的字段按设计不写（见下一个用例）
    for (const key of Object.keys(defaults)) {
      expect(DEFAULT_MODEL_FIELDS).toContain(key);
    }
    expect(defaults.supportsTools).toBeUndefined();
  });

  it('预设没声明的键不写（不把用户手调的值抹掉）', () => {
    const defaults: Record<string, unknown> = { temperature: 0.7 };
    expandPresetIntoDefaults(defaults, preset('qwen3.8-flash'));
    // 预设里没有 temperature → defaults 里用户调过的 0.7 必须留着
    expect(defaults.temperature).toBe(0.7);
    expect(defaults.model).toBe('qwen3.8-flash');
  });

  it('值没变化的字段不计入「有变更」（幂等检测要靠它）', () => {
    const defaults: Record<string, unknown> = { model: 'qwen3.8-flash' };
    expect(expandPresetIntoDefaults(defaults, { model: 'qwen3.8-flash' })).toBe(false);
  });

  it('预设写 null 时覆盖（null 是「显式不设」，与「没声明」不同）', () => {
    const defaults: Record<string, unknown> = { reasoningEffort: 'high' };
    expandPresetIntoDefaults(defaults, { model: 'x', reasoningEffort: null });
    expect(defaults.reasoningEffort).toBeNull();
  });
});

describe('syncDefaultsToPointer', () => {
  const presets = {
    'qwen3.8-2.4t-a95b': preset('qwen3.8-2.4t-a95b'),
    'qwen3.8-flash': preset('qwen3.8-flash', { temperature: 0.2 }),
  };

  it('指针有效 ⇒ defaults 被展开成该预设（「设为默认」连带生效）', () => {
    const defaults: Record<string, unknown> = { model: 'qwen3.8-2.4t-a95b' };
    expect(syncDefaultsToPointer({ ...defaults, modelPreset: 'qwen3.8-flash' }, presets)).toBe(true);
  });

  it('指针为空 ⇒ 什么都不动（沿用隐式默认字段）', () => {
    const defaults: Record<string, unknown> = { model: 'qwen3.8-2.4t-a95b' };
    expect(syncDefaultsToPointer(defaults, presets)).toBe(false);
    expect(defaults.model).toBe('qwen3.8-2.4t-a95b');
  });

  it('指针悬空 ⇒ 什么都不动（旧值仍是唯一可用信息，清掉更糟）', () => {
    const defaults: Record<string, unknown> = {
      model: 'qwen3.8-2.4t-a95b',
      modelPreset: '已删除的预设',
    };
    expect(syncDefaultsToPointer(defaults, presets)).toBe(false);
    expect(defaults.model).toBe('qwen3.8-2.4t-a95b');
  });
});

describe('pickFallbackDefaultPreset', () => {
  it('按配置书写顺序顶上第一个（不按名字排序）', () => {
    const presets = {
      zebra: preset('z'),
      alpha: preset('a'),
      beta: preset('b'),
    };
    expect(pickFallbackDefaultPreset(presets, 'zebra')).toBe('alpha');
  });

  it('跳掉被删的那个（它已从表里删掉时也不该选中它）', () => {
    const presets = { alpha: preset('a'), beta: preset('b') };
    expect(pickFallbackDefaultPreset(presets, 'alpha')).toBe('beta');
  });

  it('一个都不剩 ⇒ null（此时 API 无默认可选，指针只能置空）', () => {
    expect(pickFallbackDefaultPreset({}, 'alpha')).toBeNull();
  });
});

describe('删除默认预设的完整后果（回归主线）', () => {
  it('顶上的新默认会把 defaults 展开成它 —— 不会回落到上一个默认的陈旧裸串', () => {
    // 场景：默认是 flash，另有 legacy；删掉 flash 后不应回落到 stale-model
    const presets: Record<string, unknown> = {
      legacy: preset('stale-model'),
      flash: preset('qwen3.8-flash'),
      other: preset('deepseek-v4-pro-0813'),
    };
    const defaults: Record<string, unknown> = {
      model: 'stale-model', // 历史裸串
      modelPreset: 'flash',
    };
    syncDefaultsToPointer(defaults, presets); // 设为默认时已同步
    expect(defaults.model).toBe('qwen3.8-flash');

    delete presets.flash;
    if (defaults.modelPreset === 'flash') {
      defaults.modelPreset = pickFallbackDefaultPreset(presets, 'flash');
    }
    syncDefaultsToPointer(defaults, presets);

    expect(defaults.modelPreset).toBe('legacy');
    // 关键：即便顶上的是 legacy，字段也必须跟着它，而不是留在 flash 上
    expect(defaults.model).toBe('stale-model');
  });
});