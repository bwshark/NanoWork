import { describe, expect, it } from 'vitest';
import {
  builtinModelIds,
  groupCatalog,
  missingBuiltinModels,
  parseBuiltinModels,
  type BuiltinModel,
} from '@/lib/model/builtinModels';
import type { ModelInfo } from '@/types';

/**
 * 内置模型目录的纯逻辑。
 *
 * 三个函数的错误都不会抛：`parse` 把坏条目丢掉、`group` 把条目分错组、`missing`
 * 少算一条。表现分别是「模型凭空消失」「内置模型出现在自定义组」「换机后要手配」，
 * 全靠用例钉住。
 */

describe('parseBuiltinModels', () => {
  it('丢弃缺 id 的条目，model 缺省回退到 id', () => {
    const list = parseBuiltinModels({
      models: [
        { id: 'a', model: 'up-a' },
        { model: 'no-id' },
        { id: 'b' },
      ],
    });
    expect(list.map((m) => m.id)).toEqual(['a', 'b']);
    // 没有 model 时退回预设名：编不出来上游名，但至少这一行是可调用的
    expect(list[1].model).toBe('b');
  });

  it('能力声明缺省取窄方向（未声明即不支持）', () => {
    const [item] = parseBuiltinModels({ models: [{ id: 'a' }] });
    expect(item.supportsTools).toBe(false);
    expect(item.supportsVision).toBe(false);
    expect(item.supportsReasoning).toBe(false);
  });

  it('同一 id 只保留第一次出现（服务端重复下发的兜底）', () => {
    const list = parseBuiltinModels({
      models: [
        { id: 'a', model: 'first' },
        { id: 'a', model: 'second' },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0].model).toBe('first');
  });

  it('按 sortOrder 排序，同值按 id', () => {
    const list = parseBuiltinModels({
      models: [
        { id: 'z', sortOrder: 10 },
        { id: 'a', sortOrder: 20 },
        { id: 'b', sortOrder: 10 },
      ],
    });
    expect(list.map((m) => m.id)).toEqual(['b', 'z', 'a']);
  });

  it('坏响应返回空数组而不是抛错', () => {
    expect(parseBuiltinModels(null)).toEqual([]);
    expect(parseBuiltinModels({ models: 'nope' })).toEqual([]);
    expect(parseBuiltinModels({ models: [1, 'x', null] })).toEqual([]);
  });

  it('单价经 normalizePricing 归一（全零折成 null）', () => {
    const list = parseBuiltinModels({
      models: [
        { id: 'a', pricing: { inputPerMillion: 0, outputPerMillion: 0 } },
        { id: 'b', pricing: { inputPerMillion: 2, outputPerMillion: 8 } },
      ],
    });
    expect(list[0].pricing).toBeNull();
    expect(list[1].pricing).toMatchObject({ inputPerMillion: 2, outputPerMillion: 8 });
  });
});

const asInfo = (id: string): ModelInfo => ({ id }) as ModelInfo;

describe('groupCatalog', () => {
  it('按 id 命中分组，default 两组都不进', () => {
    const models = [asInfo('default'), asInfo('agnes-3.0-flash'), asInfo('mine')];
    const groups = groupCatalog(models, builtinModelIds([{ id: 'agnes-3.0-flash' }]));
    expect(groups.builtin.map((m) => m.id)).toEqual(['agnes-3.0-flash']);
    expect(groups.custom.map((m) => m.id)).toEqual(['mine']);
  });

  it('没有云端目录时全部落到自定义组（不画空的内置组）', () => {
    const groups = groupCatalog([asInfo('a'), asInfo('b')], new Set());
    expect(groups.builtin).toEqual([]);
    expect(groups.custom.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('云端有、本机目录没有的条目不凭空出现（菜单只画真能调用的）', () => {
    const groups = groupCatalog([asInfo('x')], builtinModelIds([{ id: 'agnes' }]));
    expect(groups.builtin).toEqual([]);
    expect(groups.custom.map((m) => m.id)).toEqual(['x']);
  });
});

const builtinOf = (id: string): BuiltinModel => ({
  id,
  model: id,
  provider: 'agnes',
  providerLabel: 'Agnes',
  apiBase: '',
  apiKey: '',
  maxTokens: 1,
  contextWindowTokens: 1,
  temperature: 0,
  reasoningEffort: null,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: true,
  customProtocol: false,
  pricing: null,
  description: '',
  sortOrder: 0,
});

describe('missingBuiltinModels', () => {
  it('只返回本机没有的（用户换过自己的密钥也要保留原条目）', () => {
    const missing = missingBuiltinModels(
      [builtinOf('a'), builtinOf('b')],
      ['b', 'mine'],
    );
    expect(missing.map((m) => m.id)).toEqual(['a']);
  });

  it('本机一个都没有时全部要播种', () => {
    const missing = missingBuiltinModels([builtinOf('a'), builtinOf('b')], []);
    expect(missing).toHaveLength(2);
  });
});
