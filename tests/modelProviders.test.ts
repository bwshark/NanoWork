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
  providerDocsUrl,
  providerModelOptions,
  providerMonogram,
  providerNeedsApiKey,
  providerOptionLabel,
  slugifyProviderKey,
  toProviderConfigKey,
} from '@/lib/modelProviders';
import {
  ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS,
  ENGINE_DEFAULT_MAX_TOKENS,
} from '@/lib/modelOptions';
import {
  buildManaged,
  buildMutation,
  resolveProviderKey,
  type ManagedModel,
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
        maxTokens: 32768,
        contextWindowTokens: 262144,
        temperature: 0.1,
        reasoningEffort: null,
      },
      'deepseek-chat': {
        model: 'deepseek-chat',
        provider: 'deepseek',
        maxTokens: 32768,
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

  it('token 上限按引擎默认值归一（200000/32768 折成 null = 使用提供商默认值）', () => {
    const rows = buildManaged(snapshot);
    // deepseek-chat 两项都等于引擎默认值 → 界面上都应显示「使用提供商默认值」
    expect(rows[1].contextWindowTokens).toBeNull();
    expect(rows[1].maxTokens).toBeNull();
    // sciherd 的窗口是用户特意设过的 256K，必须原样回显（不能一起被归一掉）
    expect(rows[0].contextWindowTokens).toBe(262144);
    expect(rows[0].maxTokens).toBeNull();
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
    // null = 界面上的「使用提供商默认值」；落盘时必须换成引擎自己的默认数字
    contextWindowTokens: null,
    maxTokens: null,
    reasoningEffort: null,
    // 能力声明：缺省值与引擎字段默认值一致
    supportsTools: true,
    supportsVision: false,
    customProtocol: false,
    supportsReasoning: true,
    pricing: null,
    setDefault: false,
  };

  /** 编辑模式下回读出来的那一行（`original` 的来源） */
  const editing = (overrides: Partial<ManagedModel> = {}): ManagedModel => ({
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
    contextWindowTokens: null,
    maxTokens: null,
    reasoningEffort: null,
    supportsTools: true,
    supportsVision: false,
    customProtocol: false,
    supportsReasoning: true,
    pricing: null,
    temperature: 0.1,
    ...overrides,
  });

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
      original: editing({ isDefault: true }),
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
    const mutation = buildMutation({ ...base, original: editing() });
    if (mutation.op !== 'upsert') throw new Error('期望 upsert');
    expect(mutation.previousPreset).toBeUndefined();
  });

  it('API Key 留空时写 null（而不是空串）：让引擎走自己的回退链', () => {
    // 空串是「密钥就是空」这个具体断言，会盖掉环境变量与引擎侧已配好的值；
    // 本地部署 / 内网网关 / 走 `<PROVIDER>_API_KEY` 的场景都靠留空表达
    const mutation = buildMutation({ ...base, apiKey: '' });
    if (mutation.op !== 'upsert') throw new Error('期望 upsert');
    expect(mutation.provider?.apiKey).toBeNull();
  });

  it('token 上限：选了档位写档位，没选则写引擎默认值（键不能缺）', () => {
    const chosen = buildMutation({
      ...base,
      contextWindowTokens: 262144,
      maxTokens: 32768,
    });
    if (chosen.op !== 'upsert') throw new Error('期望 upsert');
    expect(chosen.config.contextWindowTokens).toBe(262144);
    expect(chosen.config.maxTokens).toBe(32768);

    // 缺键退回 pydantic 默认值，结果虽然一样，但「写进去的到底是哪个数」就查不出来了
    const fallback = buildMutation(base);
    if (fallback.op !== 'upsert') throw new Error('期望 upsert');
    expect(fallback.config.contextWindowTokens).toBe(ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(fallback.config.maxTokens).toBe(ENGINE_DEFAULT_MAX_TOKENS);
  });

  it('思考模式：开启写具体档位，关闭写 null（不注入 reasoning_effort）', () => {
    const on = buildMutation({ ...base, reasoningEffort: 'high' });
    if (on.op !== 'upsert') throw new Error('期望 upsert');
    expect(on.config.reasoningEffort).toBe('high');

    const off = buildMutation({ ...base, reasoningEffort: null });
    if (off.op !== 'upsert') throw new Error('期望 upsert');
    expect(off.config.reasoningEffort).toBeNull();
  });

  it('温度从原预设带过来：只改模型名不该把用户调过的采样温度重置', () => {
    const mutation = buildMutation({
      ...base,
      model: 'deepseek-reasoner',
      original: editing({ temperature: 0.7 }),
    });
    if (mutation.op !== 'upsert') throw new Error('期望 upsert');
    expect(mutation.config.temperature).toBe(0.7);
  });

  it('⭐ 能力为假时强度被强制写 null（手改过的 config 会在保存时自愈）', () => {
    // 矛盾数据（声明不支持思考、却留着档位）在唯一写入点收口：一次保存就修好，
    // 而不是下次打开继续显示「勾着但置灰」
    const mutation = buildMutation({
      ...base,
      reasoningEffort: 'high',
      supportsReasoning: false,
    });
    if (mutation.op !== 'upsert') throw new Error('期望 upsert');
    expect(mutation.config.reasoningEffort).toBeNull();

    const keep = buildMutation({ ...base, reasoningEffort: 'high', supportsReasoning: true });
    if (keep.op !== 'upsert') throw new Error('期望 upsert');
    expect(keep.config.reasoningEffort).toBe('high');
  });
});

