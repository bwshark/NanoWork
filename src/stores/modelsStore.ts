import { create } from 'zustand';
import { connectionManager } from '@/ai/connectionManager';
import { platform } from '@/platform';
import type { NanobotModelsMutation, NanobotModelsSnapshot } from '@/platform/types';
import type { ModelInfo } from '@/types';
import {
  AUTO_PROVIDER_VALUE,
  CUSTOM_PROVIDER_VALUE,
  isBuiltinProvider,
  modelProviderLabel,
  slugifyProviderKey,
  toProviderConfigKey,
} from '@/lib/modelProviders';
import {
  ENGINE_DEFAULT_CAPABILITIES,
  ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS,
  ENGINE_DEFAULT_MAX_TOKENS,
  ENGINE_DEFAULT_TEMPERATURE,
  normalizeTokenLimit,
} from '@/lib/modelOptions';

/**
 * 设置页「模型」分区里的一行。
 *
 * 它对应引擎配置里的**一个 modelPreset + 它引用的 provider 条目**，而不是
 * `/v1/models` 返回的一项——后者是网关启动时的快照（上面的 `models`），
 * 前者才是可写的真身。两者必须分开存：写完 preset 要重启 serve，`models`
 * 才会跟着变，混成一个数组的话「保存成功了但下拉里没有」就无法解释。
 */
export interface ManagedModel {
  /** 预设名 = 请求里发出的 model 值 = 模型选择器里显示的那行字 */
  name: string;
  /** 上游真实模型名 */
  model: string;
  /** preset.provider：内置为注册表名，自定义为 config key */
  provider: string;
  /** 供应商在 providers 里的 config key */
  providerKey: string;
  /** 供应商展示名 */
  providerLabel: string;
  /** 供应商密钥编辑值（回读自 config.json，列表里只展示「是否已配置」） */
  apiKey: string;
  /** 自定义供应商的 API Base；内置供应商恒为空（用引擎注册表默认值） */
  apiBase: string;
  hasKey: boolean;
  isDefault: boolean;
  /** 是否为自定义供应商（决定删除模型时能否顺带清掉 provider 条目） */
  custom: boolean;
  /**
   * 上下文窗口（tokens）；`null` = 与引擎默认值一致 = 界面上的「使用提供商默认值」。
   *
   * 归一化在 `buildManaged` 里做（`ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS → null`），
   * 这样「我没设过」与「我特意设成 200K（＝引擎默认）」在界面上是同一个状态——它们
   * 的语义本来就是同一个，区分开只会让用户以为自己的设置丢了。
   */
  contextWindowTokens: number | null;
  /** 单次最大输出（tokens）；`null` 同上 */
  maxTokens: number | null;
  /** 思考强度（引擎 `reasoning_effort`）；`null` = 不注入，跟随供应商默认 */
  reasoningEffort: string | null;
  /**
   * 能力声明：该模型支持 function calling。
   *
   * 缺省由 `buildManaged` 按引擎字段默认值（true）补齐——**旧预设里没有这个键
   * 不代表「不支持工具调用」**，把它读成 false 会让老预设一打开就显示成不支持。
   */
  supportsTools: boolean;
  /** 能力声明：该模型接受图片输入（引擎默认 false） */
  supportsVision: boolean;
  /** 能力声明：端点不走标准 OpenAI 兼容协议（引擎默认 false） */
  customProtocol: boolean;
  /**
   * 采样温度。
   *
   * 表单**不暴露**这个值，但必须回读：`buildMutation` 要把它原样带过去。不读的话
   * 每次「编辑一下模型名」都会把它重置成引擎默认值，而这种丢失界面上看不见。
   */
  temperature: number;
}

/** 「添加 / 编辑模型」对话框提交的表单值 */
export interface ModelFormValue {
  /** 内置供应商的注册表名，或 `CUSTOM_PROVIDER_VALUE` */
  provider: string;
  /** 自定义供应商的显示名（provider 为 CUSTOM_PROVIDER_VALUE 时使用） */
  customProviderName: string;
  /** 自定义供应商的 API Base（OpenAI 兼容前缀） */
  apiBase: string;
  /**
   * 供应商密钥。**可以留空**：密钥也可能来自引擎侧已配置的值、环境变量
   * （`<PROVIDER>_API_KEY`），或者供应商本来就不需要（本地部署、内网网关）。
   * 留空时写 `null`，引擎按自己的回退链取值。
   */
  apiKey: string;
  /** 模型名；**同时就是预设名**，因此也是模型选择器里显示的那行字 */
  model: string;
  /** 上下文窗口（tokens）；`null` = 写引擎默认值（即不覆盖供应商默认） */
  contextWindowTokens: number | null;
  /** 单次最大输出（tokens）；`null` = 写引擎默认值 */
  maxTokens: number | null;
  /** 思考强度；`null` = 关闭思考模式（不注入 `reasoning_effort`） */
  reasoningEffort: string | null;
  /** 能力声明：支持 function calling（与引擎 `supports_tools` 同名同义） */
  supportsTools: boolean;
  /** 能力声明：接受图片输入 */
  supportsVision: boolean;
  /** 能力声明：端点不走标准 OpenAI 兼容协议 */
  customProtocol: boolean;
  /** 保存后是否立即设为默认 */
  setDefault: boolean;
  /** 编辑模式下的原模型（新增时省略） */
  original?: ManagedModel;
}

