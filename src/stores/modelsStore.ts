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
 * 模型 id → 展示名解析：
 * - 命中目录：优先预设 label，否则底层模型名；
 * - 未命中（如自定义模型名）：原样展示；
 * - 空值（Auto）：取目录首位（default 预设）的展示名，目录为空返回 undefined，
 *   由调用方决定兜底文案。
 * @param models 模型目录
 * @param id 会话/任务所选模型 id（空串/undefined 表示 Auto）
 * @returns 用于 UI 展示的模型名称
 */
export function describeModelId(models: ModelInfo[], id?: string | null): string | undefined {
  if (id) {
    const entry = models.find((m) => m.id === id);
    return entry?.label ?? entry?.model ?? id;
  }
  const def = models[0];
  return def?.label ?? def?.model;
}