describe('能力声明：三项勾选项必须能落盘并回读', () => {
  const value = (overrides: Partial<ModelFormValue> = {}): ModelFormValue => ({
    provider: 'deepseek',
    customProviderName: '',
    apiBase: '',
    apiKey: '',
    model: 'deepseek-chat',
    contextWindowTokens: null,
    maxTokens: null,
    reasoningEffort: null,
    supportsTools: true,
    supportsVision: false,
    customProtocol: false,
    supportsReasoning: true,
    pricing: null,
    setDefault: false,
    ...overrides,
  });

  it('三项都显式写进 preset：缺键会被 pydantic 静默丢弃，表现为「保存了又没了」', () => {
    const mutation = buildMutation(
      value({ supportsTools: false, supportsVision: true, customProtocol: true }),
    );
    if (mutation.op !== 'upsert') throw new Error('期望 upsert');
    expect(mutation.config.supportsTools).toBe(false);
    expect(mutation.config.supportsVision).toBe(true);
    expect(mutation.config.customProtocol).toBe(true);
  });

  it('回读：键存在就按它读，缺键（旧预设）落到引擎字段默认值', () => {
    const rows = buildManaged({
      presets: {
        'with-flags': {
          model: 'm1',
          provider: 'deepseek',
          maxTokens: 8192,
          contextWindowTokens: 200000,
          temperature: 0.1,
          reasoningEffort: null,
          supportsTools: false,
          supportsVision: true,
          customProtocol: true,
        },
        'legacy-preset': {
          model: 'm2',
          provider: 'deepseek',
          maxTokens: 8192,
          contextWindowTokens: 200000,
          temperature: 0.1,
          reasoningEffort: null,
        },
      },
      providers: {},
      defaultPreset: null,
    });
    const withFlags = rows.find((r) => r.name === 'with-flags')!;
    expect(withFlags.supportsTools).toBe(false);
    expect(withFlags.supportsVision).toBe(true);
    expect(withFlags.customProtocol).toBe(true);

    // 旧预设没有这三个键 → 缺省，**不能**读成「不支持工具调用」
    const legacy = rows.find((r) => r.name === 'legacy-preset')!;
    expect(legacy.supportsTools).toBe(true);
    expect(legacy.supportsVision).toBe(false);
    expect(legacy.customProtocol).toBe(false);
  });

  it('显式 null / 非法类型也落到缺省（勾选框由 boolean 驱动，读到 null 会变非受控）', () => {
    const rows = buildManaged({
      presets: {
        weird: {
          model: 'm',
          provider: 'deepseek',
          maxTokens: 8192,
          contextWindowTokens: 200000,
          temperature: 0.1,
          reasoningEffort: null,
          supportsTools: null as unknown as boolean,
          supportsVision: 'yes' as unknown as boolean,
        },
      },
      providers: {},
      defaultPreset: null,
    });
    expect(rows[0].supportsTools).toBe(true);
    expect(rows[0].supportsVision).toBe(false);
  });
});

