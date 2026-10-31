import { create } from 'zustand';
import { connectionManager } from '@/ai/connectionManager';
import { platform } from '@/platform';
import type {
  ModelsSyncResult,
  NanobotFallbackCandidate,
  NanobotModelsMutation,
  NanobotModelsSnapshot,
  ProviderRetryMode,
} from '@/platform/types';
import { DEFAULT_PROVIDER_RETRY_MODE } from '@/lib/model/modelFallbacks';
import { normalizePricing, type ModelPricing } from '@/lib/model/modelPricing';
import {
  builtinModelIds,
  groupCatalog,
  missingBuiltinModels,
  type BuiltinModel,
  type ModelCatalogGroups,
} from '@/lib/model/builtinModels';
import type { BuiltinModelsResult } from '@/lib/model/builtinModelsClient';
import type { ModelInfo } from '@/types';
import {
  AUTO_PROVIDER_VALUE,
  CUSTOM_PROVIDER_VALUE,
  isBuiltinProvider,
  modelProviderLabel,
  slugifyProviderKey,
  toProviderConfigKey,
} from '@/lib/model/modelProviders';
import {
  ENGINE_DEFAULT_CAPABILITIES,
  ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS,
  ENGINE_DEFAULT_MAX_TOKENS,
  ENGINE_DEFAULT_TEMPERATURE,
  normalizeTokenLimit,
} from '@/lib/model/modelOptions';

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
  /**
   * 能力声明：该模型有思考模式（引擎默认 **true**）。
   *
   * 与 `supportsTools` 一样用于**硬门禁**（关闭「注入思考强度」并给出原因），
   * 所以缺省取宽松方向——默认保守会把所有历史预设一升级就禁掉。
   */
  supportsReasoning: boolean;
  /** 能力声明：端点不走标准 OpenAI 兼容协议（引擎默认 false） */
  customProtocol: boolean;
  /**
   * 单价（每百万 token）；`null` = 没配（界面「成本」卡片据此说「暂不统计」）。
   *
   * 归一化在 `buildManaged` 里做：全零的单价会折成 `null` —— 留着它会让
   * 「已配置单价」判成真，于是界面显示 `¥0` 而不是「暂不统计」，
   * 用户会以为自己的模型不花钱。
   */
  pricing: ModelPricing | null;
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
  /**
   * 预设名（可选，缺省 = `model`）。
   *
   * 只有一处需要它：**云端下发的内置模型**。云端把「预设名」与「上游模型名」分成
   * 两个字段（`id` / `model`），因为同一上游模型可以有两个预设。表单里两者仍绑在一起
   * ——用户手动加模型时不需要理解这个区分。
   */
  presetName?: string;
  /**
   * 供应商 config key（可选，缺省按 `customProviderName` / `apiBase` / `model` 推导）。
   *
   * 同样只为内置模型：云端已经定好了 key（如 `agnes`），客户端再 slug 一遍
   * 只会引入「展示名一改，key 就漂了，于是写出一份新的 providers 条目」这种事故。
   */
  providerKey?: string;
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
  /** 能力声明：有思考模式（关闭时同时把 `reasoningEffort` 清空） */
  supportsReasoning: boolean;
  /** 能力声明：端点不走标准 OpenAI 兼容协议 */
  customProtocol: boolean;
  /** 单价（每百万 token）；`null` = 不配 → 「用量」分区不计金额 */
  pricing: ModelPricing | null;
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

  // —— 云端下发的内置模型目录 ——
  /**
   * 内置模型（来源：云端 `GET /api/models/builtin`）。
   *
   * 与 `models` 是**两个维度**：这里说的是「产品提供哪些模型」，`models` 说的是
   * 「这台机器此刻能用哪些预设」。两者交集才是选择器里「内置模型」那一组 ——
   * 云端有、本机还没播种成功时不进菜单（选了也发不出请求）。
   */
  builtin: BuiltinModel[];
  builtinLoading: boolean;
  /**
   * 云端目录是否真的取到了。
   *
   * 与「取到了但是空的」必须分开：前者说明云端/登录有问题，后者是云端确实没配。
   * 界面在 false 时**不显示**「内置模型」这个标题，而不是显示一个空分组。
   */
  builtinAvailable: boolean;
  /**
   * 拉取内置目录，并把本机缺失的条目自动播种进引擎配置。
   *
   * 幂等：已在 `managed` 里的预设不会被改写（用户换过自己的密钥要保留）。
   * 未登录 / 断网时静默返回 —— 内置模型是增强能力，不该让应用启动报错。
   */
  loadBuiltin: () => Promise<void>;

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
  /**
   * 回退链（`agents.defaults.fallbackModels`），**按引擎里的原序**。
   *
   * 顺序即语义（主模型失败后依次尝试，第一个成功就停），所以这里不做任何排序 /
   * 归一——`buildManaged` 那套「默认排最前」的规则在这里会直接改错东西。
   */
  managedFallbacks: NanobotFallbackCandidate[];
  /** `agents.defaults.providerRetryMode` */
  providerRetryMode: ProviderRetryMode;
  /**
   * 从 config.json 重新读取模型预设。
   *
   * `force`：已有一次读取在飞时要不要另起一次。默认 false（复用飞着的那次）——
   * 否则「设置页打开 + 聊天页门控补读」这类并发会各读一遍，且**后写盘的旧结果
   * 可能覆盖先返回的新结果**（保存模型后紧接着的回读就是这样被冲掉的）。
   * 明确要「以磁盘为准确认一次」的场合（进入模型分区、保存 / 删除之后）传 true。
   */
  loadManaged: (force?: boolean) => Promise<void>;
  /**
   * 新增或更新一个模型；成功返回 true。
   *
   * 返回值是主进程的**完整**同步结果而不是布尔：serve 由外部进程托管（或上一实例
   * 残留的进程被「复用」）时，配置已写盘但 `/v1/models` 还是旧目录，主进程只能以
   * `needsRestart` 告知——把它吞成 `false`/`true`，调用方就无法提示「重启网关后才
   * 生效」，用户会一直对着旧下拉以为保存没生效（2026-10-07 实测事故）。
   */
  saveModel: (value: ModelFormValue) => Promise<ModelsSyncResult>;
  /** 删除一个模型；返回值语义同 `saveModel`（要透传 `needsRestart`） */
  removeModel: (name: string) => Promise<ModelsSyncResult>;
  /** 把一个已有模型设为默认；返回值语义同 `saveModel`（要透传 `needsRestart`） */
  setDefaultModel: (name: string) => Promise<ModelsSyncResult>;
  /** 整链替换回退链 + 重试模式；返回值语义同 `saveModel`（要透传 `needsRestart`） */
  setFailover: (
    fallbacks: NanobotFallbackCandidate[],
    providerRetryMode: ProviderRetryMode,
  ) => Promise<ModelsSyncResult>;
}

