/**
 * 模型供应商目录。
 *
 * ⚠️ **这份数据是引擎 `nanobot/providers/registry.py` 的镜像，不是独立设计。**
 * 引擎的 HTTP 接口只暴露 `/v1/{chat/completions,models,plugins,tool-approvals}`，
 * 没有任何「列出供应商」的端点，所以客户端只能自带一份静态目录。
 * 三个字段必须与注册表对得上，改引擎时回来同步：
 *
 * - `name`  ← `ProviderSpec.name`（snake_case，注册表里的权威名）
 * - `label` ← `ProviderSpec.display_name`
 * - `apiBase` ← `ProviderSpec.default_api_base`
 *
 * 错位的后果不是「显示不好看」：`name` 写错会让 `preset.provider` 匹配不到
 * registry，`find_by_name` 失败后引擎抛 `No provider is configured`，
 * 而这个错误要到真正发起对话时才炸出来。
 *
 * **为什么由渲染层和主进程共用一份**：主进程做连接测试需要 `apiBase`，
 * 渲染层画下拉需要 `label` 与分组。两份各写一份，早晚出现
 * 「下拉里能选 A，测试却打到 B 的地址」。
 */

/** 供应商分组 id（下拉菜单的分组顺序即此数组顺序） */
export const MODEL_PROVIDER_GROUP_IDS = [
  'official',
  'gateway',
  'local',
  'custom',
] as const;

export type ModelProviderGroupId = (typeof MODEL_PROVIDER_GROUP_IDS)[number];

export const MODEL_PROVIDER_GROUP_LABELS: Record<ModelProviderGroupId, string> = {
  official: '官方直连',
  gateway: '聚合网关',
  local: '本地部署',
  custom: '自定义',
};

export interface ModelProviderSpec {
  /**
   * 引擎注册表里的供应商名（snake_case）。
   * 写 `modelPresets.<name>.provider` 时用**这个值**，camelCase 的 config key
   * 只在 `providers.<key>` 里出现——两者同名不同形，见 `toProviderConfigKey`。
   */
  name: string;
  /** 展示名（对齐注册表的 display_name） */
  label: string;
  group: ModelProviderGroupId;
  /**
   * 注册表的 default_api_base。**只用于连接测试与展示**：
   * 内置供应商落盘时一律不写 apiBase（留空让引擎用注册表默认值），
   * 否则用户手改过注册表默认值后，我们写的旧值会一直压着它。
   */
  apiBase: string;
  /**
   * 能否用 `GET {apiBase}/models` + `Authorization: Bearer <key>` 探活。
   * false 的三种情况：走非 OpenAI 兼容后端（Anthropic / Bedrock / Azure）、
   * 没有默认地址（vLLM）、走 OAuth 登录（未列入目录）。
   */
  probe: boolean;
}

/**
 * 内置供应商目录。
 *
 * 刻意**不含**以下注册表条目：
 * - `openai_codex` / `xai_grok` / `github_copilot`：OAuth 登录，本页没有授权入口，
 *   列出来只会让人建出一个永远跑不通的预设；
 * - `azure_openai` / `bedrock`：必须额外填 deployment / region，简化表单表达不了；
 * - `opencode_zen`：注册表里标了 `settings_alias_for=opencode`，是兼容别名；
 * - `assemblyai`：transcription-only，引擎会直接拒绝它承载对话。
 */
