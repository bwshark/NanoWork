import { create } from 'zustand';
import { platform } from '@/platform';
import type { NanobotFileToolsPolicy, NanobotPathRule } from '@/platform/types';
import { recordAppAudit } from '@/lib/appAudit';

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
  /**
   * [LOCAL PATCH] FR-8.13：整表替换路径规则；成功返回 true。
   *
   * 刻意是**整表**而不是「增 / 删 / 改一条」：规则表的价值在于「一眼看完谁被限制成
   * 什么样」，增量接口会让「删掉某条」这种最常见操作退化成「先读全表、改一条、
   * 再写回」，而读与写之间的任何并发改动都会被静默覆盖。
   */
  setPathRules: (rules: NanobotPathRule[]) => Promise<boolean>;
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
    if (!result.ok) {
      // 安全策略改不动也是事实：失败留痕比成功更需要（用户会以为已经生效）
      recordAppAudit({
        action: 'security.deny_write',
        outcome: 'failed',
        detail: { defaultDenyWrite: value },
        reason: result.message,
      });
      return false;
    }
    recordAppAudit({ action: 'security.deny_write', detail: { defaultDenyWrite: value } });
    // 以磁盘为准回读：主进程会补出 `tools.file` 段（原先可能整段不存在），
    // 拿本地那份乐观状态显示就与文件里的实际形状对不上。
    await get().loadPolicy(true);
    return true;
  },

  setPathRules: async (rules) => {
    const result = await platform.syncNanobotTools(
      JSON.stringify({ op: 'setPathRules', pathRules: rules }),
    );
    if (!result.ok) {
      recordAppAudit({
        action: 'security.path_rules',
        outcome: 'failed',
        detail: { rules: rules.length },
        reason: result.message,
      });
      return false;
    }
    // 只记条数与拒绝动作的分布：规则正文（路径 + 动作）可能包含目录结构，
    // 记条数已足够回答「有没有人放宽过写权限」
    recordAppAudit({
      action: 'security.path_rules',
      detail: {
        rules: rules.length,
        denyWrite: rules.filter((r) => r.action.write === 'deny').length,
        denyDelete: rules.filter((r) => r.action.delete === 'deny').length,
        denyRead: rules.filter((r) => r.action.read === 'deny').length,
      },
    });
    // 与写开关同一条理由：以盘为准回读（主进程可能补出整段 tools.file）
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