/** 进行中的拉取任务（并发去重句柄） */
let inflight: Promise<void> | null = null;
/** `loadManaged` 的飞行中请求（与 `inflight` 分开：两者数据源完全不同） */
let managedInflight: Promise<void> | null = null;
/** `loadBuiltin` 的飞行中请求（第三个数据源：云端目录） */
let builtinInflight: Promise<void> | null = null;

/** 内置目录的取数器（装配处注入，见 `sync/builtinModelsGateway`） */
export type BuiltinModelsFetcher = () => Promise<BuiltinModelsResult>;

let builtinFetcher: BuiltinModelsFetcher | null = null;

/**
 * 注入内置目录取数器（只由 `App.tsx` 在同步运行时就绪后调用一次）。
 *
 * **为什么是注入而不是 import**：`modelsStore` 被大量 UI 依赖，让它 import
 * `sync/runtime` 会形成 `runtime → store → modelsStore → runtime` 的环。
 * 与知识库检索的 `setKnowledgeSearchProvider` 是同一手法，也是本仓既有的唯一解法。
 */
export function setBuiltinModelsFetcher(fetcher: BuiltinModelsFetcher | null): void {
  builtinFetcher = fetcher;
}

/**
 * 云端条目 → 一次 upsert 的表单值。
 *
 * `provider` 分两种情况，**不能一律按自定义供应商写**：
 * - 云端说的是注册表里的内置供应商（`openai` / `deepseek`…）→ 传供应商名，`apiBase`
 *   留空让引擎用注册表默认值（写了旧地址会永久压着它）；
 * - 其它（如 `agnes` 这种动态供应商）→ 传 `CUSTOM_PROVIDER_VALUE` + 显式
 *   `providerKey`，这样 `providers.agnes` 的 apiKey / apiBase / displayName 才会被建出来。
 */
