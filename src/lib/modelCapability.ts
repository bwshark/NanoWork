/**
 * 模型能力协商（FR-9.3）——**纯逻辑**。
 *
 * ## 这一层解决什么
 *
 * 模型元数据里已经声明了能力（引擎 `modelPresets.*.supports_tools` /
 * `supports_vision` / `supports_reasoning`，见 `nanobot/config/schema.py`），但
 * **声明不等于门控**：声明只是随预设落盘的一串布尔值，谁也不读它。本模块把它变成
 * UI 能用的判据——「当前这个会话用哪个模型、那个模型能做什么」。
 *
 * ## 最要紧的一条：**查不到 ≠ 不支持**
 *
 * 三类情况会让「当前模型」查不到元数据：
 * 1. Web 端（`nanobotGetModels` 回读不到 config.json，`managed` 恒为空）；
 * 2. 引擎离线 / 配置损坏（`managedAvailable=false`）；
 * 3. 用户手填了一个不在预设表里的模型名（`/v1/models` 里有、`modelPresets` 里没有）。
 *
 * 这三种都返回**宽松**的能力集（全 true），而不是保守的 false。理由是不对称：
 * 把「查不到」读成 false，会让每一个升级上来的用户在元数据到达之前**丢掉**技能挂载、
 * 工具审批这些本来能用的功能，而且完全没有报错——查都没法查；读成 true 最多是
 * 该降级时没降级（用户看到工具调用失败，至少现象是可见的）。
 *
 * 同一立场在 `src/lib/modelOptions.ts::ENGINE_DEFAULT_CAPABILITIES` 里已经写过一次
 * （「旧预设里没有这个键不代表不支持工具调用」），这里是把那条规则延伸到「整体查不到」。
 *
 * ## 为什么 `vision` 只做提示、不做门禁
 *
 * 引擎的 `supports_vision` 默认值是 **false**（`supports_tools` / `supports_reasoning`
 * 都是 true）。也就是说：所有没显式勾过「图片输入」的历史预设都会落到 false。若把它
 * 当作硬门禁（禁止添加图片附件），等于**一升级就把所有人都给禁了**——而他们此前一直
 * 能贴图，也一直用得通。所以视觉能力只用来**提醒**（「当前模型未声明图片输入能力」），
 * 判断权留给人。
 *
 * 反过来，`toolCall` / `reasoning` 的默认是 true，硬门禁只会命中「用户显式取消勾选」
 * 的预设——那正是他表达意图的地方，此时禁用才是听话而不是添乱。
 */

/** 单个模型的三项能力（取值口径与引擎字段一一对应） */
export interface ModelCapabilities {
  /** `supports_tools`：该模型支持 function calling */
  toolCall: boolean;
  /** `supports_vision`：该模型接受图片输入 */
  vision: boolean;
  /** `supports_reasoning`：该模型有思考模式 */
  reasoning: boolean;
}

/**
 * 查不到元数据时的取值：**全部宽松**。
 *
 * 导出成常量而不是每次现造：它是本模块最容易被「顺手改成 false」的地方，
 * 具名之后改动会在 review 里显形。
 */
export const PERMISSIVE_CAPABILITIES: ModelCapabilities = {
  toolCall: true,
  vision: true,
  reasoning: true,
};

/** 解析所需的最小结构——刻意不依赖 `ManagedModel` 整个类型，便于测试与复用 */
export interface CapabilitySource {
  /** 预设名（= 请求里发出的 `model` 值） */
  name: string;
  /** 是否为引擎的默认预设（`agents.defaults.modelPreset`） */
  isDefault: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
}

/** 能力来自哪里——UI 用它决定要不要说「已按未声明处理」 */
export type CapabilityOrigin = 'preset' | 'default-preset' | 'unknown';

export interface ResolvedCapabilities {
  capabilities: ModelCapabilities;
  origin: CapabilityOrigin;
  /** 命中的预设名；`unknown` 时为 null */
  presetName: string | null;
}

/**
 * 解析「当前会话生效的模型」的能力。
 *
 * @param sources 预设表（`useModelsStore.managed`）；空数组 = 读不到
 * @param modelId 会话/任务所选模型 id（**预设名**）；`undefined` / `''` 表示 Auto
 *
 * Auto 的语义（见 `describeModelId` 的注释）：请求里不带 `model` 字段，实际生效的是
 * 引擎的 `agents.defaults.modelPreset`，所以 Auto 要解析到 `isDefault` 的那一条——
 * 而不是「找不到就宽松」。这条区分很要紧：默认预设恰恰是**最可能被显式取消勾选**的
 * 那个（用户为它配了本地小模型），漏掉就等于门控形同虚设。
 */
export function resolveModelCapabilities(
  sources: readonly CapabilitySource[],
  modelId?: string | null,
): ResolvedCapabilities {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  const hit = id
    ? sources.find((s) => s.name === id)
    : sources.find((s) => s.isDefault);

  if (!hit) {
    return { capabilities: { ...PERMISSIVE_CAPABILITIES }, origin: 'unknown', presetName: null };
  }
  return {
    capabilities: {
      toolCall: hit.supportsTools,
      vision: hit.supportsVision,
      reasoning: hit.supportsReasoning,
    },
    origin: id ? 'preset' : 'default-preset',
    presetName: hit.name,
  };
}

/**
 * 「已降级为纯对话」的提示文案；不该提示时返回 `null`。
 *
 * 文案要说清**两件事**，缺一件用户就会以为功能坏了：现在不能做什么、以及
 * 这是谁的决定。「当前模型不支持工具调用」只答了后半句的一半；补上「该模型的能力声明」
 * 才让人知道去哪儿改（设置 → 模型 → 高级配置 → 工具调用）。
 */
export function degradedNotice(caps: ModelCapabilities): string | null {
  if (caps.toolCall) return null;
  return '当前模型未声明工具调用能力，已降级为纯对话：技能挂载与工具审批不生效。要恢复请在「设置 → 模型」里为该模型勾上「工具调用」。';
}

/**
 * 短版降级原因（菜单行里的说明文字）；能调工具时返回 `null`。
 *
 * 与 `degradedNotice` 分开的理由是**长度由容器决定**：菜单行只有一行的位置，
 * 塞整段话会把菜单撑变形；而弹层里有整块地方，该说清「去哪儿改」。
 * 两个长度各写一份文案会漂移，所以短版从长版里派生出口径（同一句话的前半截），
 * 且都从这一处导出——调用方不许自己拼。
 */
export function shortDegradedReason(caps: ModelCapabilities): string | null {
  if (caps.toolCall) return null;
  return '当前模型不支持工具调用';
}

/**
 * 图片附件的提醒文案；不需要提醒时返回 `null`。
 *
 * 刻意只提醒不阻止：`supports_vision` 的引擎默认值是 false，硬门禁会把所有历史预设
 * 一并禁掉（见文件头）。
 */
export function visionNotice(caps: ModelCapabilities): string | null {
  if (caps.vision) return null;
  return '当前模型未声明图片输入能力，图片附件可能无法被识别。若它其实支持，请在「设置 → 模型」里为该模型勾上「图片输入」。';
}