describe('「查看文档」与模型候选清单', () => {
  it('文档地址只认 http(s)，且目录里每一项都能打开', () => {
    for (const spec of MODEL_PROVIDERS) {
      if (!spec.docsUrl) continue;
      expect(spec.docsUrl, `${spec.name} 的文档地址必须是 http(s)`).toMatch(/^https:\/\//);
    }
  });

  it('查不到文档的供应商返回 null（界面据此不渲染入口）', () => {
    expect(providerDocsUrl('deepseek')).toBe('https://api-docs.deepseek.com');
    // 没登记文档的供应商与自定义/auto 一样：不给链接，而不是给一个猜的地址
    expect(providerDocsUrl('minimax')).toBeNull();
    expect(providerDocsUrl(CUSTOM_PROVIDER_VALUE)).toBeNull();
    expect(providerDocsUrl(AUTO_PROVIDER_VALUE)).toBeNull();
  });

  it('常用模型清单：非空、无重复、无多余空格', () => {
    for (const spec of MODEL_PROVIDERS) {
      const models = spec.models ?? [];
      expect(new Set(models).size, `${spec.name} 的清单里有重复项`).toBe(models.length);
      for (const name of models) {
        expect(name, `${spec.name} 的清单里有空项`).toBe(name.trim());
        expect(name.length).toBeGreaterThan(0);
      }
    }
  });

  it('候选顺序：探测结果在前、内置清单在后（清单注定过时，真实数据优先）', () => {
    expect(providerModelOptions('deepseek', ['probe-a', 'probe-b'])).toEqual([
      'probe-a',
      'probe-b',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);
  });

  it('候选去重，且 trim 掉探测结果里的空白（上游偶尔带空格）', () => {
    expect(providerModelOptions('deepseek', [' deepseek-v4-pro ', '', '  '])).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);
  });

  it('编辑中的当前值也在候选里（否则框里那个字符串看着像填错了）', () => {
    const options = providerModelOptions('minimax', ['some-exotic-model']);
    expect(options).toEqual(['some-exotic-model']);
  });

  it('auto / 自定义供应商没有内置清单，只剩传入的 extra', () => {
    expect(providerModelOptions(AUTO_PROVIDER_VALUE)).toEqual([]);
    expect(providerModelOptions(CUSTOM_PROVIDER_VALUE, ['mine'])).toEqual(['mine']);
  });
});

describe('providerMonogram: 供应商字标', () => {
  it('取展示名的第一个字母/数字并大写', () => {
    expect(providerMonogram('OpenAI')).toBe('O');
    expect(providerMonogram('Moonshot（Kimi）')).toBe('M');
    expect(providerMonogram('deepseek')).toBe('D');
  });

  it('CJK 与「标签以符号开头」都不致于空掉', () => {
    expect(providerMonogram('阿里云 DashScope（通义）')).toBe('阿');
    expect(providerMonogram('  ·  网关')).toBe('网');
    expect(providerMonogram('')).toBe('?');
  });
});

describe('providerOptionLabel: 下拉回显文案', () => {
  it('自定义哨兵值显示成「自定义」，而不是把 __custom__ 原样吐出来', () => {
    expect(providerOptionLabel(CUSTOM_PROVIDER_VALUE)).toBe('自定义');
  });

  it('内置供应商与 auto 沿用目录标签', () => {
    expect(providerOptionLabel('deepseek')).toBe('DeepSeek 深度求索');
    expect(providerOptionLabel(AUTO_PROVIDER_VALUE)).toBe('自动匹配');
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