function seedFormValue(item: BuiltinModel): ModelFormValue {
  const registryProvider = item.provider && isBuiltinProvider(item.provider);
  return {
    provider: registryProvider ? item.provider : CUSTOM_PROVIDER_VALUE,
    providerKey: item.provider || undefined,
    customProviderName: item.providerLabel || item.provider,
    apiBase: item.apiBase,
    apiKey: item.apiKey,
    model: item.model,
    // 预设名与上游模型名分开传：云端 `id` 才是请求里发出的那个键
    presetName: item.id,
    contextWindowTokens: item.contextWindowTokens,
    maxTokens: item.maxTokens,
    reasoningEffort: item.reasoningEffort,
    supportsTools: item.supportsTools,
    supportsVision: item.supportsVision,
    supportsReasoning: item.supportsReasoning,
    customProtocol: item.customProtocol,
    pricing: item.pricing,
    // 播种**绝不改默认模型**：用户可能已经选了别的，「装个新版本后默认模型被换掉」
    // 是最难解释的一类回归
    setDefault: false,
  };
}

/**
 * 补齐本机缺失的内置模型；返回是否真的写过盘。
 *
 * 两条纪律：
 * 1. **只补缺**（`missingBuiltinModels`）——用户可能在本机把某个内置模型的密钥
 *    换成了自己的（额度隔离），那种改动必须保留；
 * 2. **写盘后重新拉目录**：`/v1/models` 是 serve 启动时的快照，不重拉的话菜单里
 *    仍然看不到刚播种的模型（与 `saveModel` 同一条收尾）。
 */
async function seedBuiltinModels(list: readonly BuiltinModel[]): Promise<boolean> {
  const state = useModelsStore.getState();
  // Web 端读不到 config.json：只展示不播种（`syncNanobotModels` 在 Web 会降级成
  // 「下载配置片段」，那不是用户此刻想要的东西）
  if (!state.managedAvailable) return false;

  const missing = missingBuiltinModels(
    list,
    state.managed.map((item) => item.name),
  );
  if (missing.length === 0) return false;

  let wrote = false;
  for (const item of missing) {
    // 逐条 upsert：主进程的合并指令是「一个预设一条」，批量语义不存在。
    // 代价是首装时每条都会重启一次 serve（主进程在 changed 时就会重启）——
    // 内置模型只有个位数，且只在缺失时发生，换来的是不需要改主进程协议。
    const result = await platform.syncNanobotModels(
      JSON.stringify(buildMutation(seedFormValue(item))),
    );
    if (result.ok) wrote = true;
  }
  if (!wrote) return false;

  await useModelsStore.getState().loadManaged(true);
  await useModelsStore.getState().refresh(true);
  return true;
}

