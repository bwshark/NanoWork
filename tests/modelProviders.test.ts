/**
 * 模型设置的纯逻辑层：供应商目录 + 预设/供应商的键名映射。
 *
 * 锁的是两类**不会报错、只会悄悄错位**的错误：
 *
 * 1. `providers.<key>` 用 camelCase、`modelPresets.<name>.provider` 用注册表的
 *    snake 名——两个形态写在同一个功能里，写反了引擎不报错，只是匹配不到
 *    供应商，等到真正发起对话才抛 `No provider is configured`；
 * 2. 预设没有 `label` 字段（`ModelPresetConfig` 未开 `extra="allow"`，多写的键
 *    会被 pydantic 静默丢弃），所以**预设名就是模型选择器里显示的那行字**，
 *    改名只能换 key——`previousPreset` 漏传会让「默认模型」指向一个已不存在的预设。
 */

import { describe, expect, it } from 'vitest';
import {
  AUTO_PROVIDER_VALUE,
  CUSTOM_PROVIDER_VALUE,
  MODEL_PROVIDERS,
  groupedModelProviders,
  isBuiltinProvider,
  modelProviderLabel,
  providerNeedsApiKey,
  slugifyProviderKey,
  toProviderConfigKey,
} from '@/lib/modelProviders';
import {
  buildManaged,
  buildMutation,
  resolveProviderKey,
  type ModelFormValue,
} from '@/stores/modelsStore';
import type { NanobotModelsSnapshot } from '@/platform/types';

