/**
 * 模型单价与成本核算（FR-11.1 的「金额」那一半）——**纯逻辑**。
 *
 * ## 为什么要有缓存单价（而不是只做输入 / 输出两档）
 *
 * 引擎的用量表里 `input_tokens` 是**逻辑输入总量，已经包含缓存读取**
 * （`nanobot/providers/base.py:300` 的原话：*"``input_tokens`` is the logical input
 * total and therefore includes cache reads"*；Anthropic 侧的写入处把
 * `input + cache_write + cache_read` 加在一起）。
 *
 * 于是「输入 token × 输入单价」在长会话里会**严重高估**：缓存命中的那部分通常只按
 * 输入价的 ~10% 计费，而它往往占输入的绝大部分（本机实测 WorkBuddy 的一份 trace：
 * 输入 1060 万，其中缓存 1048 万，命中率 98.8%）。两档计价在多轮对话里给出的数字
 * 可能差一个数量级——那不是「粗略」，是错的。
 *
 * 所以给三档：输入（未命中）/ 缓存读取 / 输出。**缓存读取单价可以留空**，留空即按
 * 输入单价计（＝明确的保守上界）；界面把这条规则写出来，而不是悄悄替用户假定一个折扣
 * ——「编一个折扣率出来的数字比没有数字更糟」。
 *
 * ## 不做汇率换算
 *
 * 单价由用户填，货币由用户选（CNY / USD）。汇总时**按币种分组**，绝不把两个币种的
 * 数字加到一起：那需要一个汇率来源，而本项目没有。通常只有一种货币，于是界面上就是
 * 一个数字；真出现两种，就显示两行——如实比好看重要。
 *
 * ## 归因到哪一条预设（已知的模糊处）
 *
 * 用量表只有 `(provider, model)` 两列，**没有 preset 列**（同 §20.2 修订二「没有
 * session / agent 列」的成因）。而同一个上游模型可以被多个预设引用、各自单价可以不同
 * （例如同一个 `qwen3.8-flash` 配了两个 key、两个价）。此时按下面的顺序取第一条：
 * ① `provider` 与 `model` 都相等；② 只 `model` 相等（预设名升序取第一）。
 * 这条**不承诺精确归因**，界面在提示里也如实说明。
 */

/** 计价货币。取值域与引擎 `ModelPricing.currency` 的 `Literal` 一致 */
export type PricingCurrency = 'CNY' | 'USD';

export const PRICING_CURRENCIES = ['CNY', 'USD'] as const;

/** 货币符号（只用于展示，不做任何换算） */
export const CURRENCY_SYMBOL: Record<PricingCurrency, string> = {
  CNY: '¥',
  USD: '$',
};

export function isPricingCurrency(value: unknown): value is PricingCurrency {
  return typeof value === 'string' && (PRICING_CURRENCIES as readonly string[]).includes(value);
}

/**
 * 一个模型的单价。
 *
 * 单位统一是「每百万 token」——供应商报价几乎都按这个量级，而按 token 报价
 * （`0.000002`）会让输入框里全是零，肉眼分不出少打一位。
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** 缓存读取单价；`null` = 未填 = 按输入单价计（保守上界，界面上明说） */
  cacheReadPerMillion: number | null;
  currency: PricingCurrency;
}

/**
 * 把任意来源的值收敛成合法单价；**算不出金额时返回 `null`**。
 *
 * 返回 `null` 的判据是「两档主单价都是 0 或非法」——一个全零的单价没有任何意义，
 * 让它留在数据里会让「已配置单价」的判据变成真，于是界面显示 `¥0.00` 而不是
 * 「暂不统计」，用户会以为自己的模型不花钱。
 */
export function normalizePricing(raw: unknown): ModelPricing | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const src = raw as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  const input = num(src.inputPerMillion);
  const output = num(src.outputPerMillion);
  const cache = src.cacheReadPerMillion;
  const cacheRead = typeof cache === 'number' && Number.isFinite(cache) && cache >= 0 ? cache : null;
  if (input === 0 && output === 0) return null;
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: cacheRead,
    currency: isPricingCurrency(src.currency) ? src.currency : 'CNY',
  };
}

/** 是否真的能用它算金额（`null` 与全零都已经在 normalize 里折成 `null`） */
export function pricingIsUsable(pricing: ModelPricing | null | undefined): pricing is ModelPricing {
  return !!pricing && (pricing.inputPerMillion > 0 || pricing.outputPerMillion > 0);
}

/** 解析单价所需的最小结构（刻意不依赖 `ManagedModel` 整个类型） */
export interface PricingSource {
  /** 预设名 */
  name: string;
  /** 上游真实模型名 */
  model: string;
  /** 预设的 provider（内置为注册表名，自定义为 config key） */
  provider: string;
  pricing: ModelPricing | null;
}

/** 成本核算需要的最小计量（`UsageCounters` 的子集，便于测试与复用） */
export interface BillableCounters {
  inputTokens: number;
  outputTokens: number;
  /** 其中缓存命中的部分；引擎保证 ≤ `inputTokens`（这里再夹一次，防手改过的库） */
  cacheReadTokens: number;
}

/**
 * 按 `(provider, model)` 找单价。
 *
 * 匹配顺序见文件头「归因到哪一条预设」；找不到返回 `null`（＝该模型不参与金额合计，
 * 而不是按 0 计）。
 */
