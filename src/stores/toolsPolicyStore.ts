import { create } from 'zustand';
import { platform } from '@/platform';
import type { NanobotFileToolsPolicy } from '@/platform/types';

/**
 * 引擎写策略（`tools.file.default_deny_write`，FR-8.4）的状态。
 *
 * 单独一个 store 而不是塞进 `modelsStore`：那是「模型」这一件事的看门人，
 * 写策略动的是 `tools.file` 段，两者的回读来源（config.json 的不同段）、
 * 幂等口径、以及「改完要不要重启 serve」的理由都不一样。混在一起会让
 * 「读写策略」顺带把模型列表也拉一遍。
 */

interface ToolsPolicyState {
  /**
   * 当前写策略；`null` = 还没加载 / 引擎不认这个字段。
   *
   * 刻意不在这里塞 `false` 兜底：开关的默认值与「拿不到」在界面上是两种话术
   * ——前者表示「已关闭」，后者表示「说不清」，拿 false 顶上去会让用户以为
   * 自己开着页面时策略是关的。
   */
  policy: NanobotFileToolsPolicy | null;
  /** 配置是否可读（Web 端与找不到 config.json 时为 false） */
  policyAvailable: boolean;
  policyLoading: boolean;
  /** 从 config.json 重新读一次写策略；`force` 用于写完之后的以盘为准回读 */
  loadPolicy: (force?: boolean) => Promise<void>;
  /** 切换默认拒绝写入；成功返回 true */
  setDefaultDenyWrite: (value: boolean) => Promise<boolean>;
}

/** 飞行中的回读，避免「进入安全分区 + 打开开关」并发各读一遍 */
let inflight: Promise<void> | null = null;

export const useToolsPolicyStore = create<ToolsPolicyState>((set, get) => ({
  policy: null,
  policyAvailable: false,
  policyLoading: false,

  loadPolicy: (force = false) => {
    if (inflight && !force) return inflight;
    set({ policyLoading: true });
    inflight = (async () => {
      try {
        const snapshot = await platform.getNanobotTools();
        // 主进程在「段缺失 / 字段非法」时回的是 supported:false 的策略而不是 null，
        // 所以除了 null 之外都算可读——这是「这台机器能管」与「引擎不认这个字段」的分界。
        set({
          policy: snapshot?.file ?? null,
          policyAvailable: snapshot !== null,
        });
      } catch {
        // 桥不可用 / 配置损坏：保留上一次的状态，把可用性标为 false
        set({ policyAvailable: false });
      } finally {
        set({ policyLoading: false });
        inflight = null;
      }
    })();
    return inflight;
  },

  setDefaultDenyWrite: async (value) => {
    const result = await platform.syncNanobotTools(JSON.stringify({ op: 'setDefaultDenyWrite', defaultDenyWrite: value }));
    if (!result.ok) return false;
    // 以磁盘为准回读：主进程会补出 `tools.file` 段（原先可能整段不存在），
    // 拿本地那份乐观状态显示就与文件里的实际形状对不上。
    await get().loadPolicy(true);
    return true;
  },
}));

/**
 * 引擎是否认这个字段（`tools.file` 段存在且能解析出布尔值）。
 *
 * 界面用它区分两种「开关不生效」：引擎版本没带这个功能（置灰 + 说明），
 * 与本机配置没写进去（照常给开关）。
 */
export function isPolicySupported(policy: NanobotFileToolsPolicy | null): boolean {
  return policy?.supported === true;
}
