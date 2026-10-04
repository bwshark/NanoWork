import { describe, expect, it } from 'vitest';
import {
  addFallbackPreset,
  chainedPresetNames,
  DEFAULT_PROVIDER_RETRY_MODE,
  describeFallbacks,
  fallbackIssues,
  hasBlockingIssues,
  moveFallback,
  PROVIDER_RETRY_MODE_OPTIONS,
  providerRetryModeOption,
  removeFallbackAt,
  type FallbackPresetInfo,
} from '@/lib/modelFallbacks';
import type { NanobotFallbackCandidate } from '@/platform/types';

const PRESETS: FallbackPresetInfo[] = [
  { name: 'sciherd', model: 'Qwen3.8-Flash', providerLabel: '阿里云百炼' },
  { name: 'deepseek', model: 'deepseek-chat', providerLabel: 'DeepSeek' },
];

const preset = (name: string): NanobotFallbackCandidate => ({ kind: 'preset', preset: name });
const inline = (model: string, provider: string): NanobotFallbackCandidate => ({
  kind: 'inline',
  model,
  provider,
});

describe('describeFallbacks', () => {
  it('引用了预设：主文案是预设名，副文案是解析出的模型与供应商', () => {
    const [view] = describeFallbacks([preset('deepseek')], PRESETS);

    expect(view?.position).toBe(1);
    expect(view?.label).toBe('deepseek');
    expect(view?.hint).toBe('deepseek-chat · DeepSeek');
    expect(view?.resolved).toBe(true);
  });

  it('⚠️ 引用了已删除的预设：**看得见**且标为未解析（不是显示成空白）', () => {
    // 这一条是「引擎会在配置加载时拒绝整份配置」的唯一可视信号，
    // 藏起来或者渲染成空行，用户就只看到「网关起不来」而找不到原因。
    const [view] = describeFallbacks([preset('ghost')], PRESETS);

    expect(view?.label).toBe('ghost');
    expect(view?.hint).toBe('该预设已不存在');
    expect(view?.resolved).toBe(false);
  });

  it('内联项恒为 resolved（它自带 model + provider，不依赖预设表）', () => {
    const [view] = describeFallbacks([inline('gpt-4o', 'openai')], PRESETS);

    expect(view?.label).toBe('gpt-4o');
    expect(view?.hint).toContain('内联配置');
    expect(view?.resolved).toBe(true);
  });

  it('位置从 1 起（组件直接渲染，不再自己算下标）', () => {
    const views = describeFallbacks([preset('deepseek'), inline('m', 'p')], PRESETS);

    expect(views.map((v) => v.position)).toEqual([1, 2]);
  });
});

