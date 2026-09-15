import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { platform, zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { toast } from '@/components/Toast';
import { syncTasksToNanobotRuntime } from '@/ai/nanobotTasks';
import { cronRecordsToSession } from '@/lib/sessionImport';
import { useSessionsStore } from '@/stores/sessionsStore';
import type { NanobotCronRunRecord } from '@/platform/types';
import type { TaskConfig, TaskRunRecord, TaskSchedule, TaskStatus } from '@/types';

/**
 * 定时任务 store（FR-005）。
 * 任何任务变更（新增 / 编辑 / 删除 / 启停）都会防抖后自动同步进
 * nanobot 运行时（幂等合并 jobs.json + 通知 gateway 热加载），
 * 无需用户手动点击「同步」；定时触发的执行记录经
 * fetchCronRuns 从 nanobot cron/runs 审计目录拉取并与本地
 * 测试运行记录合并展示。
 */

/** 运行记录保留上限（超出截断旧记录，防止持久化膨胀） */
const RUNS_MAX = 200;

/** 自动同步防抖间隔（毫秒）：合并连续的保存/启停为一次 jobs.json 写入 */
const AUTO_SYNC_DEBOUNCE_MS = 600;

/** 防抖定时器句柄（模块级，跨 store 调用共享） */
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;

/** 最近一次同步结果摘要（供 UI 提示；不参与持久化） */
export interface TaskSyncSummary {
  /** 同步完成时间（ISO 8601） */
  at: string;
  ok: boolean;
  message: string;
  /** 配置是否实际发生变更（幂等校准时为 false，UI 可据此静默） */
  changed?: boolean;
}

interface TasksState {
  tasks: TaskConfig[];
  /** 运行记录（倒序：最新在前；含本地测试运行与 nanobot 定时触发） */
  runs: TaskRunRecord[];
  /** 最近一次同步结果 */
  lastSync: TaskSyncSummary | null;
  /** 是否正在同步到 nanobot */
  syncing: boolean;
  addTask: (partial?: Partial<TaskConfig>) => TaskConfig;
  updateTask: (id: string, patch: Partial<TaskConfig>) => void;
  removeTask: (id: string) => void;
  toggleTask: (id: string) => void;
  /**
   * 测试运行：按任务配置（Agent/模型/技能/权限）创建会话并发送提示词，
   * 复用聊天真实执行链路；运行记录留痕并关联会话。
   */
  runTask: (id: string) => Promise<void>;
  /** 内部：更新指定运行记录 */
  finishRun: (runId: string, patch: Partial<TaskRunRecord>) => void;
  /** 同步全部任务到 nanobot 运行时（保存时自动触发，无需手动） */
  syncAll: () => Promise<void>;
  /** 从 nanobot cron/runs 审计目录拉取定时触发记录并合并进 runs */
  fetchCronRuns: () => Promise<void>;
  /**
   * 打开定时任务的执行会话：只读拉取引擎侧 `api:cron-{taskId}` 会话，
   * 注入 sessionsStore 并激活（聊天页以只读方式展示完整执行过程）。
   * @returns 是否成功打开（会话不存在时 false，调用方提示）
   */
  openCronSession: (taskId: string, title: string) => Promise<boolean>;
}

const nowIso = () => new Date().toISOString();

/** 已同步为侧边栏会话的 cron sessionKey 集合（模块级，跨调用去重） */
const syncedCronSessions = new Set<string>();

/**
 * 将 nanobot cron 执行审计记录映射为前端运行记录。
 * @param rec 引擎侧审计记录（queued/ok/error）
 * @returns 前端 TaskRunRecord（trigger='scheduled'，id 带 cron- 前缀防冲突）
 */
function cronRunToRecord(rec: NanobotCronRunRecord): TaskRunRecord {
  const status =
    rec.status === 'queued' ? 'running' : rec.status === 'ok' ? 'success' : 'error';
  return {
    id: `cron-${rec.runId}`,
    taskId: rec.jobId,
    taskName: rec.jobName || rec.jobId || '定时任务',
    trigger: 'scheduled',
    startedAt: new Date(rec.updatedAtMs || Date.now()).toISOString(),
    status,
    // 引擎执行会话键：展开记录时据此只读拉取完整执行过程
    ...(rec.sessionKey ? { sessionKey: rec.sessionKey } : {}),
    // 引擎原始运行 id（每次执行唯一，用于区分循环任务的多次运行）
    runId: rec.runId,
    ...(rec.error ? { error: rec.error } : {}),
    ...(rec.response ? { response: rec.response } : {}),
  };
}

export const useTasksStore = create<TasksState>()(
  persist(
    (set, get) => {
      /** 防抖自动同步：把短时间内的多次任务变更合并为一次 nanobot 同步 */
      const scheduleAutoSync = () => {
        if (autoSyncTimer) clearTimeout(autoSyncTimer);
        autoSyncTimer = setTimeout(() => {
          autoSyncTimer = null;
          void get().syncAll().catch(() => undefined);
        }, AUTO_SYNC_DEBOUNCE_MS);
      };

      return {
      tasks: [],
      runs: [],
      lastSync: null,
      syncing: false,

      addTask: (partial) => {
        const schedule: TaskSchedule =
          partial?.schedule ?? { kind: 'interval', minutes: 60 };
        // id 由调用方可指定（聊天中智能体经 cron 工具创建的任务镜像进来时，
        // 必须以引擎返回的 job id 落库，避免前端自造 id 形成双份调度）
        const id = partial?.id ?? genId();

        // 幂等合并：已存在同 id 任务时（镜像重放 / 历史消息恢复 / 重复写入），
        // 用 partial 字段覆盖更新并返回该任务，绝不重复追加；防抖自动同步照常触发。
        const existing = get().tasks.find((t) => t.id === id);
        if (existing) {
          const patch = Object.fromEntries(
            Object.entries(partial ?? {}).filter(([, v]) => v !== undefined),
          );
          const merged: TaskConfig = { ...existing, ...patch, id, createdAt: existing.createdAt };
          set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? merged : t)) }));
          scheduleAutoSync();
          return merged;
        }

        const task: TaskConfig = {
          id,
          name: partial?.name ?? '新任务',
          schedule,
          prompt: partial?.prompt ?? '',
          agentId: partial?.agentId ?? '',
          status: partial?.status ?? 'enabled',
          createdAt: nowIso(),
          ...(partial?.runOptions ? { runOptions: partial.runOptions } : {}),
        };
        set((s) => ({ tasks: [...s.tasks, task] }));
        scheduleAutoSync();
        return task;
      },

      updateTask: (id, patch) => {
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        }));
        scheduleAutoSync();
      },

      removeTask: (id) => {
        set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
        scheduleAutoSync();
      },

      toggleTask: (id) => {
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === id
              ? { ...t, status: (t.status === 'enabled' ? 'disabled' : 'enabled') as TaskStatus }
              : t,
          ),
        }));
        scheduleAutoSync();
      },

      finishRun: (runId, patch) =>
        set((s) => ({
          runs: s.runs.map((r) => (r.id === runId ? { ...r, ...patch } : r)),
        })),

      runTask: async (id) => {
        const task = get().tasks.find((t) => t.id === id);
        if (!task) return;
        if (!task.prompt.trim()) {
          toast.error('该任务未填写提示词，无法运行');
          return;
        }
        const sessions = useSessionsStore.getState();

        // 1) 创建执行会话：应用任务级 Agent / 模型 / 技能 / 权限配置
        const session = sessions.createSession(task.agentId || undefined, task.name, {
          fullAccess: task.runOptions?.fullAccess,
        });
        if (task.runOptions?.model) {
          sessions.setSessionModel(session.id, task.runOptions.model);
        }
        if (task.runOptions?.skillIds?.length) {
          sessions.updateSession(session.id, (s) => ({
            ...s,
            skillIds: [...(s.skillIds ?? []), ...task.runOptions!.skillIds!],
          }));
        }

        // 2) 写入运行记录（running）
        const started = Date.now();
        const run: TaskRunRecord = {
          id: genId(),
          taskId: task.id,
          taskName: task.name,
          trigger: 'manual',
          startedAt: nowIso(),
          status: 'running',
          sessionId: session.id,
        };
        set((s) => ({ runs: [run, ...s.runs].slice(0, RUNS_MAX) }));

        // 3) 真实执行（流式），完成后收敛记录状态
        try {
          const result = await sessions.send(task.prompt, session.id);
          // 错误信息取自本次执行返回值（全局 error 可能被并发会话覆盖）
          const err = result ? result.error : '任务未能启动';
          get().finishRun(run.id, {
            status: err ? 'error' : 'success',
            finishedAt: nowIso(),
            durationMs: Date.now() - started,
            ...(err ? { error: err } : {}),
          });
        } catch (e) {
          get().finishRun(run.id, {
            status: 'error',
            finishedAt: nowIso(),
            durationMs: Date.now() - started,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },

      syncAll: async () => {
        if (get().syncing) return;
        set({ syncing: true });
        try {
          const result = await syncTasksToNanobotRuntime(get().tasks);
          set({
            lastSync: { at: nowIso(), ok: result.ok, message: result.message, changed: result.changed },
          });
          if (!result.ok) {
            toast.error(result.message || '任务同步失败');
          } else if (result.changed) {
            toast.success(result.message);
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          set({ lastSync: { at: nowIso(), ok: false, message } });
          toast.error(`任务同步失败：${message}`);
        } finally {
          set({ syncing: false });
        }
      },

      fetchCronRuns: async () => {
        let records: NanobotCronRunRecord[];
        try {
          records = await platform.listNanobotCronRuns();
        } catch {
          return; // 审计目录不可读时静默跳过，不影响本地记录
        }
        const cronRuns = records.map(cronRunToRecord);

        // 为新完成的定时触发运行自动创建侧边栏会话（非 readonly）。
        // 去重键使用 run.id（每次执行唯一），而非 sessionKey（循环任务的所有运行共享同一 sessionKey）。
        for (const run of cronRuns) {
          if (run.status === 'running') continue;
          // run.id 形如 cron-{runId}，每次执行唯一，确保循环任务的每次运行都能独立创建会话
          if (syncedCronSessions.has(run.id)) continue;
          syncedCronSessions.add(run.id);

          let sessionCreated = false;

          // 尝试从引擎拉取完整会话 JSONL
          try {
            const detail = await platform.getCronSession(run.taskId);
            if (detail && detail.messages.length > 0) {
              const runTime = new Date(run.startedAt);
              const timeLabel = `${runTime.getHours().toString().padStart(2, '0')}:${runTime.getMinutes().toString().padStart(2, '0')}`;
              useSessionsStore.getState().openExternal(
                cronRecordsToSession(
                  `${detail.key}:${run.runId || run.id}`,
                  `${run.taskName || '定时任务执行'} (${timeLabel})`,
                  detail.messages,
                  detail.createdAt,
                  detail.updatedAt,
                  { readonly: false },
                ),
              );
              sessionCreated = true;
            }
          } catch {
            /* getCronSession 失败时走兜底 */
          }

          // 兜底：引擎 session 文件不可读时，用运行记录的 response 构建最小会话
          if (!sessionCreated && (run.response || run.error)) {
            const task = get().tasks.find((t) => t.id === run.taskId);
            const now = new Date();
            const timeLabel = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
            const fallbackMessages = [
              { role: 'user' as const, content: task?.prompt || run.taskName, timestamp: now.toISOString() },
              { role: 'assistant' as const, content: run.response || (`执行${run.status === 'error' ? '失败' : '完成'}${run.error ? `：${run.error}` : ''}`), timestamp: now.toISOString() },
            ];
            useSessionsStore.getState().openExternal(
              cronRecordsToSession(
                `api:cron-${run.taskId}:${run.runId || run.id}`,
                `${run.taskName || '定时任务执行'} (${timeLabel})`,
                fallbackMessages as unknown as Record<string, unknown>[],
                now.toISOString(),
                now.toISOString(),
                { readonly: false },
              ),
            );
          }
        }

        set((s) => {
          // 单次任务执行完成后自动移除（nanobot 侧 deleteAfterRun 已清理 job，
          // 前端同步移除 TaskConfig 保持一致）
          const completedOnceTaskIds = new Set(
            cronRuns
              .filter((r) => r.status !== 'running')
              .map((r) => r.taskId)
              .filter((id) => s.tasks.some((t) => t.id === id && t.schedule.kind === 'once')),
          );
          const tasks = completedOnceTaskIds.size > 0
            ? s.tasks.filter((t) => !completedOnceTaskIds.has(t.id))
            : s.tasks;

          // 定时触发记录以磁盘审计文件为准整体替换（id 带 cron- 前缀），
          // 本地测试运行记录原样保留，合并后按开始时间倒序
          const manualRuns = s.runs.filter((r) => !r.id.startsWith('cron-'));
          const merged = [...manualRuns, ...cronRuns].sort((a, b) =>
            Date.parse(b.startedAt) - Date.parse(a.startedAt),
          );
          return { tasks, runs: merged.slice(0, RUNS_MAX) };
        });
      },

      openCronSession: async (taskId, title) => {
        const detail = await platform.getCronSession(taskId);
        if (detail && detail.messages.length > 0) {
          useSessionsStore
            .getState()
            .openExternal(
              cronRecordsToSession(
                detail.key,
                title || '定时任务执行',
                detail.messages,
                detail.createdAt,
                detail.updatedAt,
              ),
            );
          return true;
        }
        // 引擎 session 文件不可读时，从运行记录取 response 兜底
        const run = get().runs.find((r) => r.taskId === taskId && r.trigger === 'scheduled');
        if (run?.response || run?.error) {
          const task = get().tasks.find((t) => t.id === taskId);
          const now = new Date().toISOString();
          const fallbackMessages = [
            { role: 'user' as const, content: task?.prompt || title || '定时任务', timestamp: now },
            { role: 'assistant' as const, content: run.response || (`执行${run.status === 'error' ? '失败' : '完成'}${run.error ? `：${run.error}` : ''}`), timestamp: now },
          ];
          useSessionsStore.getState().openExternal(
            cronRecordsToSession(
              `api:cron-${taskId}`,
              title || '定时任务执行',
              fallbackMessages as unknown as Record<string, unknown>[],
              now,
              now,
            ),
          );
          return true;
        }
        return false;
      },
      };
    },
    {
      name: STORAGE_KEYS.tasks,
      storage: zustandStorage,
      // 定时触发记录源自 nanobot 磁盘审计文件，每次拉取即最新快照，
      // 无需持久化（避免重启后残留过期的「运行中」状态）
      partialize: (s) => ({
        tasks: s.tasks,
        runs: s.runs.filter((r) => r.trigger === 'manual'),
      }),
      // 重启后不可能存在仍在执行的运行：rehydrate 时把遗留的 running 记录
      // 收敛为「已中断」，避免任务卡片与运行记录永远停留在「运行中」
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Pick<TasksState, 'tasks' | 'runs'>>;
        const now = nowIso();
        return {
          ...current,
          tasks: p.tasks ?? current.tasks,
          runs: (p.runs ?? current.runs).map((r) =>
            r.status === 'running'
              ? { ...r, status: 'error' as const, error: '已中断', finishedAt: now }
              : r,
          ),
        };
      },
    },
  ),
);
