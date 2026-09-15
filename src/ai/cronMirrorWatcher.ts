/**
 * cron 镜像监视器：监听 sessionsStore 状态变化，把聊天消息
 * `message.process` 中「cron 工具 add 成功」的执行行镜像进任务列表。
 *
 * 为什么用订阅扫描而不是在事件聚合点直连：
 * - 不侵入 sessionsStore（其不得 import tasksStore，避免循环依赖）；
 * - 持久化恢复（历史消息重放）后同样能兜住——以
 *   `(会话id + 消息id + 行id)` 为键的模块级 Set 去重（第一道闸），
 *   tasksStore 同 id 存在性检查为第二道闸，重放不会重复建任务。
 *
 * 扫描本身是纯内存遍历，仅在状态变化时执行，开销可接受。
 */

import { mirrorCronToolEvent } from '@/ai/cronTaskMirror';
import { useSessionsStore } from '@/stores/sessionsStore';
import type { ProcessToolRow, Session } from '@/types';

/** 已处理过的「会话:消息:行」键集合（进程内去重，跨订阅回调共享） */
const seenRowKeys = new Set<string>();

/** 监视器是否已启动（幂等：重复调用只注册一次订阅） */
let started = false;

/** 判断工具执行行是否为「cron add 成功」行 */
function isCronAddDoneRow(row: ProcessToolRow): boolean {
  return (
    row.kind === 'tool' &&
    row.tool === 'cron' &&
    row.status === 'done' &&
    row.args?.action === 'add'
  );
}

/** 遍历所有会话消息，镜像新出现的「cron add 成功」行 */
function scanSessions(sessions: Session[]): void {
  for (const session of sessions) {
    for (const message of session.messages) {
      const rows = message.process;
      if (!rows || rows.length === 0) continue;
      for (const row of rows) {
        if (row.kind !== 'tool' || !isCronAddDoneRow(row)) continue;
        // 去重键：会话 id + 消息 id + 行 id（持久化恢复重放时保持一致）
        const key = `${session.id}:${message.id}:${row.id}`;
        if (seenRowKeys.has(key)) continue;
        seenRowKeys.add(key);
        // 行 id 作为 callId：镜像内部再以引擎 job id 做存在性兜底
        mirrorCronToolEvent({
          callId: row.id,
          args: row.args,
          result: row.result,
          error: row.error,
        });
      }
    }
  }
}

/**
 * 启动 cron 镜像监视器（幂等：重复调用只注册一次）。
 * 应在应用启动、store 初始化后调用一次（见 main.tsx）。
 */
export function startCronMirrorWatcher(): void {
  if (started) return;
  started = true;
  // 启动时先扫一次当前状态（覆盖订阅注册前已就绪的消息）
  scanSessions(useSessionsStore.getState().sessions);
  // 之后每次状态变化（含持久化异步 hydration 回填）都增量扫描；
  // seenRowKeys 保证同一行只镜像一次
  useSessionsStore.subscribe((state) => {
    scanSessions(state.sessions);
  });
}
