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
  /**
   * 官方文档地址（「供应商」标签行右侧那个「查看文档」入口）。
   *
   * **只填能确认的**：链接点出去是打不开的页面，比没有这个入口更糟（用户会以为
   * 是本产品的 bug）。没有这一项就不渲染那个入口。
   */
  docsUrl?: string;
  /**
   * 该供应商的**常用模型**清单，作为「模型名称」下拉的起点。
   *
   * ⚠️ 这是**起点不是全集**：上游发版很快，这份清单注定会过时，所以
   * ①「模型名称」允许自由输入；②「测试连接」拿到的真实清单**优先展示在它前面**
   * （见 `providerModelOptions` 的 `extra` 参数）。维护原则是「宁短勿错」——
   * 列一个已经下线的模型名，用户会照着它配出一个必定 404 的预设。
   */
  models?: readonly string[];
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
 *
 * `docsUrl` / `models` 都只填查得准的（见 `ModelProviderSpec` 上的注释）；
 * 留空的供应商在界面上表现为「没有查看文档入口 + 模型候选靠测试连接拿」。
 */
export const MODEL_PROVIDERS: ModelProviderSpec[] = [
  // —— 官方直连 ——
  { name: 'openai', label: 'OpenAI', group: 'official', apiBase: 'https://api.openai.com/v1', probe: true, docsUrl: 'https://platform.openai.com/docs', models: ['gpt-5.6', 'gpt-5.2', 'gpt-5.1', 'gpt-5-mini', 'gpt-4o'] },
  { name: 'anthropic', label: 'Anthropic', group: 'official', apiBase: '', probe: false, docsUrl: 'https://docs.anthropic.com', models: ['claude-opus-4-5', 'claude-sonnet-4-5'] },
  { name: 'gemini', label: 'Google Gemini', group: 'official', apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai/', probe: true, docsUrl: 'https://ai.google.dev/gemini-api/docs', models: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-2.5-pro'] },
  { name: 'deepseek', label: 'DeepSeek 深度求索', group: 'official', apiBase: 'https://api.deepseek.com', probe: true, docsUrl: 'https://api-docs.deepseek.com', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] },
  { name: 'dashscope', label: '阿里云 DashScope（通义）', group: 'official', apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', probe: true, models: ['qwen3.8-flash', 'qwen3.6-flash', 'qwen3.6-max-preview'] },
  { name: 'zhipu', label: '智谱 AI', group: 'official', apiBase: 'https://open.bigmodel.cn/api/paas/v4', probe: true, models: ['glm-5.2', 'glm-5.1', 'glm-5-turbo'] },
  { name: 'moonshot', label: 'Moonshot（Kimi）', group: 'official', apiBase: 'https://api.moonshot.ai/v1', probe: true, docsUrl: 'https://platform.moonshot.cn/docs', models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'] },
  { name: 'minimax', label: 'MiniMax', group: 'official', apiBase: 'https://api.minimax.io/v1', probe: true },
  { name: 'mistral', label: 'Mistral AI', group: 'official', apiBase: 'https://api.mistral.ai/v1', probe: true, docsUrl: 'https://docs.mistral.ai' },
  { name: 'stepfun', label: '阶跃星辰 StepFun', group: 'official', apiBase: 'https://api.stepfun.com/v1', probe: true },
  { name: 'xiaomi_mimo', label: '小米 MIMO', group: 'official', apiBase: 'https://api.xiaomimimo.com/v1', probe: true, models: ['mimo-v2.5-pro', 'mimo-v2.5'] },
  { name: 'longcat', label: 'LongCat', group: 'official', apiBase: 'https://api.longcat.chat/openai/v1', probe: true },
  { name: 'ant_ling', label: 'Ant Ling', group: 'official', apiBase: 'https://api.ant-ling.com/v1', probe: true },
  { name: 'qianfan', label: '百度千帆', group: 'official', apiBase: 'https://qianfan.baidubce.com/v2', probe: true },
  { name: 'nvidia', label: 'NVIDIA NIM', group: 'official', apiBase: 'https://integrate.api.nvidia.com/v1', probe: true },
  { name: 'groq', label: 'Groq', group: 'official', apiBase: 'https://api.groq.com/openai/v1', probe: true, docsUrl: 'https://console.groq.com/docs' },
  { name: 'kimi_coding', label: 'Kimi Coding Plan', group: 'official', apiBase: 'https://api.kimi.com/coding/v1', probe: false, docsUrl: 'https://platform.moonshot.cn/docs', models: ['kimi-for-coding'] },

  // —— 聚合网关 ——
  { name: 'openrouter', label: 'OpenRouter', group: 'gateway', apiBase: 'https://openrouter.ai/api/v1', probe: true, docsUrl: 'https://openrouter.ai/docs', models: ['deepseek/deepseek-v4-pro', 'z-ai/glm-5.2', 'moonshotai/kimi-k2.6', 'qwen/qwen3.6-max-preview'] },
  { name: 'siliconflow', label: '硅基流动 SiliconFlow', group: 'gateway', apiBase: 'https://api.siliconflow.cn/v1', probe: true, docsUrl: 'https://docs.siliconflow.com', models: ['deepseek-ai/DeepSeek-V4-Pro', 'deepseek-ai/DeepSeek-V4-Flash'] },
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
  { name: 'ollama', label: 'Ollama', group: 'local', apiBase: 'http://localhost:11434/v1', probe: true, docsUrl: 'https://docs.ollama.com', models: ['gpt-oss:20b', 'qwen3:8b', 'qwen3-vl:8b', 'llama3.2'] },
  { name: 'lm_studio', label: 'LM Studio', group: 'local', apiBase: 'http://localhost:1234/v1', probe: true, docsUrl: 'https://lmstudio.ai/docs' },
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
 * 「供应商」下拉的显示文案，**回显与菜单项共用这一份口径**。
 *
 * 与 `modelProviderLabel` 分开的原因只有一个：自定义供应商的哨兵值
 * （`__custom__`）在目录里查不到，`modelProviderLabel` 会把它**原样**吐出来
 * ——早期没有 `renderValue` 时看不出来（框里渲染的是那个 MenuItem 的文案），
 * 一旦加了字标回显，框里就会显示成 `__custom__ 自定义` 这种双份文案。
 */
export function providerOptionLabel(value: string): string {
  if (value === CUSTOM_PROVIDER_VALUE) return '自定义';
  return modelProviderLabel(value);
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

/**
 * 供应商的「查看文档」地址；目录里没登记（或没登记文档）时返回 `null`。
 *
 * 返回 `null` 时界面**不渲染**那个入口：链接指向一个不存在的页面，用户只会
 * 记成本产品的 bug，比没有入口更糟。
 */
export function providerDocsUrl(provider: string): string | null {
  return findModelProvider(provider)?.docsUrl ?? null;
}

/**
 * 「模型名称」下拉的候选清单。
 *
 * 顺序刻意是 **探测到的真实清单在前、内置常用清单在后**：前者来自这个端点此刻
 * 真的提供了什么（`GET {apiBase}/models`），后者是一份注定会过时的起点。反过来
 * 排的话，用户会先看到一批可能已经下线的名字。
 *
 * @param provider 目录里的供应商名（`auto` / 自定义供应商都查不到 → 只剩 `extra`）
 * @param extra 探测结果，或编辑模式下当前预设的模型名（保证它一定在候选里）
 */
export function providerModelOptions(
  provider: string,
  extra: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string) => {
    const name = value.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  extra.forEach(push);
  // ⚠️ 不要用 `models.flatMap(push)`：`push` 会收到 (值, 下标, 数组) 三个参数，
  // 下标会被当作…… 更糟的是 flatMap 会把 push 的返回值（undefined）收集起来。
  for (const spec of MODEL_PROVIDERS) {
    if (spec.name !== provider) continue;
    (spec.models ?? []).forEach(push);
  }
  return out;
}

/**
 * 供应商图标的字标（参考图里那个「K」形态）。
 *
 * 取展示名的**第一个字母或数字**，而不是画各家 logo：目录里 30 多家供应商，
 * 逐个维护一套品牌图标既不可能保真、也活不过一次换主题；字标则是从数据本身
 * 推出来的，永远不会与标签不一致。CJK 标签取第一个汉字（如「阿」）。
 */
export function providerMonogram(label: string): string {
  const match = label.trim().match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : '?';
}
