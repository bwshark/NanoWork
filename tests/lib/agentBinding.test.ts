/**
 * 专家级模型绑定与本轮下发的模型解析（FR-2.3）。
 *
 * 这层的价值全在「下发前重新校验一次」：模型的取值是**预设名**，而让这个字符串
 * 失效的动作在别处（用户去设置页删预设/改名）。所以用例的重点不是「谁能赢」的
 * 优先级排列，而是三类边界：
 *
 * 1. **失效的候选要能回落**，而且逐级回落（会话失效 → 退到专家，而不是直接掉默认）；
 * 2. **目录未加载 ≠ 全都失效** —— 拿空集当「都失效」会让冷启动第一轮消息静默
 *    把所有人的模型选择丢掉，且只有第一轮；
 * 3. **空串与 undefined 同义**（都是「没指定」），因为 UI 清空时传的是空串。
 */

import { describe, expect, it } from 'vitest';
import { availablePresetIds, resolveTurnModel } from '@/lib/agentBinding';

const PRESETS = new Set(['default', 'qwen', 'claude']);

describe('resolveTurnModel：优先级', () => {
  it('会话显式选择赢过专家绑定', () => {
    // 专家绑定是「省得每次再选一遍」的默认值；默认值不该盖过用户此刻的动作
    expect(resolveTurnModel('qwen', 'claude', PRESETS)).toBe('qwen');
  });

  it('会话没选时用专家绑定的', () => {
    expect(resolveTurnModel(undefined, 'claude', PRESETS)).toBe('claude');
  });

  it('两者都没有 → 空串（不下发 model 字段，由网关用默认模型）', () => {
    expect(resolveTurnModel(undefined, undefined, PRESETS)).toBe('');
  });

  it('空串与 undefined 同义：都当「没指定」处理', () => {
    // UI 清空选择时传空串、老数据里可能是缺字段，两者必须等价，
    // 否则会出现「明明清掉了却还在用专家绑的模型」
    expect(resolveTurnModel('', 'claude', PRESETS)).toBe('claude');
    expect(resolveTurnModel('', '', PRESETS)).toBe('');
  });
});

describe('resolveTurnModel：失效预设', () => {
  it('会话选的预设已失效 → 退到专家绑的那个（逐级回落）', () => {
    expect(resolveTurnModel('gone', 'claude', PRESETS)).toBe('claude');
  });

  it('专家绑的预设已失效 → 退回空，而不是把错误传给引擎', () => {
    // 引擎收到未知预设会直接报错；拦住之后表现为「回落到默认模型」，
    // 与「本来就没绑」同义
    expect(resolveTurnModel(undefined, 'gone', PRESETS)).toBe('');
  });

  it('两个都失效 → 空', () => {
    expect(resolveTurnModel('gone-a', 'gone-b', PRESETS)).toBe('');
  });

  it('回落的完整顺序：会话有效 > 会话失效但专家有效 > 都无效', () => {
    expect(resolveTurnModel('qwen', 'gone', PRESETS)).toBe('qwen');
    expect(resolveTurnModel('gone', 'qwen', PRESETS)).toBe('qwen');
    expect(resolveTurnModel('gone', 'gone', PRESETS)).toBe('');
  });
});

describe('resolveTurnModel：目录未加载', () => {
  it('available === null 时不校验，原样下发', () => {
    // 冷启动瞬间目录还没到；此时若拿空集当「全都失效」，第一轮消息会把所有
    // 模型选择静默丢掉，回落成网关默认 —— 症状是「我明明选了模型，第一次没生效」
    expect(resolveTurnModel('qwen', 'claude', null)).toBe('qwen');
    expect(resolveTurnModel(undefined, 'claude', null)).toBe('claude');
  });

  it('目录未加载也不凭空造出一个模型', () => {
    expect(resolveTurnModel(undefined, undefined, null)).toBe('');
  });
});

describe('availablePresetIds', () => {
  it('非空目录 → id 集合', () => {
    expect(availablePresetIds([{ id: 'a' }, { id: 'b' }])).toEqual(new Set(['a', 'b']));
  });

  it('⚠️ 空目录 → null（未知），不是空集', () => {
    // 「还没加载 / 网关离线」与「确实一个预设都没有」在 modelsStore 里无法区分
    // （网关在线时 /v1/models 至少含隐式 default），所以只能表达成「未知」。
    // 若返回空集，resolveTurnModel 会把所有选择判失效。
    expect(availablePresetIds([])).toBeNull();
  });
});