export function resolvePricingFor(
  sources: readonly PricingSource[],
  provider: string,
  model: string,
): ModelPricing | null {
  const usable = sources.filter((s) => pricingIsUsable(s.pricing));
  const exact = usable.find((s) => s.model === model && s.provider === provider);
  if (exact) return exact.pricing;
  const byModel = [...usable]
    .filter((s) => s.model === model)
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  return byModel?.pricing ?? null;
}

/** 单次计量的成本（与 `pricing.currency` 同币种） */
export function computeCost(counters: BillableCounters, pricing: ModelPricing): number {
  const input = Math.max(0, counters.inputTokens);
  const output = Math.max(0, counters.outputTokens);
  // 夹住：引擎的契约是 cache ≤ input（`base.py` 里有断言），但库能被手改
  const cached = Math.min(Math.max(0, counters.cacheReadTokens), input);
  const uncachedInput = input - cached;
  const cachePrice = pricing.cacheReadPerMillion ?? pricing.inputPerMillion;
  return (
    (uncachedInput / 1_000_000) * pricing.inputPerMillion +
    (cached / 1_000_000) * cachePrice +
    (output / 1_000_000) * pricing.outputPerMillion
  );
}

/** 按币种分组的小计（一个币种一项，绝不相加） */
export interface CurrencyTotal {
  currency: PricingCurrency;
  amount: number;
  /** 参与合计的模型数（用于说明「有几个模型配了单价」） */
  models: number;
}

/**
 * 把「每个模型一项」的小计折成按币种分组的合计，金额降序。
 *
 * `models` 计的是**有单价的模型数**，不是调用次数：它回答的是「这个数字覆盖了
 * 几个模型」，而这正是判断「合计是否可信」的依据（`UsageProviderRow` 里没配单价的
 * 那些模型不参与合计，界面要能说出「还有几个没配」）。
 */
export function sumByCurrency(
  items: ReadonlyArray<{ cost: number; currency: PricingCurrency }>,
): CurrencyTotal[] {
  const acc = new Map<PricingCurrency, CurrencyTotal>();
  for (const item of items) {
    if (!Number.isFinite(item.cost)) continue;
    const prev = acc.get(item.currency);
    acc.set(item.currency, {
      currency: item.currency,
      amount: (prev?.amount ?? 0) + item.cost,
      models: (prev?.models ?? 0) + 1,
    });
  }
  return [...acc.values()].sort(
    // 金额相同时按币种名定序：`Map` 的插入序取决于 `days`/`providers` 的返回顺序，
    // 直接渲染会随引擎返回顺序抖动，而图表与图例都要求稳定顺序。
    (a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency),
  );
}

/**
 * 金额文案。
 *
 * 小额（< 1）保留 4 位小数：这个量级上 `0.0031` 与 `0.0031` 的差别用户是要看的，
 * 四舍五入到两位会全变成 `¥0.00`，看起来像没算。大额两位足够。
 */
export function formatCost(amount: number, currency: PricingCurrency): string {
  const symbol = CURRENCY_SYMBOL[currency];
  const n = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  if (n >= 1) return `${symbol}${n.toFixed(2)}`;
  if (n === 0) return `${symbol}0`;
  return `${symbol}${n.toFixed(4)}`;
}

/** 单价展示（每百万 token）；`null` 显示成「按输入单价计」而不是空白 */
export function formatUnitPrice(pricing: ModelPricing): string {
  const symbol = CURRENCY_SYMBOL[pricing.currency];
  const cache =
    pricing.cacheReadPerMillion === null
      ? `${symbol}${pricing.inputPerMillion}（缓存按输入价）`
      : `${symbol}${pricing.cacheReadPerMillion}`;
  return `输入 ${symbol}${pricing.inputPerMillion} · 缓存 ${cache} · 输出 ${symbol}${pricing.outputPerMillion}`;
}

export interface PriceParseResult {
  /** 解析出的数值；空串 → `null`（= 未填，与填 0 不是同一件事） */
  value: number | null;
  /** 输入无法解析（界面据此拦住保存，而不是静默当成 0） */
  invalid: boolean;
}

/**
 * 解析单价输入框。
 *
 * 与 `parseTokenLimitInput` 同款分工：**原始文本留在组件里**，解析在提交前做。
 * 存成 `number | null` 就没法表达「用户正在敲 `2.`，还没敲完」——那种中间态会被
 * 当成非法而让保存按钮闪红。
 *
 * 空串是**合法**的（= 不配这一档）；`0` 也是合法的（= 这一档不单独计价）。
 * 两者在 `normalizePricing` 里语义不同：空 → `null`（按输入价 / 不参与），
 * `0` → 字面的 0。若三档全是 0，`normalizePricing` 会折成 `null`——
 * 「全零的单价」等于没配，界面据此说「暂不统计」而不是显示 `¥0`。
 */
export function parsePriceInput(raw: string): PriceParseResult {
  // 允许千分位逗号与首尾空白：用户常从账单页复制数字，那里带分隔符
  const text = raw.trim().replace(/[,，\s]/g, '');
  if (text === '') return { value: null, invalid: false };
  // 接受 `2` / `2.5` / `2.`（正在敲）/ `.5`
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return { value: null, invalid: true };
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return { value: null, invalid: true };
  return { value: n, invalid: false };
}
