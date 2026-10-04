import { create } from 'zustand';
import { getRuntime } from '@/ai/runtime';
import { emptyUsageStats, USAGE_WINDOWS, type UsageWindow } from '@/lib/usageReport';
import type { UsageStats } from '@/types';

/**
 * 本地 LLM 用量报表（FR-11.1）的状态。
 *
 * ## 为什么**不持久化**
 *
 * 与 `pluginsStore` 同理：这里装的全是**事实**（引擎 sqlite 里记了多少 token），
 * 没有一条是「用户的决定」。事实每次向权威（引擎）重读一遍即可，落盘只会制造
 * 第二份可能过期的真相——重启后拿昨天的数字渲染「近 7 天」，比空列表难查得多。
 *
 * ## 为什么**不在启动时自动拉**
 *
 * 读一次要发一个 HTTP（且引擎侧要跑聚合 SQL）。绝大多数会话根本不看用量，
 * 所以只在**进用量分区时**由界面触发 `refresh()`。
 *
 * ## 读取失败不是异常
 *
 * 网关没起、网关是旧版本（没有 `/v1/usage`）都是常态。契约层已经把它们收敛成
 * `available=false` + `error`；这里只额外兜住「实现违约抛了异常」这一种情况，
 * 同样转成空报表——看一眼用量不该把设置弹窗整块弄崩。
 */

interface UsageState {
  /** 最近一次读到的报表；初始 `available=false` 且 `loaded=false`（还没读过） */
  stats: UsageStats;
  /** 是否读过至少一次（区分「还没读」与「读到了但没数据」） */
  loaded: boolean;
  /** 正在读取（界面据此禁用重复点击） */
  refreshing: boolean;
  /** 趋势图窗口（天）。只是看图偏好，不参与取数——引擎一次就把全窗口给了 */
  windowDays: UsageWindow;
  /** 重新问一次引擎 */
  refresh: () => Promise<void>;
  setWindowDays: (days: UsageWindow) => void;
}

/** 契约层违约（抛异常）时的兜底：`available=false` 并如实带上原因 */
function failureStats(err: unknown): UsageStats {
  const message = err instanceof Error ? err.message : String(err);
  return emptyUsageStats(message || '读取用量失败');
}

export const useUsageStore = create<UsageState>((set, get) => ({
  stats: emptyUsageStats(),
  loaded: false,
  refreshing: false,
  windowDays: 30,

  refresh: async () => {
    // 去重：并发触发没有意义，引擎侧同一份 SQL 跑两遍只是白白多一次往返
    if (get().refreshing) return;
    set({ refreshing: true });
    try {
      const stats = await getRuntime().readUsageStats();
      set({ stats, loaded: true, refreshing: false });
    } catch (err) {
      set({ stats: failureStats(err), loaded: true, refreshing: false });
    }
  },

  setWindowDays: (days) => {
    // 只接受登记过的档位：窗口来自按钮组，非法值意味着「调用点写错了」，
    // 静默接受会让趋势图与切换按钮的高亮对不上（点了 90 天，图还是 7 天）。
    if (!USAGE_WINDOWS.includes(days)) return;
    set({ windowDays: days });
  },
}));
