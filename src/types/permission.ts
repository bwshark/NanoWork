/** 敏感操作权限决策记录（FR-009） */
export interface PermissionLog {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  decision: 'approved' | 'rejected';
  /** 决策时间 ISO 8601 UTC */
  at: string;
}
