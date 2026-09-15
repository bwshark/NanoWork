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
  /** 工具执行行总数 */
  steps: number;
  /** 仍在执行中的行数 */
  running: number;
  /** 出错行数 */
  errors: number;
  /** 深度思考段数量 */
  thinkingCount: number;
}

/** 统计过程事件：只做计数，不关心顺序（顺序由 timeline 自己保证）。 */
export function digestProcess(events: ProcessEvent[]): ProcessDigest {
  let steps = 0;
  let running = 0;
  let errors = 0;
  let thinkingCount = 0;
  for (const ev of events) {
    if (ev.kind === 'reasoning') {
      thinkingCount += 1;
      continue;
    }
    steps += 1;
    if (ev.status === 'running') running += 1;
    else if (ev.status === 'error') errors += 1;
  }
  return { steps, running, errors, thinkingCount };
}