describe('fallbackIssues', () => {
  const base = { presetNames: PRESETS.map((p) => p.name), primaryPreset: 'sciherd' };

  it('干净的链没有任何问题', () => {
    expect(fallbackIssues({ ...base, list: [preset('deepseek')] })).toEqual([]);
  });

  it('⭐ 引用了不存在的预设 → blocking（引擎会拒绝加载整份配置）', () => {
    const issues = fallbackIssues({ ...base, list: [preset('ghost')] });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('unresolved');
    expect(issues[0]?.blocking).toBe(true);
    expect(issues[0]?.position).toBe(1);
    expect(hasBlockingIssues(issues)).toBe(true);
  });

  it('重复项 → 只提示不阻断（写得出来，只是白等一次）', () => {
    const issues = fallbackIssues({ ...base, list: [preset('deepseek'), preset('deepseek')] });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('duplicate');
    expect(issues[0]?.blocking).toBe(false);
    // 指向**后**出现的那一项，前一项才是「第一次出现」
    expect(issues[0]?.position).toBe(2);
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it('内联项的重复按 model + provider 判（同模型不同供应商是两条不同的回退）', () => {
    const same = fallbackIssues({
      ...base,
      list: [inline('m', 'p'), inline('m', 'p')],
    });
    expect(same.map((i) => i.kind)).toEqual(['duplicate']);

    const different = fallbackIssues({
      ...base,
      list: [inline('m', 'p'), inline('m', 'q')],
    });
    expect(different).toEqual([]);
  });

  it('回退到默认模型本身 → 只提示（会话级模型覆盖意味着「主模型」会随会话变）', () => {
    const issues = fallbackIssues({ ...base, list: [preset('sciherd')] });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('primary');
    expect(issues[0]?.blocking).toBe(false);
  });

  it('primaryPreset 为 null（走隐式 default 预设）时不做 primary 判断', () => {
    expect(
      fallbackIssues({ ...base, primaryPreset: null, list: [preset('sciherd')] }),
    ).toEqual([]);
  });

  it('同一条可以同时命中多类问题（不存在的预设也不可能被判成 primary）', () => {
    const issues = fallbackIssues({
      ...base,
      list: [preset('ghost'), preset('ghost')],
    });

    expect(issues.map((i) => i.kind)).toEqual(['unresolved', 'unresolved', 'duplicate']);
  });
});

describe('链的编辑（全部返回新数组）', () => {
  const chain = [preset('a'), preset('b'), preset('c')];

  it('追加：空名与重复预设都原样返回（从源头不制造 duplicate）', () => {
    expect(chainedPresetNames(addFallbackPreset(chain, 'd'))).toEqual(['a', 'b', 'c', 'd']);
    expect(addFallbackPreset(chain, 'a')).toEqual(chain);
    expect(addFallbackPreset(chain, '   ')).toEqual(chain);
  });

  it('追加不修改入参', () => {
    const before = JSON.stringify(chain);
    addFallbackPreset(chain, 'd');
    expect(JSON.stringify(chain)).toBe(before);
  });

  it('摘除：越界原样返回', () => {
    expect(chainedPresetNames(removeFallbackAt(chain, 1))).toEqual(['a', 'c']);
    expect(removeFallbackAt(chain, -1)).toEqual(chain);
    expect(removeFallbackAt(chain, 3)).toEqual(chain);
    expect(removeFallbackAt([], 0)).toEqual([]);
  });

  it('⭐ 上移 / 下移：到边界**不做环绕**（用户点它是想顶到头，不是甩到另一头）', () => {
    // 把最后一环（c）往上提一格 → [a, c, b]
    expect(chainedPresetNames(moveFallback(chain, 2, -1))).toEqual(['a', 'c', 'b']);
    expect(moveFallback(chain, 0, -1)).toEqual(chain);
    expect(moveFallback(chain, 2, 1)).toEqual(chain);
    // 把第一环（a）往下压一格 → [b, a, c]
    expect(chainedPresetNames(moveFallback(chain, 0, 1))).toEqual(['b', 'a', 'c']);
  });

  it('chainedPresetNames 只收预设引用（内联项不是预设名）', () => {
    expect(chainedPresetNames([preset('a'), inline('m', 'p'), preset('b')])).toEqual(['a', 'b']);
  });
});

describe('重试模式', () => {
  it('缺省是 standard（与引擎 `provider_retry_mode` 的默认值一致）', () => {
    expect(DEFAULT_PROVIDER_RETRY_MODE).toBe('standard');
  });

  it('未知取值回落到第一档，而不是抛出（手改过的 config 不该让界面崩）', () => {
    expect(providerRetryModeOption('persistent').value).toBe('persistent');
    expect(providerRetryModeOption('nonsense' as never).value).toBe(
      PROVIDER_RETRY_MODE_OPTIONS[0]?.value,
    );
  });

  it('两档的说明都写清了「什么时候放弃」——这是两档唯一的实质差别', () => {
    for (const option of PROVIDER_RETRY_MODE_OPTIONS) {
      expect(option.label).toBeTruthy();
      expect(option.description.length).toBeGreaterThan(10);
    }
    expect(providerRetryModeOption('standard').description).toContain('1s / 2s / 4s');
    expect(providerRetryModeOption('persistent').description).toContain('60s');
  });
});
