import type { SyncMetaFields } from './sync';

/**
 * 任务调度（对齐 nanobot CronSchedule 的三种形态）：
 * - cron：标准 5 段表达式（可选时区 tz）→ nanobot { kind:'cron', expr, tz }
 * - interval：间隔分钟数 → nanobot { kind:'every', everyMs }
 * - once：单次定时（ISO 时间戳）→ nanobot { kind:'at', atMs }
 * - rrule：RFC 5545 循环规则（FR-5.4）→ **前端降级**为上面三种之一后再下发给引擎
 *
 * ⚠️ `rrule` 是**本层的表达形态**，不是引擎形态：真实调度在 nanobot 的 CronService，
 * 它只认 cron / every / at。降级规则与「哪些规则降不了」见 `src/lib/task/rrule.ts`。
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

/**
 * 结果推送目标（FR-5.6）：某个 IM 渠道里的一个**具体会话**。
 *
 * ⚠️ 光有渠道名不够——引擎投递必须知道「发到哪个会话」，所以 `chatId` 是必需的。
 * 可选目标来自 `platform.nanobotListChannelSessions()`（引擎侧真实存在过的渠道会话），
 * 也就是「用户与机器人在该渠道里真的说过话」的那些会话；凭空编一个 chatId 推不出去。
 */
export interface TaskDeliveryTarget {
  /** 引擎侧渠道名（`wecom` / `weixin` / `feishu` / `dingtalk` …），会话 key 冒号**前**段 */
  channel: string;
  /** 目标会话 id，会话 key 冒号**后**段 */
  chatId: string;
}

/**
 * 结果推送配置（FR-5.6）。
 *
 * 与「任务执行会话」**刻意分离**：任务仍在自己那个 `api:cron-{id}` 会话里执行
 * （工作区/权限/留痕一律不变），跑完再把结果**另发**一份到这些目标。
 *
 * ⚠️ 别把它接到引擎 `payload` 的 `deliver` / `channel` / `to` 上——那三个是
 * **session-bound 之前的遗留字段**：引擎加载时会把它们迁移掉，且**只要非空**
 * 就把任务判成「未绑定会话」并禁用（见 `nanobot/nanobot/cron/session_turns.py`
 * 的 `is_bound_cron_job`）。本配置走引擎新增的 `payload.delivery`（`[LOCAL PATCH]`）。
 */
/**
 * 推送时机。三档是**包含**关系而不是并列：
 * - `complete`：每次执行结束都推（成功推结果、失败推失败原因）
 * - `error`：仅失败时推（比 `complete` 更窄的过滤）
 * - `start`：在结果之外**多推一条**「已开始执行」，因此它包含 `complete`
 *
 * ⚠️ 「只告诉我开始了」不是一个有用的档位——用户永远不会知道结果。所以 `start`
 * 是包住 `complete` 的：它只会让人**多收一条**，不会让人少收结果。
 *
 * ⚠️ PRD §15.2 目标模型里的 `milestone`（每个关键节点）**未实现**：绑定的定时任务
 * 就是一轮 agent turn，「轮内」没有一个既对用户有意义、又能被引擎观察到、又不会把
 * 聊天变成日志流的节点。这里刻意**不收**该取值——声明一个不生效的档位，只会让用户
 * 以为选了就会生效。
 */
export type TaskDeliveryOn = 'complete' | 'error' | 'start';

export interface TaskDelivery {
  targets: TaskDeliveryTarget[];
  /** 推送时机，语义见 `TaskDeliveryOn` 的说明 */
  on: TaskDeliveryOn;
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
  /**
   * 任务级工作目录（FR-5.8）。留空 = 跟随默认工作空间。
   *
   * 实现方式：写进 job 的 `originMetadata.workspace_scope.project_path`（见 `toNanobotJob`），
   * 由引擎在**每个 turn 的会话作用域**里解析生效。
   *
   * ⚠️ 这条链路成立的前提是任务的 origin 渠道保持 `api`：引擎的
   * `WorkspaceScopeResolver.scoped_channels` 只认 `{websocket, api}`，渠道不在其中时
   * `for_turn` 会**直接回落默认工作空间**且不报错。所以「让任务跑在外部 IM 会话里」
   * （拿 IM 渠道名当 origin channel）与「任务级工作目录」是**互斥**的 —— 这也正是结果
   * 回推最终另开 `delivery` 字段、而不是改 origin 渠道的原因（见 §15.3）。
   *
   * 必须给**绝对路径**：引擎对相对路径抛错，而那个错误会被静默吞掉并回落默认值，
   * 用户只会看到「配了目录却没生效」，所以录入侧（表单）就拦住。
   */
  workdir?: string;
  status: TaskStatus;
  createdAt: string;
  /** 结果推送（FR-5.6）；缺省 = 不推送（任务结果只留在自己的执行留痕里） */
  delivery?: TaskDelivery;
  /** 执行配置（模型/技能/权限），同步时落入 nanobot payload.originMetadata */
  runOptions?: TaskRunOptions;
}
