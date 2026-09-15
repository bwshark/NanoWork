/**
 * 全局 cron 运行记录轮询器（幂等）。
 *
 * 为什么需要在全局而不是只在 TasksPage 内轮询：
 * 已执行的定时任务需在「默认工作空间」会话列表中自动出现，该逻辑由
 * tasksStore.fetchCronRuns 负责——它既刷新运行记录、又自动创建执行会话。
 * 若轮询仅挂载在 TasksPage，用户不打开定时任务页时引擎已完成的任务不会同步，
 * 会话列表便不会自动出现对应条目。
 *
 * 因此将轮询提升为应用级（main.tsx 启动时调用一次），TasksPage 不再自行起定时器。
 * 轮询间隔取 15s，与历史 TasksPage 内设定一致；进程内幂等。
 */

import { useTasksStore } from '@/stores/tasksStore';

/** 轮询间隔（毫秒）：与历史 TasksPage 内 interval 一致 */
const CRON_RUNS_POLL_MS = 15_000;

/** 是否已启动（幂等：重复调用只启动一次） */
let started = false;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动全局 cron 运行记录轮询（幂等：重复调用只启动一次）。
 * 应在应用启动、store 初始化后调用一次（见 main.tsx）。
 */
export function startCronRunsPoller(): void {
  if (started) return;
  started = true;
  // 启动即拉取一次，覆盖订阅/定时器注册前已产生的执行留痕
  void useTasksStore.getState().fetchCronRuns();
  timer = setInterval(() => {
    void useTasksStore.getState().fetchCronRuns();
  }, CRON_RUNS_POLL_MS);
}
