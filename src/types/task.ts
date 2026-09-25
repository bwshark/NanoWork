import type { SyncMetaFields } from './sync';

/**
 * 任务调度（对齐 nanobot CronSchedule 的三种形态）：
 * - cron：标准 5 段表达式（可选时区 tz）→ nanobot { kind:'cron', expr, tz }
 * - interval：间隔分钟数 → nanobot { kind:'every', everyMs }
 * - once：单次定时（ISO 时间戳）→ nanobot { kind:'at', atMs }
 */
export type TaskSchedule =
  | { kind: 'cron'; expr: string; tz?: string }
  | { kind: 'interval'; minutes: number }
  | { kind: 'once'; at: string };

/** 任务状态 */
export type TaskStatus = 'enabled' | 'disabled';

/** 任务运行记录（测试运行 / 定时触发 的执行留痕） */
export interface TaskRunRecord {
  id: string;
  taskId: string;
  taskName: string;
  /** 触发方式：manual=测试运行；scheduled=定时触发 */
  trigger: 'manual' | 'scheduled';
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'success' | 'error';
  /** 关联会话 id（可跳转查看完整对话，测试运行用） */
  sessionId?: string;
  /** 引擎侧会话键（定时触发用，形如 `api:cron-{taskId}`，用于只读拉取执行会话） */
  sessionKey?: string;
  /** 失败原因 */
  error?: string;
  /** 引擎回复正文（定时触发 status=ok 时可用作会话内容兜底） */
  response?: string;
  /** 引擎原始运行 id（形如 `{jobId}:{timestamp}:{rand}`，每次执行唯一） */
  runId?: string;
  /** 耗时（毫秒） */
  durationMs?: number;
}

/** 任务执行配置（对齐聊天输入框的会话级控件：模型/技能/权限） */
export interface TaskRunOptions {
  /** 模型名；缺省（''/undefined）表示跟随全局默认模型 */
  model?: string;
  /** 任务执行时启用的技能 id 列表 */
  skillIds?: string[];
  /** 完全访问权限：true 时敏感操作自动批准（对应 session.fullAccess 语义） */
  fullAccess?: boolean;
}

/** 自动化任务配置 */
export interface TaskConfig extends SyncMetaFields {
  id: string;
  name: string;
  schedule: TaskSchedule;
  /** 触发时发送给 Agent 的提示词 */
  prompt: string;
  /** 目标 Agent（专家）id */
  agentId: string;
  status: TaskStatus;
  createdAt: string;
  /** 执行配置（模型/技能/权限），同步时落入 nanobot payload.originMetadata */
  runOptions?: TaskRunOptions;
}
