/**
 * 内置模型目录（云端下发）——**纯逻辑**，不读全局状态、不碰网络。
 *
 * ## 「内置」在这个产品里是什么意思
 *
 * 引擎的模型目录（`/v1/models`）只有一种来源：本机 `config.json` 的 `modelPresets`。
 * 它天然是**这台机器**的事实——换一台机器，清单就是空的。而内置模型要回答的是
 * 「本产品提供哪些模型」，这份清单只能放在云端（见 `cloud/app/catalog/`）。
 *
 * 两条线的关系因此是「**云端定清单，本机保可用**」：
 * 1. 云端下发条目（含 apiBase / apiKey）→ 本机缺失的自动写入引擎配置（`modelsStore`）；
 * 2. 写入之后它们就出现在 `/v1/models` 里，与用户自己加的预设**同域**（都是预设名）。
 *
 * 选择器据此把目录切成两组：`id` 命中云端清单的 → 「内置模型」，其余 → 「自定义模型」。
 * 判据只有 `id`（= 预设名），因为那正是请求里发出去的那个值。
 */

import type { ModelInfo } from '@/types';
import { normalizePricing, type ModelPricing } from './modelPricing';

/**
 * 云端下发的一条内置模型。
 *
 * 字段与 `ModelFormValue` 刻意同形（camelCase、同样的能力声明），因为它的用途就是
 * 被转成一次 `upsert`；形状对不上时转换层会变成一处「漏转一个字段就静默失效」的地方
 * ——例如漏了 `supportsTools`，模型会被写成不支持工具调用，而界面上完全看不出来。
 */
export interface BuiltinModel {
  /** 预设名 = 请求里的 `model` 值 = 选择器里显示的那行 */
  id: string;
  /** 上游真实模型名 */
  model: string;
  /** 供应商 config key（自定义供应商时，预设的 `provider` 就是它） */
  provider: string;
  /** 供应商展示名 */
  providerLabel: string;
  apiBase: string;
  apiKey: string;
  maxTokens: number;
  contextWindowTokens: number;
  temperature: number;
  reasoningEffort: string | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  customProtocol: boolean;
  pricing: ModelPricing | null;
  /** 选择器里的一行说明（空串不渲染） */
  description: string;
  sortOrder: number;
}

const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_CONTEXT_WINDOW = 200_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 把 `GET /api/models/builtin` 的响应解析成条目数组。
 *
 * **缺 `id` 或 `model` 的条目直接丢弃**，而不是补一个默认值：预设名是请求里发出去的
 * 那个键，编不出来——留着一条没有名字的模型，界面上会多出一行永远调用失败的空条目。
 * 其余字段缺一律取窄方向的默认（能力声明默认关闭），因为「声明支持但实际不支持」的
 * 后果是发出去的请求被上游拒掉，而不是少一个勾选框。
 */
export function parseBuiltinModels(raw: unknown): BuiltinModel[] {
  const root = asRecord(raw);
  const list = Array.isArray(root?.models) ? (root?.models as unknown[]) : [];
  const out: BuiltinModel[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const src = asRecord(item);
    if (!src) continue;
    const id = asString(src.id).trim();
    if (!id || seen.has(id)) continue;
    const model = asString(src.model).trim() || id;
    seen.add(id);
    out.push({
      id,
      model,
      provider: asString(src.provider).trim(),
      providerLabel: asString(src.providerLabel).trim(),
      apiBase: asString(src.apiBase).trim(),
      apiKey: asString(src.apiKey),
      maxTokens: asNumber(src.maxTokens, DEFAULT_MAX_TOKENS),
      contextWindowTokens: asNumber(src.contextWindowTokens, DEFAULT_CONTEXT_WINDOW),
      temperature: asNumber(src.temperature, 0.1),
      reasoningEffort: asString(src.reasoningEffort) || null,
      // 能力声明缺省取**窄**方向（与引擎 `ModelPresetConfig` 的字段默认值相反）：
      // 引擎那侧默认 true 是为了兼容老预设，而这里是「云端没表态」——没有声明就
      // 不该承诺支持，否则工具调用会以「模型不支持 function calling」失败在对话中途。
      supportsTools: asBool(src.supportsTools, false),
      supportsVision: asBool(src.supportsVision, false),
      supportsReasoning: asBool(src.supportsReasoning, false),
      customProtocol: asBool(src.customProtocol, false),
      pricing: normalizePricing(src.pricing),
      description: asString(src.description),
      sortOrder: asNumber(src.sortOrder, 0),
    });
  }
  // 顺序由服务端给定，这里只按 sortOrder 兜一次：云端排序字段改了名字 / 没下发时，
  // 顺序也应稳定（不能随 JSON 键序抖动）
  return out.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/** 内置模型的 id 集合（选择器分组的判据） */
export function builtinModelIds(list: readonly { id: string }[]): Set<string> {
  return new Set(list.map((item) => item.id));
}

export interface ModelCatalogGroups {
  /** 云端下发的内置模型（引擎里已就位的那部分） */
  builtin: ModelInfo[];
  /** 用户自己加的模型（含本机独有的、已同步到其他机器的） */
  custom: ModelInfo[];
}

/**
 * 把引擎目录切成「内置 / 自定义」两组。
 *
 * **`default` 一律排除**：它不是模型而是一条解析路径（请求不带 `model` 时引擎自己
 * 落到隐式默认预设），调用方在菜单里单独画成「Auto」那一项。把它混进任一组，
 * 都会让菜单里出现两行指向同一件事的条目。
 *
 * 目录里**没有**内置模型时（未登录 / 云端离线 / 还没播种），`builtin` 为空数组 ——
 * 调用方据此只画「自定义模型」一组，而不是画一个空标题。
 */
export function groupCatalog(
  models: readonly ModelInfo[],
  builtinIds: ReadonlySet<string>,
): ModelCatalogGroups {
  const groups: ModelCatalogGroups = { builtin: [], custom: [] };
  for (const item of models) {
    if (item.id === 'default') continue;
    if (builtinIds.has(item.id)) groups.builtin.push(item);
    else groups.custom.push(item);
  }
  return groups;
}

/**
 * 本机还缺哪些内置模型（= 需要播种的那些）。
 *
 * 判据是**预设名是否已存在**，而不是「值是否与云端一致」：用户可能特意在本机把
 * `agnes-3.0-flash` 的密钥换成了自己的（额度隔离），那种情况必须原样保留 ——
 * 云端是「提供」，不是「覆盖」。
 */
export function missingBuiltinModels(
  builtin: readonly BuiltinModel[],
  localNames: Iterable<string>,
): BuiltinModel[] {
  const have = new Set(localNames);
  return builtin.filter((item) => !have.has(item.id));
}
