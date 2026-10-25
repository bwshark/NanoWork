/**
 * 模型预设的数值档位与引擎默认值。
 *
 * **为什么单独成文件**：这些常量有两个消费者——`modelsStore`（表单值 → 引擎变更指令时
 * 要拿默认值兜底、回读时要把默认值归一掉）与 `ModelDialog`（画档位按钮、把「与引擎默认
 * 值相同」显示成「使用提供商默认值」）。各写一份的下场是「界面写着默认、落盘写的是另一个
 * 数」，而这类错位**不会报错**，只会让模型在某个长度上莫名截断。
 *
 * ⚠️ `ENGINE_DEFAULT_*` 必须与引擎 `nanobot/config/schema.py::ModelPresetConfig` 的字段
 * 默认值逐字一致（`max_tokens: int = 32_768`、`context_window_tokens: int = 200_000`、
 * `temperature: float = 0.1`）。改引擎默认值要回来同步这里，否则「使用提供商默认值」
 * 会写下一个引擎并不认为默认的数字。
 */

/**
 * 引擎 preset 的默认输出上限（tokens）。
 *
 * 2026-09-29 由 8192 提到 32768：8192 不足以承载「一次性写出一整个文件」这类工具调用——
 * 实测一份单文件小游戏的 `write_file` 参数在 25186 字符（≈8k token）处被截断，参数成为
 * 非法 JSON，工具被引擎拒绝执行，且失败被伪装成了「已完成」。提高预算与 `write_file`
 * 的分片写入（`append=true`）是两条独立的兜底。
 */
export const ENGINE_DEFAULT_MAX_TOKENS = 32_768;

/** 引擎 preset 的默认上下文窗口（tokens） */
export const ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * 引擎 preset 的默认采样温度。
 *
 * 表单**不暴露**温度，但这个常量仍然必要：`buildMutation` 必须从原预设把它带过来。
 * 早期实现硬编码 0.1，于是「只改了一下模型名」也会把用户在引擎 WebUI 里调过的
 * 采样温度重置回默认，而这种丢失在界面上完全看不出来。
 */
export const ENGINE_DEFAULT_TEMPERATURE = 0.1;

/**
 * 「思考模式」开启时写入的 reasoning effort。
 *
 * 引擎接受 `low / medium / high / xhigh / max / adaptive / none`（见 schema.py 的
 * `reasoning_effort` 注释），本表单只表达「要不要思考」这一个开关，所以取中间档。
 * 若原预设已有别的档位（用户在引擎 WebUI 里设过 `high`），切换开关时会原样保留。
 */
export const DEFAULT_REASONING_EFFORT = 'medium';

/**
 * 输出上限的快捷档位（16K / 64K / 128K）。
 *
 * ⚠️ **刻意不含 32K**：它就是引擎默认值，做成档位会得到一个「永远无法保持选中」的
 * 按钮——点击后落盘 32768，回读时被 `normalizeTokenLimit` 归一成 `null`，下次打开
 * 显示的是「使用提供商默认值」而不是刚点的 32K。用户会以为自己的选择被吞了。
 * 而它本来也不需要单独存在：想表达 32K 就是「使用提供商默认值」（今日两者同值）。
 * 需要 32K 时手写输入框里敲 `32K` 仍然可用（`parseTokenLimitInput` 不依赖这份表）。
 */
export const MAX_TOKENS_OPTIONS = [16_384, 65_536, 131_072] as const;

/**
 * 上下文窗口的快捷档位（32K / 64K / 128K / 256K）。
 *
 * 与输出档位同一条约束：**任何一项都不许等于 `ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS`**
 * （200_000 不是 1024 的整数倍，天然不在这个列表里）。这条不变量由单测守着。
 */
export const CONTEXT_WINDOW_OPTIONS = [32_768, 65_536, 131_072, 262_144] as const;

/** `null` 的展示文案：不覆盖引擎/供应商的默认取值 */
export const TOKEN_DEFAULT_LABEL = '使用提供商默认值';