describe('toProviderConfigKey: 注册表 snake 名 → config.json 的 camelCase 键', () => {
  // 这几个键的形态直接抄自 nanowork.config.json 的 providers 段，
  // 对不上就说明目录与引擎注册表已经漂移
  it('多词供应商按引擎落盘形态转 camelCase', () => {
    expect(toProviderConfigKey('volcengine_coding_plan')).toBe('volcengineCodingPlan');
    expect(toProviderConfigKey('lm_studio')).toBe('lmStudio');
    expect(toProviderConfigKey('kimi_coding')).toBe('kimiCoding');
    expect(toProviderConfigKey('xiaomi_mimo')).toBe('xiaomiMimo');
    expect(toProviderConfigKey('minimax_anthropic')).toBe('minimaxAnthropic');
  });

  it('单词供应商保持不变（camel 与 snake 同形）', () => {
    expect(toProviderConfigKey('dashscope')).toBe('dashscope');
    expect(toProviderConfigKey('deepseek')).toBe('deepseek');
    expect(toProviderConfigKey('openai')).toBe('openai');
  });

  it('目录里的每个名字都能转出互不相同的 key（防止两个供应商写进同一个槽位）', () => {
    const keys = MODEL_PROVIDERS.map((p) => toProviderConfigKey(p.name));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('slugifyProviderKey: 自定义供应商的键', () => {
  it('保留 CJK —— 纯 ASCII 过滤会把中文名压成空串，导致互相覆盖', () => {
    expect(slugifyProviderKey('我的网关')).toBe('我的网关');
    expect(slugifyProviderKey('牧场数据')).toBe('牧场数据');
  });

  it('英文与符号收敛为下划线分隔', () => {
    expect(slugifyProviderKey('My Gateway')).toBe('my_gateway');
    expect(slugifyProviderKey('  Token-Hub!! ')).toBe('token_hub');
  });

  it('空名回落 custom', () => {
    expect(slugifyProviderKey('   ')).toBe('custom');
  });

  it('撞上内置名时加前缀，避免被内置默认值盖掉', () => {
    // dashscope 是内置供应商：键若直接叫 dashscope，引擎会命中内置 spec，
    // 用户填的 apiBase 会被注册表默认值盖掉
    expect(slugifyProviderKey('dashscope')).toBe('custom_dashscope');
    expect(isBuiltinProvider('custom_dashscope')).toBe(false);
  });
});

describe('目录自身的完整性', () => {
  it('无重名，且分组都被覆盖', () => {
    const names = MODEL_PROVIDERS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    const groups = groupedModelProviders();
    expect(groups.map((g) => g.group)).toEqual(['official', 'gateway', 'local']);
    // 分组后的条目总数必须与目录一致：分组函数若漏掉一项，下拉里就永远选不到它
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(MODEL_PROVIDERS.length);
  });

  it('未知供应商的展示名退化为原名（自定义供应商不能被显示成空白）', () => {
    expect(modelProviderLabel('my_gateway')).toBe('my_gateway');
    expect(modelProviderLabel('')).toBe('');
    expect(modelProviderLabel('deepseek')).toBe('DeepSeek 深度求索');
  });

  it('本地部署不需要 API Key，云端需要', () => {
    expect(providerNeedsApiKey('ollama')).toBe(false);
    expect(providerNeedsApiKey('lm_studio')).toBe(false);
    expect(providerNeedsApiKey('deepseek')).toBe(true);
    // 自定义供应商不在目录里 → 按「需要 key」处理（fail-closed）
    expect(providerNeedsApiKey(CUSTOM_PROVIDER_VALUE)).toBe(true);
  });

  it('auto 不指向任何 providers 条目（无 key 可言）', () => {
    expect(providerNeedsApiKey(AUTO_PROVIDER_VALUE)).toBe(false);
    expect(modelProviderLabel(AUTO_PROVIDER_VALUE)).toBe('自动匹配');
  });
});

describe('buildManaged: 引擎快照 → 设置页行模型', () => {
  const snapshot: NanobotModelsSnapshot = {
    presets: {
      sciherd: {
        model: 'Qwen3.8-Flash',
        provider: 'sciherd',
        maxTokens: 8192,
        contextWindowTokens: 262144,
        temperature: 0.1,
        reasoningEffort: null,
      },
      'deepseek-chat': {
        model: 'deepseek-chat',
        provider: 'deepseek',
        maxTokens: 8192,
        contextWindowTokens: 200000,
        temperature: 0.1,
        reasoningEffort: null,
      },
    },
    providers: {
      sciherd: { apiKey: null, apiBase: 'http://192.168.0.88:8001/v1', displayName: null },
      deepseek: { apiKey: 'sk-1', apiBase: null, displayName: null },
    },
    defaultPreset: 'sciherd',
  };

  it('默认预设排在最前，且能识别自定义供应商与密钥状态', () => {
    const rows = buildManaged(snapshot);
    expect(rows.map((r) => r.name)).toEqual(['sciherd', 'deepseek-chat']);
    expect(rows[0].isDefault).toBe(true);
    expect(rows[0].custom).toBe(true); // 目录里没有 sciherd → 自定义
    expect(rows[0].hasKey).toBe(false);
    expect(rows[1].custom).toBe(false);
    expect(rows[1].hasKey).toBe(true);
    expect(rows[1].providerLabel).toBe('DeepSeek 深度求索');
    expect(rows[1].providerKey).toBe('deepseek');
  });

  it('provider 为 auto 时展示为自动匹配，且不谎报密钥', () => {
    const rows = buildManaged({
      presets: {
        'qwen-long': {
          model: 'qwen-long',
          provider: 'auto',
          maxTokens: 8192,
          contextWindowTokens: 200000,
          temperature: 0.1,
          reasoningEffort: null,
        },
      },
      providers: {},
      defaultPreset: null,
    });
    expect(rows[0].providerLabel).toBe('自动匹配');
    expect(rows[0].hasKey).toBe(false);
    // auto 没有可清理的 providers 条目
    expect(rows[0].custom).toBe(false);
  });
});

describe('buildMutation: 表单值 → 引擎变更指令', () => {
  const base: ModelFormValue = {
    provider: 'deepseek',
    customProviderName: '',
    apiBase: '',
    apiKey: 'sk-x',
    model: 'deepseek-chat',
    setDefault: false,
  };

  it('内置供应商：preset.provider 用 snake 名，providers.key 用 camelCase', () => {
    const mutation = buildMutation({
      ...base,
      provider: 'volcengine_coding_plan',
    });
    if (mutation.op !== 'upsert') throw new Error('期望 upsert');
    expect(mutation.preset).toBe('deepseek-chat');
    expect(mutation.config.provider).toBe('volcengine_coding_plan');
    expect(mutation.provider?.key).toBe('volcengineCodingPlan');
    // 留空时不写 apiBase：让引擎用注册表默认值
    expect(mutation.provider?.apiBase).toBeUndefined();
  });

  it('内置供应商显式填了 API Base 才覆盖（自建网关 / 代理）', () => {
    const mutation = buildMutation({ ...base, apiBase: 'https://gw.internal/v1' });
    if (mutation.op !== 'upsert') throw new Error('期望 upsert');
    expect(mutation.provider?.apiBase).toBe('https://gw.internal/v1');
  });

  it('自定义供应商：preset.provider 与 providers.key 都取 slug', () => {
    const mutation = buildMutation({
      ...base,
      provider: CUSTOM_PROVIDER_VALUE,
      customProviderName: '我的网关',
      apiBase: 'https://gw.example.com/v1',
    });
    if (mutation.op !== 'upsert') throw new Error('期望 upsert');
    expect(mutation.config.provider).toBe('我的网关');
    expect(mutation.provider?.key).toBe('我的网关');
    expect(mutation.provider?.apiBase).toBe('https://gw.example.com/v1');
    expect(mutation.provider?.displayName).toBe('我的网关');
  });

  it('改名时带 previousPreset，且默认指针跟着搬', () => {
    const mutation = buildMutation({
      ...base,
      model: 'deepseek-reasoner',
      setDefault: true,
      original: {
        name: 'deepseek-chat',
        model: 'deepseek-chat',
        provider: 'deepseek',
        providerKey: 'deepseek',
        providerLabel: 'DeepSeek 深度求索',
        apiKey: 'sk-x',
        apiBase: '',
        hasKey: true,
        isDefault: true,
        custom: false,
      },
    });
    if (mutation.op !== 'upsert') throw new Error('期望 upsert');
    expect(mutation.preset).toBe('deepseek-reasoner');
    expect(mutation.previousPreset).toBe('deepseek-chat');
    expect(mutation.setDefault).toBe(true);
  });

  it('auto 不落 providers 条目（改供应商条目会让它不再自动匹配）', () => {
    const mutation = buildMutation({ ...base, provider: AUTO_PROVIDER_VALUE, apiKey: '' });
    if (mutation.op !== 'upsert') throw new Error('期望 upsert');
    expect(mutation.config.provider).toBe('auto');
    expect(mutation.provider).toBeUndefined();
  });

  it('未改名时不传 previousPreset（否则会把自己的预设删掉）', () => {
    const mutation = buildMutation({
      ...base,
      original: {
        name: 'deepseek-chat',
        model: 'deepseek-chat',
        provider: 'deepseek',
        providerKey: 'deepseek',
        providerLabel: 'DeepSeek 深度求索',
        apiKey: 'sk-x',
        apiBase: '',
        hasKey: true,
        isDefault: false,
        custom: false,
      },
    });
    if (mutation.op !== 'upsert') throw new Error('期望 upsert');
    expect(mutation.previousPreset).toBeUndefined();
  });
});

describe('resolveProviderKey: 预设里的 provider 值 → providers 的键', () => {
  const keys = ['dashscope', 'volcengineCodingPlan', 'sciherd'];

  it('snake 名命中 camelCase 键', () => {
    expect(resolveProviderKey('volcengine_coding_plan', keys)).toBe('volcengineCodingPlan');
  });

  it('自定义键与大小写变体都能命中', () => {
    expect(resolveProviderKey('sciherd', keys)).toBe('sciherd');
    expect(resolveProviderKey('Sciherd', keys)).toBe('sciherd');
  });

  it('查不到时回落 camelCase 形态（宁可指向一个待建的键，也不要空串）', () => {
    expect(resolveProviderKey('my_gateway', keys)).toBe('myGateway');
  });
});
