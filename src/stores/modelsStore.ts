import { create } from 'zustand';
import { connectionManager } from '@/ai/connectionManager';
import type { ModelInfo } from '@/types';

interface ModelsState {
  /**
   * 模型目录（来源：nanobot 网关 /v1/models，即其配置中的 modelPresets +
   * 隐式 default，default 固定首位）。空数组表示未加载或网关离线。
   */
  models: ModelInfo[];
  loading: boolean;
  /**
   * 从 nanobot 网关拉取模型目录。
   * - 并发去重：多处同时触发仅发起一次请求；
   * - 已加载且非 force 时直接短路，打开下拉等高频场景零开销；
   * - 失败（离线/异常）静默保留旧列表，UI 回退默认模型展示。
   * @param force 是否强制重新拉取（网关配置变更后使用）
   */
  refresh: (force?: boolean) => Promise<void>;
}

/** 进行中的拉取任务（并发去重句柄） */
let inflight: Promise<void> | null = null;

export const useModelsStore = create<ModelsState>()((set, get) => ({
  models: [],
  loading: false,

  refresh: (force = false) => {
    if (inflight) return inflight;
    if (!force && get().models.length > 0) return Promise.resolve();
    set({ loading: true });
    inflight = (async () => {
      try {
        const client = await connectionManager.getClient();
        const models = await client.listModels();
        set({ models });
      } catch {
        // 网关离线或拉取失败：保留旧目录，UI 以默认模型兜底展示
      } finally {
        set({ loading: false });
        inflight = null;
      }
    })();
    return inflight;
  },
}));

/**
 * 隐式 default 预设的条目（`/v1/models` 固定把它排在首位）。
 * 请求里**不带 `model` 字段**时实际生效的就是它，所以判据要以 `id` 为准、
 * 而不是靠数组位置——顺序将来变了也不该让「Auto 指向谁」跟着漂。
 */
export function defaultModelEntry(models: ModelInfo[]): ModelInfo | undefined {
  return models.find((m) => m.id === 'default') ?? models[0];
}

/**
 * 模型选择的展示文案：**chip 与菜单行共用这一份口径**，两处永远同字。
 *
 * 两个坑都在这里收口：
 * 1. **Auto 不是一个模型 id**——此时请求里不带 `model` 字段，真正生效的是隐式 default
 *    预设。所以写成 `Auto · <真实模型名>`：只写模型名会让人以为「选了某个预设」
 *    （2026-09-21 的 `The model sciherd does not exist` 就是这么误判出来的），
 *    只写 Auto 又看不出到底跑哪个模型。
 * 2. **预设名 ≠ 模型名**——写成 `sciherd · Qwen3.8-Flash`。前者是请求里发出去的那个值
 *    （引擎据此查 `modelPresets`），后者才是交给上游的值。两者不同名时必须都写出来；
 *    否则「默认模型的模型名恰好等于某个预设名」时，菜单里会出现两行一模一样的文案，
 *    而它们的真实含义完全不同。
 *
 * @param models 模型目录
 * @param id 会话/任务所选模型 id（空串/undefined 表示 Auto）
 * @returns 可直接渲染的文案；目录为空时退化为 `Auto` 或原样 id，**不返回 undefined**
 *   （调用方不再需要各自兜底，兜底文案一旦分叉就又会两处不一致）
 */
export function describeModelId(models: ModelInfo[], id?: string | null): string {
  if (id) {
    const entry = models.find((m) => m.id === id);
    // 目录里没有的 id（用户自填的模型名）：原样展示，别吞掉他写的东西
    if (!entry) return id;
    const label = entry.label ?? entry.model ?? entry.id;
    return entry.model && entry.model !== label ? `${label} · ${entry.model}` : label;
  }
  const def = defaultModelEntry(models);
  const real = def?.model ?? def?.label;
  return real ? `Auto · ${real}` : 'Auto';
}
