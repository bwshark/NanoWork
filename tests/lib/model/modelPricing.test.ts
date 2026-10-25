import { describe, expect, it } from 'vitest';
import {
  computeCost,
  formatCost,
  formatUnitPrice,
  normalizePricing,
  parsePriceInput,
  pricingIsUsable,
  resolvePricingFor,
  sumByCurrency,
  type ModelPricing,
  type PricingSource,
} from '@/lib/model/modelPricing';

function price(over: Partial<ModelPricing> = {}): ModelPricing {
  return {
    inputPerMillion: 1,
    outputPerMillion: 2,
    cacheReadPerMillion: null,
    currency: 'CNY',
    ...over,
  };
}

describe('normalizePricing', () => {
  it('两档主单价全零或缺失 → null（不是「零成本的模型」）', () => {
    // 全零留在数据里会让「已配置单价」为真，界面显示 ¥0.00 而不是「暂不统计」，
    // 用户会以为自己的模型不花钱。
    expect(normalizePricing(null)).toBeNull();
    expect(normalizePricing(undefined)).toBeNull();
    expect(normalizePricing({})).toBeNull();
    expect(normalizePricing({ inputPerMillion: 0, outputPerMillion: 0 })).toBeNull();
    expect(normalizePricing({ inputPerMillion: 'x', outputPerMillion: null })).toBeNull();
  });

  it('负数 / NaN / 非法类型一律折算成 0，不原样带进来', () => {
    expect(normalizePricing({ inputPerMillion: -5, outputPerMillion: 3 })).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 3,
      cacheReadPerMillion: null,
      currency: 'CNY',
    });
    expect(normalizePricing({ inputPerMillion: Number.NaN, outputPerMillion: 1 })?.inputPerMillion).toBe(0);
  });

  it('币种非法或缺失一律落 CNY（不猜、也不留空串）', () => {
    expect(normalizePricing({ inputPerMillion: 1 })?.currency).toBe('CNY');
    expect(normalizePricing({ inputPerMillion: 1, currency: 'JPY' })?.currency).toBe('CNY');
    expect(normalizePricing({ inputPerMillion: 1, currency: 'USD' })?.currency).toBe('USD');
  });

  it('缓存单价缺失 / 非法 → null（＝按输入单价计），而不是 0', () => {
    // 折成 0 会把缓存当成免费，那是另一个方向的错
    expect(normalizePricing({ inputPerMillion: 1, cacheReadPerMillion: null })?.cacheReadPerMillion).toBeNull();
    expect(normalizePricing({ inputPerMillion: 1, cacheReadPerMillion: -1 })?.cacheReadPerMillion).toBeNull();
    expect(normalizePricing({ inputPerMillion: 1, cacheReadPerMillion: 0.1 })?.cacheReadPerMillion).toBe(0.1);
  });

  it('pricingIsUsable 与 normalize 的判据同源', () => {
    expect(pricingIsUsable(price())).toBe(true);
    expect(pricingIsUsable(null)).toBe(false);
    expect(pricingIsUsable(undefined)).toBe(false);
  });
});

describe('resolvePricingFor', () => {
  const sources: PricingSource[] = [
    { name: 'a-first', model: 'qwen3.8-flash', provider: 'dashscope', pricing: price({ inputPerMillion: 1 }) },
    { name: 'b-same-model', model: 'qwen3.8-flash', provider: 'other', pricing: price({ inputPerMillion: 9 }) },
    { name: 'c-no-price', model: 'gpt-4o', provider: 'openai', pricing: null },
  ];

  it('provider + model 都相等优先（对得最准的那条）', () => {
    expect(resolvePricingFor(sources, 'other', 'qwen3.8-flash')?.inputPerMillion).toBe(9);
    expect(resolvePricingFor(sources, 'dashscope', 'qwen3.8-flash')?.inputPerMillion).toBe(1);
  });

  it('只对得上 model 时取预设名升序第一条（不承诺精确归因，但结果稳定）', () => {
    expect(resolvePricingFor(sources, 'unknown-provider', 'qwen3.8-flash')?.inputPerMillion).toBe(1);
  });

  it('没配单价的模型返回 null ——「找不到」与「按 0 计」必须分开', () => {
    expect(resolvePricingFor(sources, 'openai', 'gpt-4o')).toBeNull();
    expect(resolvePricingFor(sources, 'x', 'never-heard')).toBeNull();
    expect(resolvePricingFor([], 'x', 'y')).toBeNull();
  });
});