export const MODEL_PROVIDERS: ModelProviderSpec[] = [
  // —— 官方直连 ——
  { name: 'openai', label: 'OpenAI', group: 'official', apiBase: 'https://api.openai.com/v1', probe: true },
  { name: 'anthropic', label: 'Anthropic', group: 'official', apiBase: '', probe: false },
  { name: 'gemini', label: 'Google Gemini', group: 'official', apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai/', probe: true },
  { name: 'deepseek', label: 'DeepSeek 深度求索', group: 'official', apiBase: 'https://api.deepseek.com', probe: true },
  { name: 'dashscope', label: '阿里云 DashScope（通义）', group: 'official', apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', probe: true },
  { name: 'zhipu', label: '智谱 AI', group: 'official', apiBase: 'https://open.bigmodel.cn/api/paas/v4', probe: true },
  { name: 'moonshot', label: 'Moonshot（Kimi）', group: 'official', apiBase: 'https://api.moonshot.ai/v1', probe: true },
  { name: 'minimax', label: 'MiniMax', group: 'official', apiBase: 'https://api.minimax.io/v1', probe: true },
  { name: 'mistral', label: 'Mistral AI', group: 'official', apiBase: 'https://api.mistral.ai/v1', probe: true },
  { name: 'stepfun', label: '阶跃星辰 StepFun', group: 'official', apiBase: 'https://api.stepfun.com/v1', probe: true },
  { name: 'xiaomi_mimo', label: '小米 MIMO', group: 'official', apiBase: 'https://api.xiaomimimo.com/v1', probe: true },
  { name: 'longcat', label: 'LongCat', group: 'official', apiBase: 'https://api.longcat.chat/openai/v1', probe: true },
  { name: 'ant_ling', label: 'Ant Ling', group: 'official', apiBase: 'https://api.ant-ling.com/v1', probe: true },
  { name: 'qianfan', label: '百度千帆', group: 'official', apiBase: 'https://qianfan.baidubce.com/v2', probe: true },
  { name: 'nvidia', label: 'NVIDIA NIM', group: 'official', apiBase: 'https://integrate.api.nvidia.com/v1', probe: true },
  { name: 'groq', label: 'Groq', group: 'official', apiBase: 'https://api.groq.com/openai/v1', probe: true },
  { name: 'kimi_coding', label: 'Kimi Coding Plan', group: 'official', apiBase: 'https://api.kimi.com/coding/v1', probe: false },

  // —— 聚合网关 ——
  { name: 'openrouter', label: 'OpenRouter', group: 'gateway', apiBase: 'https://openrouter.ai/api/v1', probe: true },
  { name: 'siliconflow', label: '硅基流动 SiliconFlow', group: 'gateway', apiBase: 'https://api.siliconflow.cn/v1', probe: true },
  { name: 'modelscope', label: '魔搭社区 ModelScope', group: 'gateway', apiBase: 'https://api-inference.modelscope.cn/v1', probe: true },
  { name: 'volcengine', label: '火山引擎 VolcEngine', group: 'gateway', apiBase: 'https://ark.cn-beijing.volces.com/api/v3', probe: true },
  { name: 'volcengine_coding_plan', label: '火山引擎 Coding Plan', group: 'gateway', apiBase: 'https://ark.cn-beijing.volces.com/api/coding/v3', probe: true },
  { name: 'byteplus', label: 'BytePlus', group: 'gateway', apiBase: 'https://ark.ap-southeast.bytepluses.com/api/v3', probe: true },
  { name: 'byteplus_coding_plan', label: 'BytePlus Coding Plan', group: 'gateway', apiBase: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3', probe: true },
  { name: 'aihubmix', label: 'AiHubMix', group: 'gateway', apiBase: 'https://aihubmix.com/v1', probe: true },
  { name: 'novita', label: 'Novita AI', group: 'gateway', apiBase: 'https://api.novita.ai/openai', probe: true },
  { name: 'skywork', label: 'Skywork', group: 'gateway', apiBase: 'https://api.apifree.ai/agent/v1', probe: true },
  { name: 'edenai', label: 'Eden AI', group: 'gateway', apiBase: 'https://api.edenai.run/v3', probe: true },
  { name: 'orcarouter', label: 'OrcaRouter', group: 'gateway', apiBase: 'https://api.orcarouter.ai/v1', probe: true },
  { name: 'opencode', label: 'OpenCode Zen', group: 'gateway', apiBase: 'https://opencode.ai/zen/v1', probe: true },
  { name: 'opencode_go', label: 'OpenCode Go', group: 'gateway', apiBase: 'https://opencode.ai/zen/go/v1', probe: true },
  { name: 'huggingface', label: 'Hugging Face', group: 'gateway', apiBase: 'https://router.huggingface.co/v1', probe: true },

  // —— 本地部署 ——
  { name: 'ollama', label: 'Ollama', group: 'local', apiBase: 'http://localhost:11434/v1', probe: true },
  { name: 'lm_studio', label: 'LM Studio', group: 'local', apiBase: 'http://localhost:1234/v1', probe: true },
  { name: 'vllm', label: 'vLLM', group: 'local', apiBase: '', probe: false },
  { name: 'atomic_chat', label: 'Atomic Chat', group: 'local', apiBase: 'http://localhost:1337/v1', probe: true },
  { name: 'ovms', label: 'OpenVINO Model Server', group: 'local', apiBase: 'http://localhost:8000/v3', probe: true },
];

/**
 * 「自动匹配」——`preset.provider = "auto"`。
 *
 * 引擎此时按模型名的关键字反查供应商（`_match_provider` 的 keyword 分支），
 * 所以这类预设**不指向任何 providers 条目**。目录里必须留一个选项来表达它，
 * 否则编辑一个 auto 预设时下拉框无处可落，只能被迫改写成某个具体供应商——
 * 那等于在用户不知情的情况下改了路由规则。
 */
export const AUTO_PROVIDER_VALUE = 'auto';

/**
 * 「自定义 API」的哨兵值。
 *
 * 它不是注册表里的供应商，而是表单里的一个分支：选中后由用户手填 API Base，
 * 主进程在 `providers.<slug>` 下新建一个动态供应商（引擎 `create_dynamic_spec`
 * 支持任意额外字段成为 OpenAI 兼容供应商）。直接复用 `providers.custom`
 * 那个槽位只能挂一个自定义端点，第二个就会覆盖第一个。
 */
export const CUSTOM_PROVIDER_VALUE = '__custom__';

const BUILTIN_BY_NAME = new Map(MODEL_PROVIDERS.map((p) => [p.name, p]));

/** 判断一个供应商名是否在内置目录里（自定义供应商的 key 不在其中） */
export function isBuiltinProvider(name: string): boolean {
  return BUILTIN_BY_NAME.has(name);
}

/** 取供应商规格；自定义或未知供应商返回 undefined */
export function findModelProvider(name: string): ModelProviderSpec | undefined {
  return BUILTIN_BY_NAME.get(name);
}

/**
 * 供应商展示名。
 *
 * 目录里查不到时**退化为原样返回**而不是返回空串：预设里可能指向一个
 * 早先建好、如今已不在目录里的自定义供应商，把它显示成空白会让这行在
 * 列表里彻底失去身份（既看不出是谁，也不知道该不该删）。
 */
export function modelProviderLabel(name: string): string {
  if (!name) return '';
  if (name === AUTO_PROVIDER_VALUE) return '自动匹配';
  return BUILTIN_BY_NAME.get(name)?.label ?? name;
}

/**
 * 注册表 snake_case 名 → config.json 里的 camelCase key。
 *
 * 引擎的 `ProvidersConfig` 字段是 snake_case（`volcengine_coding_plan`），
 * 但 `Base` 挂了 `alias_generator=to_camel`，所以落盘形态是
 * `volcengineCodingPlan`。写 `providers.<key>` 必须用后者。
 */
export function toProviderConfigKey(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_all, ch: string) => ch.toUpperCase());
}

/**
 * 自定义供应商的显示名 → 合法的 config key。
 *
 * **保留 CJK**：只按 ASCII 过滤会把「我的网关」压成空串，于是所有中文名的
 * 自定义供应商都退化成同一个 `custom` 键、互相覆盖。引擎侧本来就吃非 ASCII
 * 的 config 键（`tools.mcpServers` 里就有「牧场数据」），没有理由在这里先
 * 把中文抹掉。
 *
 * 撞上内置名时加 `custom_` 前缀而不是报错：撞名的话引擎会优先按
 * `find_by_name` 命中内置 spec，用户填的 apiBase 会被内置默认值盖掉——
 * 这是一种「看起来存进去了、实际没生效」的静默失败，必须绕开。
 */
export function slugifyProviderKey(displayName: string): string {
  const base = displayName
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const safe = base || 'custom';
  return BUILTIN_BY_NAME.has(safe) ? `custom_${safe}` : safe;
}

/**
 * 本地供应商不需要 API Key。
 *
 * 引擎侧同款豁免：`spec.is_local or spec.is_direct` 时跳过 key 校验
 * （`providers/factory.py`）。UI 若照常要求填 key，用户只能随手编一个，
 * 于是 config 里留下一个假凭据，日后排查时会误判成「key 填错了」。
 */
export function providerNeedsApiKey(name: string): boolean {
  // auto 由引擎按模型名反查，本页不指定供应商，自然也就没有「这个供应商的 key」
  if (name === AUTO_PROVIDER_VALUE) return false;
  return !BUILTIN_BY_NAME.get(name)?.group.includes('local');
}

/** 按分组顺序展开目录，供下拉菜单渲染（分组顺序 = `MODEL_PROVIDER_GROUP_IDS`） */
export function groupedModelProviders(): {
  group: ModelProviderGroupId;
  items: ModelProviderSpec[];
}[] {
  return MODEL_PROVIDER_GROUP_IDS.filter((g) => g !== 'custom').map((group) => ({
    group,
    items: MODEL_PROVIDERS.filter((p) => p.group === group),
  }));
}
