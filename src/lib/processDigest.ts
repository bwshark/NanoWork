import type { ProcessEvent } from '@/types';

/**
 * 过程时间线的「统计层」：把一条可能很长的过程事件列表压成几个计数。
 *
 * 时间线本身始终铺开（见 `ProcessView`），不再需要「折叠标题文案」；
 * 这里保留的用途是把**异常**提到署名头——过程铺开后失败行可能落在视野之外，
 * 「哪一轮跑挂了」是唯一值得在头行就暴露的信号。
 *
 * 统计保持**纯函数 + 可单测**，便于把口径固定下来。
 */

/**
 * 毫秒 → 人类可读时长，对齐参考形态的「已处理 33s / 1m41s」写法。
 *
 * 向上取整到秒并保底 1s：耗时 300ms 的过程显示「1s」而不是「0s」，
 * 后者看起来像计时坏了。非正数 / 非法值返回空串，由调用方决定不渲染。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) {
    // 1m41s（秒补零到两位）；整分钟不拖一个多余的 0s
    return sec === 0 ? `${totalMin}m` : `${totalMin}m${String(sec).padStart(2, '0')}s`;
  }
  const hour = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min === 0 ? `${hour}h` : `${hour}h${String(min).padStart(2, '0')}m`;
}

/** 过程统计（供署名头渲染异常提示） */
export interface ProcessDigest {
  /** 过程步骤总数：工具执行行 + 专家团成员（FR-2.4） */
  steps: number;
  /** 仍在执行中的步骤数 */
  running: number;
  /** 出错的步骤数 */
  errors: number;
  /** 深度思考段数量 */
  thinkingCount: number;
}

/**
 * 统计过程事件：只做计数，不关心顺序（顺序由 timeline 自己保证）。
 *
 * 成员按**成员**计数而不是按相位计数：一个成员会发两三条相位事件，
 * 相位相加会让「3 个成员的团」显示成「8 步」，比一个诚实的「3」更难读。
 * 状态取该成员最强的终态（失败 > 仍在跑 > 完成），与 `groupMemberEvents` 一致。
 */
export function digestProcess(events: ProcessEvent[]): ProcessDigest {
  let steps = 0;
  let running = 0;
  let errors = 0;
  let thinkingCount = 0;
  /** memberId → 是否仍在跑（false = 已收口或已失败） */
  const members = new Map<string, { running: boolean; failed: boolean }>();
  /** [LOCAL PATCH] FR-2.5：子代理同样**按个**计数，不按相位加。
   * 一次 spawn 会发「started + N 个 tool + done」，按相位相加会把「派了 1 个子代理」
   * 显示成「8 步」——比一个诚实的「1」更难读。 */
  const subagents = new Map<string, { running: boolean; failed: boolean }>();

  for (const ev of events) {
    if (ev.kind === 'reasoning') {
      thinkingCount += 1;
      continue;
    }
    if (ev.kind === 'member') {
      const cur = members.get(ev.memberId) ?? { running: false, failed: false };
      // 收口相位（finished）必须把 running 拨回 false：否则「先 started 后 finished」
      // 的成员会一直算成仍在执行，署名头永远显示「N 步执行中」。
      if (ev.phase === 'failed') {
        cur.failed = true;
        cur.running = false;
      } else if (ev.phase === 'finished') {
        cur.running = false;
      } else {
        cur.running = true;
      }
      members.set(ev.memberId, cur);
      continue;
    }
    if (ev.kind === 'subagent') {
      const cur = subagents.get(ev.subagentId) ?? { running: false, failed: false };
      // 与成员同一条判据：`done` 必须把 running 拨回 false，否则「N 步执行中」永远不消
      if (ev.phase === 'error') {
        cur.failed = true;
        cur.running = false;
      } else if (ev.phase === 'done') {
        cur.running = false;
      } else {
        cur.running = true;
      }
      subagents.set(ev.subagentId, cur);
      continue;
    }
    steps += 1;
    if (ev.status === 'running') running += 1;
    else if (ev.status === 'error') errors += 1;
  }

  for (const m of members.values()) {
    steps += 1;
    // 失败优先：一个失败的成员不该因为「之前跑过」而被算成正常步骤
    if (m.failed) errors += 1;
    else if (m.running) running += 1;
  }
  for (const a of subagents.values()) {
    steps += 1;
    if (a.failed) errors += 1;
    else if (a.running) running += 1;
  }
  return { steps, running, errors, thinkingCount };
}
