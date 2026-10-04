/**
 * 回退链在 config.json 里的读写转换（FR-9.4）。
 *
 * 锁的是两类**不会报错、只会静默改坏配置**的错误：
 *
 * 1. **两态混淆**：引擎的 `fallbackModels` 是 `str | InlineFallbackConfig`——
 *    字符串是「引用预设」，对象是「内联一份配置」。把内联项序列化成字符串
 *    （或反过来）不会抛错，只是那条回退悄悄换了个意思。
 * 2. **引用失维**：删 / 改名预设时忘了同步链里的字符串引用，会留下一条
 *    「引用了不存在预设」的记录。引擎在**配置加载时**校验它，于是下一次启动
 *    直接抛 ValueError —— 表现是「网关莫名其妙起不来」，而原因在一次
 *    早已完成的删除操作里。
 */

import { describe, expect, it } from 'vitest';
import {
  dropFallbackRef,
  parseFallbacks,
  parseProviderRetryMode,
  renameFallbackRef,
  serializeFallbacks,
} from '../../electron/modelFallbacksConfig';

describe('parseFallbacks：引擎形状 → 客户端两态', () => {
  it('字符串 → 预设引用', () => {
    expect(parseFallbacks(['deepseek', 'local'])).toEqual([
      { kind: 'preset', preset: 'deepseek' },
      { kind: 'preset', preset: 'local' },
    ]);
  });

  it('对象 → 内联项，四个可选字段都读进来', () => {
    expect(
      parseFallbacks([
        {
          model: 'gpt-4o',
          provider: 'openai',
          maxTokens: 8192,
          contextWindowTokens: 128000,
          temperature: 0.3,
          reasoningEffort: 'high',
        },
      ]),
    ).toEqual([
      {
        kind: 'inline',
        model: 'gpt-4o',
        provider: 'openai',
        maxTokens: 8192,
        contextWindowTokens: 128000,
        temperature: 0.3,
        reasoningEffort: 'high',
      },
    ]);
  });

  it('缺省的可选字段读成 null（＝继承主模型），不是 0', () => {
    const [entry] = parseFallbacks([{ model: 'm', provider: 'p' }]);

    expect(entry).toEqual({
      kind: 'inline',
      model: 'm',
      provider: 'p',
      maxTokens: null,
      contextWindowTokens: null,
      temperature: null,
      reasoningEffort: null,
    });
  });

  it('⭐ 认不出的项**跳过**而不是猜（猜错会把能跑的配置改坏）', () => {
    expect(
      parseFallbacks([
        '',
        null,
        42,
        { model: 'no-provider' },
        { provider: 'no-model' },
        'ok',
        { model: 'm', provider: 'p' },
      ]),
    ).toEqual([
      { kind: 'preset', preset: 'ok' },
      {
        kind: 'inline',
        model: 'm',
        provider: 'p',
        maxTokens: null,
        contextWindowTokens: null,
        temperature: null,
        reasoningEffort: null,
      },
    ]);
  });

  it('不是数组（键不存在 / 被手改成对象）→ 空链', () => {
    expect(parseFallbacks(undefined)).toEqual([]);
    expect(parseFallbacks({ 0: 'x' })).toEqual([]);
    expect(parseFallbacks('deepseek')).toEqual([]);
  });

  it('保序：链的顺序就是重试顺序', () => {
    expect(parseFallbacks(['a', 'b', 'c']).map((c) => (c.kind === 'preset' ? c.preset : ''))).toEqual(
      ['a', 'b', 'c'],
    );
  });
});

