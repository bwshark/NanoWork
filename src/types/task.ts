import type { SyncMetaFields } from './sync';

/**
 * 任务调度（对齐 nanobot CronSchedule 的三种形态）：
 * - cron：标准 5 段表达式（可选时区 tz）→ nanobot { kind:'cron', expr, tz }
 * - interval：间隔分钟数 → nanobot { kind:'every', everyMs }
 * - once：单次定时（ISO 时间戳）→ nanobot { kind:'at', atMs }
 * - rrule：RFC 5545 循环规则（FR-5.4）→ **前端降级**为上面三种之一后再下发给引擎
 *
 * ⚠️ `rrule` 是**本层的表达形态**，不是引擎形态：真实调度在 nanobot 的 CronService，
 * 它只认 cron / every / at。降级规则与「哪些规则降不了」见 `src/lib/rrule.ts`。
 * 之所以不在保存时就把 `rrule` 换成 cron，是为了让用户**看到自己写的那条规则**
 * （`FREQ=MONTHLY;BYMONTHDAY=1,15,28` 比 `0 9 1,15,28 * *` 更接近他的意图）。
 */
export type TaskSchedule =
  | { kind: 'cron'; expr: string; tz?: string }
  | { kind: 'rrule'; rrule: string; tz?: string }
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
  /**
   * 有效期窗口下界（ISO）。到期前不触发——用于「这条自动化从这个月开始」。
   *
   * 引擎没有「有效期」概念（cron / every / at 都不带窗口），所以窗口由**前端计算**
   * 下次触发时刻时体现：落在窗口外的调度不再给出 `nextRunAtMs`（任务自然不执行）。
   * 见 `computeNextRunMs`。
   */
  validFrom?: string;
  /** 有效期窗口上界（ISO，**含**）。`RRULE` 里的 `UNTIL=` 会落到这里 */
  validUntil?: string;
  status: TaskStatus;
  createdAt: string;
  /** 执行配置（模型/技能/权限），同步时落入 nanobot payload.originMetadata */
  runOptions?: TaskRunOptions;
}