/**
 * token 数的展示文案。
 *
 * 1024 的整数倍写成 `128K`（与档位按钮同字，用户一眼能对上自己点的是哪个），
 * 其余原样带千分位：用户在引擎 WebUI 里填过 `200000` 这类值时，除法得到的 195.3
 * 并不是他写下的数，显示成「195K」会让人以为值被改过。
 */
export function formatTokenLimit(value: number | null): string {
  if (value === null) return TOKEN_DEFAULT_LABEL;
  const k = value / 1024;
  if (Number.isInteger(k) && k >= 1) return `${k}K`;
  return value.toLocaleString('en-US');
}

/**
 * 回读归一：与引擎默认值相同的取值一律折成 `null`（＝界面上的「使用提供商默认值」）。
 *
 * 两个方向都靠它对齐：
 * - 写入侧 `null → ENGINE_DEFAULT_*`（`buildMutation` 必须给引擎一个具体数字，
 *   因为 `modelPresets` 是我们整体托管写入的，缺字段会退回 pydantic 默认值——
 *   结果一样，但写进去的是哪个值就看不出来了）；
 * - 读取侧 `ENGINE_DEFAULT_* → null`（否则每个模型一打开都是「200K」，用户看不出
 *   「我没设过」和「我特意设成 200K」的区别，而后者的语义其实就是前者）。
 */
export function normalizeTokenLimit(
  value: unknown,
  engineDefault: number,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value === engineDefault ? null : value;
}

/**
 * 输入框文本 → token 数。
 *
 * 「使用提供商默认值」在控件上由**空串**表达（占位符写着这句话），所以这里的
 * 空串不是"错误"而是"不覆盖"。带单位写法（`128K` / `1M`）与千分位逗号都接受：
 * 档位按钮上印的就是 `128K`，用户照着敲进来却报错，是自找的摩擦。
 *
 * `invalid` 必须与 `value === null` 分开报：输入了 `12x` 而被静默当成"使用默认值"，
 * 等于把用户的意图吞掉——提交闸门要能据此拦下（见 `ModelDialog` 的 `canSave`）。
 */
export function parseTokenLimitInput(raw: string): {
  value: number | null;
  invalid: boolean;
} {
  const text = raw.replace(/[\s,_]/g, '');
  if (!text) return { value: null, invalid: false };
  const match = text.match(/^(\d+)([kKmM])?$/);
  if (!match) return { value: null, invalid: true };
  const scale = match[2] ? (match[2].toLowerCase() === 'k' ? 1024 : 1024 * 1024) : 1;
  const value = Number(match[1]) * scale;
  if (!Number.isFinite(value) || value <= 0) return { value: null, invalid: true };
  return { value, invalid: false };
}

/**
 * 模型能力声明的缺省值，**必须与引擎 `schema.py::ModelPresetConfig` 的字段默认值
 * 逐字一致**（`supports_tools: bool = True` / `supports_vision: bool = False` /
 * `supports_reasoning: bool = True` / `custom_protocol: bool = False`）。
 *
 * 引擎当前不消费前四项（工具定义始终随请求下发），它们是**声明式**字段：
 * 客户端把「用户认定的模型能力」随预设落盘，回读与迁移才有依据。改缺省值要回来
 * 同步这里，否则「界面显示的默认」与「引擎侧缺省」会不一样。
 *
 * ⚠️ **两个方向相反的默认值是有意的**（见 `src/lib/model/modelCapability.ts` 的文件头）：
 * - `supportsTools` / `supportsReasoning` 默认 true → 客户端拿它们做**硬门禁**，
 *   默认宽松才不会一升级就把所有人禁掉；
 * - `supportsVision` 默认 false → 因此视觉能力**只做提醒不做门禁**（否则同样会把
 *   所有历史预设的贴图功能一起禁掉）。
 */
export const ENGINE_DEFAULT_CAPABILITIES = {
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: true,
  customProtocol: false,
} as const;