describe('serializeFallbacks：客户端两态 → 引擎形状', () => {
  it('预设引用写回**裸字符串**（写成对象引擎会当成内联配置）', () => {
    expect(serializeFallbacks([{ kind: 'preset', preset: 'deepseek' }])).toEqual(['deepseek']);
  });

  it('内联项写回对象，且键名是 camelCase（跟引擎 dump 出来的形态一致）', () => {
    expect(
      serializeFallbacks([
        {
          kind: 'inline',
          model: 'm',
          provider: 'p',
          maxTokens: 100,
          contextWindowTokens: 200,
          temperature: 0.5,
          reasoningEffort: 'low',
        },
      ]),
    ).toEqual([
      {
        model: 'm',
        provider: 'p',
        maxTokens: 100,
        contextWindowTokens: 200,
        temperature: 0.5,
        reasoningEffort: 'low',
      },
    ]);
  });

  it('缺省值显式写 null（不省略键：省略就看不出「设过没设过」）', () => {
    const [entry] = serializeFallbacks([{ kind: 'inline', model: 'm', provider: 'p' }]) as [
      Record<string, unknown>,
    ];

    expect(Object.keys(entry).sort()).toEqual([
      'contextWindowTokens',
      'maxTokens',
      'model',
      'provider',
      'reasoningEffort',
      'temperature',
    ]);
    expect(entry.maxTokens).toBeNull();
    expect(entry.temperature).toBeNull();
  });

  it('往返不丢信息（读进来再写回去，形状与顺序都不变）', () => {
    // 这是最要紧的一条：主进程保存时是**整链替换**，往返里丢掉一项
    // 就等于把用户配的一条回退静默删了。
    const wire = ['deepseek', { model: 'm', provider: 'p', maxTokens: 5 }];
    expect(serializeFallbacks(parseFallbacks(wire))).toEqual([
      'deepseek',
      {
        model: 'm',
        provider: 'p',
        maxTokens: 5,
        contextWindowTokens: null,
        temperature: null,
        reasoningEffort: null,
      },
    ]);
  });

  it('空链 → 空数组（要显式写回，不能把键留着不动）', () => {
    expect(serializeFallbacks([])).toEqual([]);
  });
});

describe('dropFallbackRef / renameFallbackRef：预设删除与改名时的引用维护', () => {
  const wire = ['deepseek', { model: 'deepseek', provider: 'custom' }, 'local'];

  it('⭐ 删除预设：摘掉字符串引用，**内联项不受影响**', () => {
    // 内联项自带 model+provider，不依赖预设表——按名字一并删掉会误伤：
    // 它可能恰好和某个预设同名，但语义完全不同。
    expect(dropFallbackRef(wire, 'deepseek')).toEqual([
      { model: 'deepseek', provider: 'custom' },
      'local',
    ]);
  });

  it('删除预设：链里没有它时原样返回', () => {
    expect(dropFallbackRef(wire, 'ghost')).toEqual(wire);
  });

  it('⭐ 改名预设：字符串引用跟着改（不改就是一条指向不存在预设的记录）', () => {
    expect(renameFallbackRef(wire, 'local', 'local-v2')).toEqual([
      'deepseek',
      { model: 'deepseek', provider: 'custom' },
      'local-v2',
    ]);
  });

  it('改名：内联项里的 model 即使同名也不动（那是上游模型名，不是预设名）', () => {
    const renamed = renameFallbackRef([{ model: 'local', provider: 'p' }], 'local', 'local-v2');
    expect(renamed).toEqual([{ model: 'local', provider: 'p' }]);
  });

  it('不是数组 / 键缺失时不炸，按空链处理', () => {
    expect(dropFallbackRef(undefined, 'a')).toEqual([]);
    expect(renameFallbackRef(null, 'a', 'b')).toEqual([]);
  });
});

describe('parseProviderRetryMode', () => {
  it('两个合法档位原样返回', () => {
    expect(parseProviderRetryMode('standard')).toBe('standard');
    expect(parseProviderRetryMode('persistent')).toBe('persistent');
  });

  it('未知 / 缺失 → standard（与引擎字段默认值一致，不静默变成另一档）', () => {
    expect(parseProviderRetryMode(undefined)).toBe('standard');
    expect(parseProviderRetryMode(null)).toBe('standard');
    expect(parseProviderRetryMode('PERSISTENT')).toBe('standard');
    expect(parseProviderRetryMode(1)).toBe('standard');
  });
});
