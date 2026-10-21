/** 敏感操作权限决策记录（FR-009） */
export interface PermissionLog {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  decision: 'approved' | 'rejected';
  /** 决策时间 ISO 8601 UTC */
  at: string;
}

/**
 * 逐条批准的裁决结果。
 *
 * `always` = 「本会话内始终允许这个工具」。它与 `allow` 的差别只在**下次还问
 * 不问**，不改变本次是否放行（两者都会执行）。刻意做成独立取值而不是让前端
 * 自己记账：豁免必须由引擎持有——只有它知道下一轮同一个工具会不会再来，
 * 也只有它能保证「换会话即失效」。
 *
 * 声明处刻意放在 `@/types`（而不是引擎契约层 `src/ai/runtime/types.ts`）：
 * 平台层（`src/platform/types.ts`）也要用它，而平台层是渲染层与主进程
 * 共同的底座，不能反向依赖上层契约。契约层从本处**转出**，既有
 * `from '@/ai/runtime/types'` 的 import 路径全部照常可用。
 */
export type ApprovalDecision = 'allow' | 'deny' | 'always';
