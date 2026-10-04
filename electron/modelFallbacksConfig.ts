/**
 * `agents.defaults.fallbackModels` 的读写转换与引用维护（FR-9.4）。
 *
 * 抽成独立模块（而不是留在 `main.ts` 里）是为了**能单测**：这几段代码的错法都很安静
 * ——键名写成 snake_case 也照样能跑（引擎 `Base` 两种都收，只是文件里多一种风格），
 * 而漏掉引用维护则会让**下一份配置直接加载失败**。都属于「不靠用例就发现不了」的那类。
 *
 * 本模块**不 import electron**，只用 `node:path` 之外的纯逻辑，因此可以在 vitest 里
 * 直接跑。
 */

import type {
  NanobotFallbackCandidate,
  ProviderRetryMode,
} from '../src/platform/types';

/** `agents.defaults.providerRetryMode` 的取值域（引擎侧是 `Literal["standard","persistent"]`） */
export const PROVIDER_RETRY_MODES = ['standard', 'persistent'] as const;

export function parseProviderRetryMode(value: unknown): ProviderRetryMode {
  return typeof value === 'string' && (PROVIDER_RETRY_MODES as readonly string[]).includes(value)
    ? (value as ProviderRetryMode)
    : 'standard';
}

/**
 * 引擎的 `fallbackModels` → 客户端的两态联合。
 *
 * 只认两种形状（字符串 / 带 `model`+`provider` 的对象），其余**原样跳过**：
 * 回退链是引擎**配置加载时**校验的（引用了不存在的预设会让 `Config` 抛 ValueError，
 * 即整个配置加载失败、网关起不来）。把不认识的东西猜成某一态再回写，等于把一个
 * 本来能跑起来的配置改坏——所以宁可少回显一条，也不猜。
 */
export function parseFallbacks(raw: unknown): NanobotFallbackCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: NanobotFallbackCandidate[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry) out.push({ kind: 'preset', preset: entry });
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const model = typeof obj.model === 'string' ? obj.model : '';
    const provider = typeof obj.provider === 'string' ? obj.provider : '';
    if (!model || !provider) continue;
    const num = (field: string): number | null => {
      const value = obj[field];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    out.push({
      kind: 'inline',
      model,
      provider,
      maxTokens: num('maxTokens'),
      contextWindowTokens: num('contextWindowTokens'),
      temperature: num('temperature'),
      reasoningEffort: typeof obj.reasoningEffort === 'string' ? obj.reasoningEffort : null,
    });
  }
  return out;
}

/**
 * 客户端的两态联合 → 引擎的 `fallbackModels`。
 *
 * 键名写 **camelCase**：引擎的 `Base` 是 `alias_generator=to_camel` + `populate_by_name`，
 * 两种都收，但引擎自己 dump 出来的是 camelCase，跟着它写才不会让「同一个文件里
 * 两种风格并存」（下次有人照着文件抄就容易抄错）。
 *
 * `null` 一律显式写出来而不是省略键：两者语义相同（都表示「继承主模型」，见
 * `providers/factory.py::_inline_fallback_preset` 的 `is not None` 判断），但显式写
 * 才能从文件本身看出「这个值被设过」——同 `buildMutation` 对能力字段的处理。
 */
export function serializeFallbacks(list: readonly NanobotFallbackCandidate[]): unknown[] {
  return list.map((entry) =>
    entry.kind === 'preset'
      ? entry.preset
      : {
          model: entry.model,
          provider: entry.provider,
          maxTokens: entry.maxTokens ?? null,
          contextWindowTokens: entry.contextWindowTokens ?? null,
          temperature: entry.temperature ?? null,
          reasoningEffort: entry.reasoningEffort ?? null,
        },
  );
}

/**
 * 从 `defaults.fallbackModels` 里摘掉对某个预设的**字符串引用**。
 *
 * 内联项不受影响：它们自带 `model` + `provider`，不依赖预设表，所以别人删预设
 * 不会让它们失效。
 */
export function dropFallbackRef(raw: unknown, preset: string): unknown[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.filter((entry) => !(typeof entry === 'string' && entry === preset));
}

/** 把 `defaults.fallbackModels` 里对旧名的字符串引用改成新名（预设改名时用） */
export function renameFallbackRef(raw: unknown, from: string, to: string): unknown[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((entry) => (typeof entry === 'string' && entry === from ? to : entry));
}