/** 目录分组（内置 / 自定义）。UI 用它渲染菜单，判据集中在 `lib/model/builtinModels` */
export function modelGroups(
  models: readonly ModelInfo[],
  builtin: readonly BuiltinModel[],
): ModelCatalogGroups {
  return groupCatalog(models, builtinModelIds(builtin));
}

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
        supportsReasoning:
          typeof preset?.supportsReasoning === 'boolean'
            ? preset.supportsReasoning
            : ENGINE_DEFAULT_CAPABILITIES.supportsReasoning,
        customProtocol:
          typeof preset?.customProtocol === 'boolean'
            ? preset.customProtocol
            : ENGINE_DEFAULT_CAPABILITIES.customProtocol,
        // 全零 / 非法 / 缺键都折成 null（见 `normalizePricing`）——「没配单价」与
        // 「单价为零」在界面上必须是同一个状态「暂不统计」，分开只会让人以为配过了
        pricing: normalizePricing(preset?.pricing),
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
  // 预设名缺省等于模型名（表单里两者是同一个输入框）；内置模型才显式分开
  const preset = (value.presetName ?? model).trim() || model;
  const custom = value.provider === CUSTOM_PROVIDER_VALUE;
  // auto 不落任何 providers 条目：引擎自己按模型名反查供应商
  const auto = value.provider === AUTO_PROVIDER_VALUE;
  const explicitKey = value.providerKey?.trim();
  const providerKey = explicitKey
    ? explicitKey
    : custom
      ? slugifyProviderKey(value.customProviderName || value.apiBase || model)
      : toProviderConfigKey(value.provider);
  return {
    op: 'upsert',
    preset,
    // 改名 = 换 key：预设没有 label 字段，多写的键会被 pydantic 静默丢弃
    previousPreset:
      value.original && value.original.name !== preset ? value.original.name : undefined,
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
      // 思考模式：开启写具体档位，关闭写 null（＝不注入，跟随供应商默认）。
      //
      // ⚠️ 这里额外强制一条**不变量：能力为假 ⇒ 强度为 null**。对话框的勾选联动
      // 已经保证了顺序操作的结果，但**手改过的 config.json** 完全可能两者矛盾
      // （声明不支持思考、却留着 `reasoning_effort: high`）。在唯一的写入点收口，
      // 一次保存就把矛盾数据自愈掉——而不是让它在下一次打开时继续显示「勾着但置灰」。
      reasoningEffort: value.supportsReasoning ? value.reasoningEffort : null,
      // 能力声明：四项都**显式写全**。它们引擎当前不消费，但缺键会被 pydantic
      // 静默丢弃（`Base` 未开 extra="allow"）——「勾选了、保存了、再打开又没了」
      // 就是这么来的。引擎侧字段声明见 `nanobot/config/schema.py::ModelPresetConfig`。
      supportsTools: value.supportsTools,
      supportsVision: value.supportsVision,
      supportsReasoning: value.supportsReasoning,
      customProtocol: value.customProtocol,
      // 单价同样显式写全：`null` 表示「不配」，与「没写这个键」不同——
      // 后者在引擎侧会落到默认 `None`（结果一样，但「到底写没写过」就查不出来了）
      pricing: value.pricing ? { ...value.pricing } : null,
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

/**
 * 写盘之后让引擎**热加载**这份配置，使「保存即生效」，并按结果修正 `needsRestart`。
 *
 * 为什么必须有这一步：引擎的模型目录是**启动时的快照**（预设 loader 还闭包住那个
 * Config 对象），只写配置文件的话 `/v1/models` 仍是旧目录 —— 以前只能提示用户重启网关。
 *
 * 返回 `false` = 这个网关不支持热加载（老版本端点不存在）或请求失败：此时保留主进程
 * 给的 `needsRestart`，UI 照旧提示重启。**不抛错**——配置已经写盘了。
 */
async function applyConfigToEngine(result: ModelsSyncResult): Promise<ModelsSyncResult> {
  if (!result.ok) return result;
  try {
    const client = await connectionManager.getClient();
    if (typeof client.reloadEngineConfig !== 'function') return result;
    const applied = await client.reloadEngineConfig();
    return applied ? { ...result, needsRestart: false } : result;
  } catch {
    return result;
  }
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
  managedFallbacks: [],
  providerRetryMode: DEFAULT_PROVIDER_RETRY_MODE,

  loadManaged: (force = false) => {
    // 复用飞行中的那一次：并发读同一个文件是白工，而且**旧结果后返回会覆盖新结果**
    // （「保存模型后紧接着回读」正是这种形态）。要确认磁盘现状的调用方传 force。
    if (managedInflight && !force) return managedInflight;
    set({ managedLoading: true });
    managedInflight = (async () => {
      try {
        const snapshot = await platform.getNanobotModels();
        if (!snapshot) {
          set({
            managed: [],
            managedFallbacks: [],
            managedAvailable: false,
          });
          return;
        }
        set({
          managed: buildManaged(snapshot),
          // 回退链**不做任何归一**（顺序即语义）；缺失字段由主进程侧补缺省
          managedFallbacks: snapshot.fallbacks,
          providerRetryMode: snapshot.providerRetryMode,
          managedAvailable: true,
        });
      } catch {
        // 配置损坏 / 主进程桥不可用：保持上一次的列表，把可用性标为 false
        set({ managedAvailable: false });
      } finally {
        set({ managedLoading: false });
        managedInflight = null;
      }
    })();
    return managedInflight;
  },

  builtin: [],
  builtinLoading: false,
  builtinAvailable: false,

  loadBuiltin: () => {
    // 并发去重：启动期与「打开模型菜单」几乎同时触发，拉两次云端没有意义
    if (builtinInflight) return builtinInflight;
    const fetcher = builtinFetcher;
    if (!fetcher) {
      // 装配处还没注入（启动早期）：不是错误，稍后还会再调一次
      set({ builtinAvailable: false });
      return Promise.resolve();
    }
    set({ builtinLoading: true });
    builtinInflight = (async () => {
      try {
        // 先读本机配置：播种的判据是「预设名是否已存在」，而 `managedAvailable`
        // 决定这台机器到底能不能写盘（Web 端不能）
        await get().loadManaged();
        const result = await fetcher();
        if (!result.ok) {
          // 未登录 / 断网 / 云端没起：**保留上一份清单**。清空会让选择器里的
          // 「内置模型」组瞬间消失，用户会以为模型被删了。
          set({ builtinAvailable: false });
          return;
        }
        set({ builtin: result.models, builtinAvailable: true });
        await seedBuiltinModels(result.models);
      } catch {
        set({ builtinAvailable: false });
      } finally {
        set({ builtinLoading: false });
        builtinInflight = null;
      }
    })();
    return builtinInflight;
  },

  saveModel: async (value) => {
    const mutation = buildMutation(value);
    const raw = await platform.syncNanobotModels(JSON.stringify(mutation));
    if (!raw.ok) return raw;
    // 先热加载再回读：反了会拉到旧目录，用户看到「保存了但列表没变」
    const result = await applyConfigToEngine(raw);
    await get().loadManaged(true);
    // 预设目录在 serve 启动时构建 → 必须强制重拉，否则下拉里看不到新模型
    await get().refresh(true);
    return result;
  },

  removeModel: async (name) => {
    const target = get().managed.find((item) => item.name === name);
    const mutation: NanobotModelsMutation = {
      op: 'delete',
      preset: name,
      providerKey: target?.custom ? target.providerKey : undefined,
    };
    const raw = await platform.syncNanobotModels(JSON.stringify(mutation));
    if (!raw.ok) return raw;
    // 先热加载再回读：反了会拉到旧目录，用户看到「保存了但列表没变」
    const result = await applyConfigToEngine(raw);
    await get().loadManaged(true);
    await get().refresh(true);
    return result;
  },

  setDefaultModel: async (name) => {
    const mutation: NanobotModelsMutation = { op: 'setDefault', preset: name };
    const raw = await platform.syncNanobotModels(JSON.stringify(mutation));
    if (!raw.ok) return raw;
    // 先热加载再回读：反了会拉到旧目录，用户看到「保存了但列表没变」
    const result = await applyConfigToEngine(raw);
    await get().loadManaged(true);
    await get().refresh(true);
    return result;
  },

  setFailover: async (fallbacks, providerRetryMode) => {
    const mutation: NanobotModelsMutation = { op: 'setFailover', fallbacks, providerRetryMode };
    const raw = await platform.syncNanobotModels(JSON.stringify(mutation));
    if (!raw.ok) return raw;
    // 先热加载再回读：反了会拉到旧目录，用户看到「保存了但列表没变」
    const result = await applyConfigToEngine(raw);
    // 以磁盘为准回读：主进程会做「引用归一」（字符串引用 ↔ 两态联合），
    // 拿本地那份乐观状态继续显示就可能与文件里的实际内容不一致
    await get().loadManaged(true);
    await get().refresh(true);
    return result;
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
