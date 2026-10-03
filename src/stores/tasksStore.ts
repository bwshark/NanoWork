import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { platform, zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { ensureMetaList, withTombstone, withoutTombstone } from '@/lib/syncMeta';
import { metaForDelete, metaForEdit, metaForNew } from '@/lib/syncStamp';
import { toast } from '@/components/Toast';
import { getRuntime } from '@/ai/runtime';
import { cronRecordsToSession } from '@/lib/sessionImport';
import { useSessionsStore } from '@/stores/sessionsStore';
import type {
  SyncTombstones,
  TaskConfig,
  TaskRunRecord,
  TaskSchedule,
  TaskStatus,
} from '@/types';

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
  /**
   * 已删除条目的墓碑表（`id → 删除元数据`）。
   * 与 `tasks` 分开存，理由同 `agentsStore.tombstones`。
   */
  tombstones: SyncTombstones;
  /** 运行记录（倒序：最新在前；含本地测试运行与 nanobot 定时触发） */
  runs: TaskRunRecord[];
  /** 最近一次同步结果 */
  lastSync: TaskSyncSummary | null;
  /** 是否正在同步到 nanobot */
  syncing: boolean;
  /**
   * 新增或按 `id` 幂等合并任务。
   *
   * @returns 落库的任务；**该 `id` 已被删除（有墓碑）时返回 `null`**，调用方需处理
   *   ——这条路径真实存在：引擎侧 cron job 的镜像（`cronTaskMirror`）会把 nanobot
   *   的任务重放进来，而用户可能刚把它删掉。
   */
  addTask: (partial?: Partial<TaskConfig>) => TaskConfig | null;
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
      tombstones: {},
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
          const merged: TaskConfig = {
            ...existing,
            ...patch,
            id,
            createdAt: existing.createdAt,
            ...metaForEdit(existing),
          };
          set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? merged : t)) }));
          scheduleAutoSync();
          return merged;
        }

        // 没有存活条目，但该 id 有墓碑 = 「这条已经被删过，现在又要被建回来」。
        // 唯一现实来源是引擎侧 job 的镜像（cronTaskMirror）：nanobot 的 job 还没被
        // 清理干净，或聊天历史在重放。删除是**显式事实**，不因重放而复活——否则
        // 用户会看到「删了又回来」，且每删一次就多一条同 id 记录。
        if (id in get().tombstones) return null;

        const task: TaskConfig = {
          /*
           * ⚠️ **先铺开草稿**：可选字段（`runOptions` / `delivery` / `validFrom` /
           * `validUntil`，以及将来新增的）一律照搬，再由下面几行覆盖「store 自管」的键。
           *
           * 曾经这里逐个列举可选字段——那是**静默丢字段**的经典写法：生效区间与结果推送
           * 都在这里被丢掉过，而且单测全绿（表单草稿是对的、同步接线也是对的，只有中间
           * 这一段漏了），只有真机验证才现形。
           */
          ...partial,
          id,
          name: partial?.name ?? '新任务',
          schedule,
          prompt: partial?.prompt ?? '',
          agentId: partial?.agentId ?? '',
          status: partial?.status ?? 'enabled',
          createdAt: nowIso(),
          // 同步元数据由 store 独占（草稿不得决定版本号与墓碑状态），故排在铺开之后
          ...metaForNew(),
        };
        set((s) => ({
          tasks: [...s.tasks, task],
          // 同 id 重新出现 = 「删除后又建回来」：清掉旧墓碑（理由同 agentsStore.createAgent）
          tombstones: withoutTombstone(s.tombstones, task.id),
        }));
        scheduleAutoSync();
        return task;
      },

      // 元数据在 patch 之后展开，理由同 agentsStore.updateAgent
      updateTask: (id, patch) => {
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch, ...metaForEdit(t) } : t)),
        }));
        scheduleAutoSync();
      },

      removeTask: (id) => {
        set((s) => {
          const target = s.tasks.find((t) => t.id === id);
          if (!target) return s;
          return {
            // 删除 = 摘除条目 + 留墓碑（理由同 agentsStore.removeAgent）
            tasks: s.tasks.filter((t) => t.id !== id),
            tombstones: withTombstone(s.tombstones, id, metaForDelete(target)),
          };
        });
        scheduleAutoSync();
      },

      toggleTask: (id) => {
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === id
              ? {
                  ...t,
                  status: (t.status === 'enabled' ? 'disabled' : 'enabled') as TaskStatus,
                  ...metaForEdit(t),
                }
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
          // `tasks` 天生只含存活条目（删除痕迹在 tombstones 表里），直接提交即可
          const result = await getRuntime().sync('tasks', get().tasks);
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
        let cronRuns: TaskRunRecord[];
        try {
          cronRuns = await getRuntime().listRuns({});
        } catch {
          return; // 审计目录不可读时静默跳过，不影响本地记录
        }

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
          // 前端同步保持一致）。移除方式同样是**摘除 + 留墓碑**——「这条 once 任务
          // 已经跑完并消失」这个事实要能传播到别的设备。
          const finishedIds = new Set(
            cronRuns.filter((r) => r.status !== 'running').map((r) => r.taskId),
          );
          const completed = s.tasks.filter(
            (t) => finishedIds.has(t.id) && t.schedule.kind === 'once',
          );
          const tasks =
            completed.length > 0
              ? s.tasks.filter((t) => !finishedIds.has(t.id))
              : s.tasks;
          const tombstones =
            completed.length > 0
              ? completed.reduce(
                  (acc, t) => withTombstone(acc, t.id, metaForDelete(t)),
                  s.tombstones,
                )
              : s.tombstones;

          // 定时触发记录以磁盘审计文件为准整体替换（id 带 cron- 前缀），
          // 本地测试运行记录原样保留，合并后按开始时间倒序
          const manualRuns = s.runs.filter((r) => !r.id.startsWith('cron-'));
          const merged = [...manualRuns, ...cronRuns].sort((a, b) =>
            Date.parse(b.startedAt) - Date.parse(a.startedAt),
          );
          return { tasks, tombstones, runs: merged.slice(0, RUNS_MAX) };
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
      // v1：给存量数据补同步元数据四字段（缺字段按 `LEGACY_REV` 落盘）、补空墓碑表
      version: 1,
      migrate: (persisted) => {
        const p = persisted as
          | { tasks?: TaskConfig[]; tombstones?: SyncTombstones }
          | undefined;
        return {
          tasks: ensureMetaList(p?.tasks),
          tombstones: p?.tombstones ?? {},
        };
      },
      // 定时触发记录源自 nanobot 磁盘审计文件，每次拉取即最新快照，
      // 无需持久化（避免重启后残留过期的「运行中」状态）
      partialize: (s) => ({
        tasks: s.tasks,
        tombstones: s.tombstones,
        runs: s.runs.filter((r) => r.trigger === 'manual'),
      }),
      // 重启后不可能存在仍在执行的运行：rehydrate 时把遗留的 running 记录
      // 收敛为「已中断」，避免任务卡片与运行记录永远停留在「运行中」
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<
          Pick<TasksState, 'tasks' | 'tombstones' | 'runs'>
        >;
        const now = nowIso();
        return {
          ...current,
          tasks: p.tasks ?? current.tasks,
          tombstones: p.tombstones ?? current.tombstones,
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