interface ModelsState {
  /**
   * 模型目录（来源：nanobot 网关 /v1/models，即其配置中的 modelPresets +
   * 隐式 default，default 固定首位）。空数组表示未加载或网关离线。
   */
  models: ModelInfo[];
  loading: boolean;
  /**
   * 从 nanobot 网关拉取模型目录。
   * - 并发去重：多处同时触发仅发起一次请求；
   * - 已加载且非 force 时直接短路，打开下拉等高频场景零开销；
   * - 失败（离线/异常）静默保留旧列表，UI 回退默认模型展示。
   * @param force 是否强制重新拉取（网关配置变更后使用）
   */
  refresh: (force?: boolean) => Promise<void>;

  // —— 可写的那一半：引擎 config.json 里的 modelPresets ——
  /** 引擎配置中的模型预设（设置页「模型」分区的数据源） */
  managed: ManagedModel[];
  managedLoading: boolean;
  /**
   * 配置是否可读。Web 端与「找不到 config.json」时为 false：
   * 与「配置里一个模型都没有」是**两件事**，界面据此分别提示
   * 「Web 端不支持」和「还没有自定义模型」。
   */
  managedAvailable: boolean;
  /** 从 config.json 重新读取模型预设 */
  loadManaged: () => Promise<void>;
  /** 新增或更新一个模型；成功返回 true */
  saveModel: (value: ModelFormValue) => Promise<boolean>;
  /** 删除一个模型；成功返回 true */
  removeModel: (name: string) => Promise<boolean>;
  /** 把一个已有模型设为默认；成功返回 true */
  setDefaultModel: (name: string) => Promise<boolean>;
}

/** 进行中的拉取任务（并发去重句柄） */
let inflight: Promise<void> | null = null;

/** 配置里的 provider 名 → providers 里的 config key（内置大小写/连字符都可能不同） */
export function resolveProviderKey(provider: string, keys: string[]): string {
  const camel = toProviderConfigKey(provider);
  if (keys.includes(camel)) return camel;
  if (keys.includes(provider)) return provider;
  const wanted = provider.replace(/-/g, '_').toLowerCase();
  return keys.find((key) => key.replace(/-/g, '_').toLowerCase() === wanted) ?? camel;
}

/**
 * 引擎快照 → 设置页行模型。
 *
 * 导出只为单测：这里编码了「预设名 / 模型名 / providers key」三者的映射，
 * 写错不会报错，只会让界面上的供应商显示成另一个名字——靠肉眼挑不出来。
 */
