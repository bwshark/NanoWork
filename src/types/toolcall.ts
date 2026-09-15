/** 敏感类别：文件读写 / 终端命令 / 网络访问 */
export type SensitiveCategory = 'files' | 'shell' | 'network';

/** 工具调用状态机 */
export type ToolCallStatus =
  | 'pending' // 等待权限批准
  | 'approved' // 已批准（尚未执行完成）
  | 'rejected' // 已拒绝
  | 'running' // 执行中
  | 'done' // 完成
  | 'error'; // 出错

/** 一次工具调用事件 / 记录 */
export interface ToolCall {
  id: string;
  /** 工具名：web_search | web_fetch | files | shell | image_gen | chat */
  tool: string;
  /** 工具入参 */
  args: Record<string, unknown>;
  /** 是否属于敏感类别（files/shell/network 为 true） */
  sensitive: boolean;
  /** 当前状态 */
  status: ToolCallStatus;
  /** 执行结果文本 */
  result?: string;
}