describe('computeCost', () => {
  it('三档分别计价：未命中输入 / 缓存读取 / 输出', () => {
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 800_000 },
      price({ inputPerMillion: 10, outputPerMillion: 20, cacheReadPerMillion: 1 }),
    );
    // (1_000_000-800_000)/1e6*10 = 2 ; 800_000/1e6*1 = 0.8 ; 500_000/1e6*20 = 10
    expect(cost).toBeCloseTo(12.8, 6);
  });

  it('⭐⭐ 缓存单价留空 = 按输入单价计（保守上界），不是 0', () => {
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000 },
      price({ inputPerMillion: 10, cacheReadPerMillion: null }),
    );
    // 全部按输入价：10。若把缓存当免费会算出 1 —— 差一个数量级，
    // 而本机实测缓存命中占输入的 98%，所以这条不是边角情况。
    expect(cost).toBeCloseTo(10, 6);
  });

  it('缓存读取被夹在 input 之内（库可被手改，越界不该算出负数）', () => {
    const cost = computeCost(
      { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 999_999_999 },
      price({ inputPerMillion: 10, outputPerMillion: 0, cacheReadPerMillion: 1 }),
    );
    // 未命中部分被夹成 0，缓存部分按实际 input 计：100_000/1e6*1 = 0.1
    expect(cost).toBeCloseTo(0.1, 6);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it('负数计量按 0 处理', () => {
    expect(
      computeCost({ inputTokens: -1, outputTokens: -1, cacheReadTokens: -1 }, price()),
    ).toBe(0);
  });
});

describe('sumByCurrency', () => {
  it('按币种分组，绝不相加（没有汇率来源）', () => {
    const totals = sumByCurrency([
      { cost: 1, currency: 'CNY' },
      { cost: 2, currency: 'CNY' },
      { cost: 3, currency: 'USD' },
    ]);
    // 金额相同时按币种名定序（见实现里的注释）：`Map` 的插入序取决于引擎返回顺序，
    // 直接渲染会随返回顺序抖动
    expect(totals).toEqual([
      { currency: 'CNY', amount: 3, models: 2 },
      { currency: 'USD', amount: 3, models: 1 },
    ]);
    // 两个币种的金额都在，且**没有**被加成 6
    expect(totals.map((t) => t.amount)).toEqual([3, 3]);
  });

  it('非有限值跳过（NaN 混进来会让整组合计变成 NaN）', () => {
    expect(sumByCurrency([{ cost: Number.NaN, currency: 'CNY' }, { cost: 5, currency: 'CNY' }])).toEqual([
      { currency: 'CNY', amount: 5, models: 1 },
    ]);
  });

  it('空输入返回空数组（调用方据此显示「暂不统计」）', () => {
    expect(sumByCurrency([])).toEqual([]);
  });
});

describe('parsePriceInput', () => {
  it('空串合法（= 不配这一档），不是非法', () => {
    expect(parsePriceInput('')).toEqual({ value: null, invalid: false });
    expect(parsePriceInput('   ')).toEqual({ value: null, invalid: false });
  });

  it('接受小数与「正在敲」的中间态（`2.` 不该让保存按钮闪红）', () => {
    expect(parsePriceInput('2')).toEqual({ value: 2, invalid: false });
    expect(parsePriceInput('2.5')).toEqual({ value: 2.5, invalid: false });
    expect(parsePriceInput('2.')).toEqual({ value: 2, invalid: false });
    expect(parsePriceInput('.5')).toEqual({ value: 0.5, invalid: false });
    expect(parsePriceInput('0')).toEqual({ value: 0, invalid: false });
  });

  it('吃掉千分位（用户常从账单页复制带分隔符的数字）', () => {
    expect(parsePriceInput('1,234.5')).toEqual({ value: 1234.5, invalid: false });
  });

  it('真正非法的输入要能被拦住，而不是静默当成 0', () => {
    for (const bad of ['abc', '2.5.1', '-1', '2e3', '¥2']) {
      expect(parsePriceInput(bad).invalid, bad).toBe(true);
    }
  });
});

describe('格式化', () => {
  it('大额两位、小额四位、零不补零（¥0.00 看起来像没算）', () => {
    expect(formatCost(12.345, 'CNY')).toBe('¥12.35');
    expect(formatCost(0.00312, 'USD')).toBe('$0.0031');
    expect(formatCost(0, 'CNY')).toBe('¥0');
    expect(formatCost(Number.NaN, 'CNY')).toBe('¥0');
    expect(formatCost(-3, 'CNY')).toBe('¥0');
  });

  it('单价文案把「缓存按输入价」这层明说出来', () => {
    expect(formatUnitPrice(price({ cacheReadPerMillion: null }))).toContain('缓存按输入价');
    expect(formatUnitPrice(price({ cacheReadPerMillion: 0.5 }))).toContain('¥0.5');
  });
});