export function buildManaged(snapshot: NanobotModelsSnapshot): ManagedModel[] {
  const keys = Object.keys(snapshot.providers);
  return Object.entries(snapshot.presets)
    .map(([name, preset]): ManagedModel => {
      const provider = String(preset?.provider ?? '');
      const providerKey = provider ? resolveProviderKey(provider, keys) : '';
      const entry = providerKey ? snapshot.providers[providerKey] : undefined;
      const apiKey = entry?.apiKey ?? '';
      return {
        name,
        model: String(preset?.model ?? name),
        provider,
        providerKey,
        providerLabel: provider === 'auto' ? '自动匹配' : modelProviderLabel(provider),
        apiKey,
        apiBase: entry?.apiBase ?? '',
        hasKey: apiKey !== '',
        isDefault: snapshot.defaultPreset === name,
        // auto 不指向任何 providers 条目，删除时没有东西要清理
        custom:
          Boolean(providerKey) &&
          provider !== AUTO_PROVIDER_VALUE &&
          !isBuiltinProvider(providerKey),
        // 与引擎默认值相同的取值折成 null（＝界面上的「使用提供商默认值」），
        // 判据集中在 `normalizeTokenLimit`，别在这里再写一遍 `=== 200_000`
        contextWindowTokens: normalizeTokenLimit(
          preset?.contextWindowTokens,
          ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS,
        ),
        maxTokens: normalizeTokenLimit(preset?.maxTokens, ENGINE_DEFAULT_MAX_TOKENS),
        reasoningEffort:
          typeof preset?.reasoningEffort === 'string' && preset.reasoningEffort
            ? preset.reasoningEffort
            : null,
        // 能力声明的缺省值与引擎字段默认值一致（`ENGINE_DEFAULT_CAPABILITIES`）。
        // 必须用 `typeof === 'boolean'` 判真值而不是 `?? true`：`null`（用户手改过
        // config.json）与「键不存在」（旧预设）要落到同一个缺省，别把 null 留在
        // 界面状态里——它会让勾选框变成非受控。
        supportsTools:
          typeof preset?.supportsTools === 'boolean'
            ? preset.supportsTools
            : ENGINE_DEFAULT_CAPABILITIES.supportsTools,
        supportsVision:
          typeof preset?.supportsVision === 'boolean'
            ? preset.supportsVision
            : ENGINE_DEFAULT_CAPABILITIES.supportsVision,
        customProtocol:
          typeof preset?.customProtocol === 'boolean'
            ? preset.customProtocol
            : ENGINE_DEFAULT_CAPABILITIES.customProtocol,
        temperature:
          typeof preset?.temperature === 'number' && Number.isFinite(preset.temperature)
            ? preset.temperature
            : ENGINE_DEFAULT_TEMPERATURE,
      };
    })
    // 默认预设排在最前，其余按名字排序：列表顺序稳定，才不会每次重开设置都跳一遍
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * 表单值 → 主进程的变更指令。
 *
 * 导出只为单测：camelCase 的 providers key 与 snake_case 的 preset.provider
 * 是两个不同形态，写反了引擎会**静默**匹配不到供应商（抛出的是
 * `No provider is configured`，而且要等到真正发起对话时才炸）。
 */
export function buildMutation(value: ModelFormValue): NanobotModelsMutation {
  const model = value.model.trim();
  const custom = value.provider === CUSTOM_PROVIDER_VALUE;
  // auto 不落任何 providers 条目：引擎自己按模型名反查供应商
  const auto = value.provider === AUTO_PROVIDER_VALUE;
  const providerKey = custom
    ? slugifyProviderKey(value.customProviderName || value.apiBase || model)
    : toProviderConfigKey(value.provider);
  return {
    op: 'upsert',
    preset: model,
    // 改名 = 换 key：预设没有 label 字段，多写的键会被 pydantic 静默丢弃
    previousPreset:
      value.original && value.original.name !== model ? value.original.name : undefined,
    config: {
      model,
      provider: custom ? providerKey : value.provider,
      // `null` = 用户在界面上选了「使用提供商默认值」→ 写入引擎自己的默认值。
      // 不能省略这两个键：`modelPresets` 由我们整体写入，缺字段会退回 pydantic 默认值，
      // 结果虽然一样，但「写进去的到底是哪个数」就查不出来了。
      maxTokens: value.maxTokens ?? ENGINE_DEFAULT_MAX_TOKENS,
      contextWindowTokens: value.contextWindowTokens ?? ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS,
      // 温度不在表单里，必须从原预设带过来：硬编码会让「只改个模型名」顺手把用户在
      // 引擎 WebUI 里调过的采样温度重置掉（界面上完全看不出来）
      temperature: value.original?.temperature ?? ENGINE_DEFAULT_TEMPERATURE,
      // 思考模式：开启写具体档位，关闭写 null（＝不注入，跟随供应商默认）
      reasoningEffort: value.reasoningEffort,
      // 能力声明：三项都**显式写全**。它们引擎当前不消费，但缺键会被 pydantic
      // 静默丢弃（`Base` 未开 extra="allow"）——「勾选了、保存了、再打开又没了」
      // 就是这么来的。引擎侧字段声明见 `nanobot/config/schema.py::ModelPresetConfig`。
      supportsTools: value.supportsTools,
      supportsVision: value.supportsVision,
      customProtocol: value.customProtocol,
    },
    provider: auto
      ? undefined
      : {
          key: providerKey,
          apiKey: value.apiKey.trim() || null,
          // 内置供应商**留空时不写** apiBase：让引擎用注册表默认值，否则用户
          // 日后手改注册表默认值，我们写进去的旧地址会一直压着它。
          // 只有用户显式填了（自建网关 / 代理）才覆盖。
          apiBase: value.apiBase.trim()
            ? value.apiBase.trim()
            : custom
              ? null
              : undefined,
          displayName: custom ? value.customProviderName.trim() || null : undefined,
        },
    setDefault: value.setDefault,
  };
}

export const useModelsStore = create<ModelsState>()((set, get) => ({
  models: [],
  loading: false,

  refresh: (force = false) => {
    if (inflight) return inflight;
    if (!force && get().models.length > 0) return Promise.resolve();
    set({ loading: true });
    inflight = (async () => {
      try {
        const client = await connectionManager.getClient();
        const models = await client.listModels();
        set({ models });
      } catch {
        // 网关离线或拉取失败：保留旧目录，UI 以默认模型兜底展示
      } finally {
        set({ loading: false });
        inflight = null;
      }
    })();
    return inflight;
  },

  managed: [],
  managedLoading: false,
  managedAvailable: false,

  loadManaged: async () => {
    set({ managedLoading: true });
    try {
      const snapshot = await platform.getNanobotModels();
      if (!snapshot) {
        set({ managed: [], managedAvailable: false });
        return;
      }
      set({ managed: buildManaged(snapshot), managedAvailable: true });
    } catch {
      // 配置损坏 / 主进程桥不可用：保持上一次的列表，把可用性标为 false
      set({ managedAvailable: false });
    } finally {
      set({ managedLoading: false });
    }
  },

  saveModel: async (value) => {
    const mutation = buildMutation(value);
    const result = await platform.syncNanobotModels(JSON.stringify(mutation));
    if (!result.ok) return false;
    await get().loadManaged();
    // 预设目录在 serve 启动时构建 → 必须强制重拉，否则下拉里看不到新模型
    await get().refresh(true);
    return true;
  },

  removeModel: async (name) => {
    const target = get().managed.find((item) => item.name === name);
    const mutation: NanobotModelsMutation = {
      op: 'delete',
      preset: name,
      providerKey: target?.custom ? target.providerKey : undefined,
    };
    const result = await platform.syncNanobotModels(JSON.stringify(mutation));
    if (!result.ok) return false;
    await get().loadManaged();
    await get().refresh(true);
    return true;
  },

  setDefaultModel: async (name) => {
    const mutation: NanobotModelsMutation = { op: 'setDefault', preset: name };
    const result = await platform.syncNanobotModels(JSON.stringify(mutation));
    if (!result.ok) return false;
    await get().loadManaged();
    await get().refresh(true);
    return true;
  },
}));

/**
 * 隐式 default 预设的条目（`/v1/models` 固定把它排在首位）。
 * 请求里**不带 `model` 字段**时实际生效的就是它，所以判据要以 `id` 为准、
 * 而不是靠数组位置——顺序将来变了也不该让「Auto 指向谁」跟着漂。
 */
export function defaultModelEntry(models: ModelInfo[]): ModelInfo | undefined {
  return models.find((m) => m.id === 'default') ?? models[0];
}

/**
 * 模型选择的展示文案：**chip 与菜单行共用这一份口径**，两处永远同字。
 *
 * 两个坑都在这里收口：
 * 1. **Auto 不是一个模型 id**——此时请求里不带 `model` 字段，真正生效的是隐式 default
 *    预设。所以写成 `Auto · <真实模型名>`：只写模型名会让人以为「选了某个预设」
 *    （2026-09-21 的 `The model sciherd does not exist` 就是这么误判出来的），
 *    只写 Auto 又看不出到底跑哪个模型。
 * 2. **预设名 ≠ 模型名**——写成 `sciherd · Qwen3.8-Flash`。前者是请求里发出去的那个值
 *    （引擎据此查 `modelPresets`），后者才是交给上游的值。两者不同名时必须都写出来；
 *    否则「默认模型的模型名恰好等于某个预设名」时，菜单里会出现两行一模一样的文案，
 *    而它们的真实含义完全不同。
 *
 * @param models 模型目录
 * @param id 会话/任务所选模型 id（空串/undefined 表示 Auto）
 * @returns 可直接渲染的文案；目录为空时退化为 `Auto` 或原样 id，**不返回 undefined**
 *   （调用方不再需要各自兜底，兜底文案一旦分叉就又会两处不一致）
 */
export function describeModelId(models: ModelInfo[], id?: string | null): string {
  if (id) {
    const entry = models.find((m) => m.id === id);
    // 目录里没有的 id（用户自填的模型名）：原样展示，别吞掉他写的东西
    if (!entry) return id;
    const label = entry.label ?? entry.model ?? entry.id;
    return entry.model && entry.model !== label ? `${label} · ${entry.model}` : label;
  }
  const def = defaultModelEntry(models);
  const real = def?.model ?? def?.label;
  return real ? `Auto · ${real}` : 'Auto';
}
