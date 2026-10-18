/**
 * `agents.defaults` 里「隐式默认模型」那组字段与 `modelPresets` 指针的同步。
 *
 * **为什么需要它**：同一份配置里有两条互不相干的解析路径——
 *
 * 1. 有 `modelPreset` 时走**预设**（`Config.resolve_preset()`）；
 * 2. 没有指针时走**隐式默认**（`Config.resolve_default_preset()`，读 `agents.defaults`
 *    里的 `model` / `provider` / `maxTokens` …）。
 *
 * 「设为默认」只写指针，于是 (2) 那组字段就永久停在**上一个默认**上。平时看不出来
 * （指针优先），一旦指针被清空就立刻现形：删掉当前默认预设时 `modelPreset = null`，
 * 引擎静默回落到那条陈旧裸串——用户看到的是「删了一个模型，助手换成了另一个毫不相干
 * 的模型」，且没有任何报错能解释。
 *
 * 这里把不变量收紧成一条：**指针指向的预设存在 ⇒ defaults 字段与它一致**。
 * 于是「指针被清空」的瞬间，(2) 指向的是最后已知的那个模型，而不是历史遗留。
 *
 * 抽成独立模块是为了**能单测**：这段代码错了完全安静（键名写错也只是多一种风格，
 * 值不同步则要等到某次删除才炸）。本模块不 import electron，可直接在 vitest 里跑。
 */

/**
 * 引擎 `resolve_default_preset()` 读的字段（`config/schema.py`）。
 *
 * ⚠️ 只同步这 6 个。`supportsTools` / `supportsVision` / `pricing` 这些是**预设专属**
 * 元数据，`agents.defaults` 没有对应字段——多写进去会被引擎的 `extra="ignore"`
 * 静默丢弃，看着「写了」其实没用（那是本仓踩过的坑）。
 */
export const DEFAULT_MODEL_FIELDS = [
  'model',
  'provider',
  'maxTokens',
  'contextWindowTokens',
  'temperature',
  'reasoningEffort',
] as const;

type Dict = Record<string, unknown>;

function asObject(value: unknown): Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : {};
}

/**
 * 把预设展开进 `agents.defaults`（就地修改），返回是否真的有字段变化。
 *
 * **缺失的键不写**：预设没声明 `temperature` 时不能把 defaults 里用户手工调的
 * 值抹成 undefined —— 「预设没表态」与「预设要求无温度」是两件事。
 */
export function expandPresetIntoDefaults(defaults: Dict, preset: unknown): boolean {
  const source = asObject(preset);
  let changed = false;
  for (const field of DEFAULT_MODEL_FIELDS) {
    // 只认「预设真的表了态」的情况：`undefined` 与「没声明」等价（JSON 里也存不下
    // undefined），跳过它才能保住 defaults 里用户手调过的值。注意别用 `field in source`
    // 做前置判据——它与这一行等价，多一道只会让「哪行真正决定行为」变得难查。
    const next = source[field];
    if (next === undefined) continue;
    if (defaults[field] !== next) {
      defaults[field] = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * 指针有效 ⇒ 把该预设展开进 defaults；指针为空 / 悬空 ⇒ 什么都不做。
 *
 * 「悬空不动」是刻意的：此时 defaults 里的旧值仍是**唯一**可用信息，
 * 清掉它等于把「模型」这一项变成空字符串，引擎侧会一路惊到 provider。
 *
 * @returns 是否发生同步
 */
export function syncDefaultsToPointer(defaults: Dict, presets: Dict): boolean {
  const pointer = defaults.modelPreset;
  if (typeof pointer !== 'string' || pointer === '') return false;
  const preset = presets[pointer];
  // 悬空指针：显式 early-return 是为了表意（`asObject` 对 undefined 也会 no-op，
  // 所以这一行删掉行为不变——别把它当成被测判据）。
  if (preset === undefined) return false;
  return expandPresetIntoDefaults(defaults, preset);
}

/**
 * 删除当前默认预设后，挑一个顶上的预设名；没有剩余预设则返回 null。
 *
 * 顺序取 `Object.keys` 的原序（即配置文件里的书写顺序）而不是按名字排序：
 * 用户眼里的「第一个」就是文件里第一个，排序会让顶上的模型莫名其妙。
 */
export function pickFallbackDefaultPreset(presets: Dict, excluded: string): string | null {
  for (const name of Object.keys(presets)) {
    if (name !== excluded) return name;
  }
  return null;
}