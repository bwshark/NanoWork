/**
 * 定时任务调度校验与描述（增强项）。
 * - `validateCron`：轻量校验标准 5 段 cron 表达式（分 时 日 月 周）的格式与取值范围；
 * - `describeSchedule`：将 TaskConfig.schedule 转为人类可读的描述，供列表展示；
 * - `describeValidity`：有效期窗口（FR-5.4）的描述。
 * 纯函数、无副作用，便于单测。
 */

import type { TaskSchedule } from '@/types';
import { describeRrule } from '@/lib/rrule';

/** 单字段允许形式：星号 / 星号步长 / 数字 / 区间 / 步长 / 逗号枚举，例如 星号斜杠5、1-10/2、1,15 */
const FIELD_RE = /^(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?(,\d+(-\d+)?(\/\d+)?)*)$/;

/** 各段取值范围：[分, 时, 日, 月, 周] */
const RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export interface CronCheck {
  valid: boolean;
  error?: string;
}

/** 校验 cron 表达式（5 段，空格分隔） */
export function validateCron(expr: string): CronCheck {
  const parts = (expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: 'Cron 需 5 个字段（分 时 日 月 周）' };
  }
  for (let i = 0; i < 5; i++) {
    const p = parts[i];
    if (!FIELD_RE.test(p)) {
      return { valid: false, error: `第 ${i + 1} 段「${p}」格式不合法` };
    }
    for (const token of p.split(',')) {
      const base = token.split('/')[0];
      if (base === '*') continue;
      const [loRaw, hiRaw] = base.split('-');
      const lo = Number(loRaw);
      const hi = hiRaw === undefined ? lo : Number(hiRaw);
      const [min, max] = RANGES[i];
      if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max) {
        return { valid: false, error: `第 ${i + 1} 段「${p}」超出范围` };
      }
    }
  }
  return { valid: true };
}

/** cron 单字段解析结果：允许的值集合；null 表示该字段为纯步长星号（任意值均可） */
type CronFieldMatcher = Set<number> | null;

/** 解析 cron 单字段为允许值集合；取值越界或格式非法返回 undefined */
function parseCronField(field: string, min: number, max: number): CronFieldMatcher | undefined {
  // 纯星号或星号步长：任意值均可（步长由「距最小值的偏移」在匹配时处理）
  if (field === '*' || /^\*\/\d+$/.test(field)) return null;
  const values = new Set<number>();
  for (const token of field.split(',')) {
    const m = token.match(/^(\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) return undefined;
    const lo = Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : lo;
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return undefined;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** 判断值是否匹配字段（null=任意；步长字段按「距最小值的偏移」对齐，与 croniter 一致） */
function cronFieldMatches(value: number, field: string, min: number): boolean {
  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) return (value - min) % Number(stepMatch[1]) === 0;
  const parsed = parseCronField(field, min, 1000);
  if (parsed === undefined) return false;
  return parsed === null || parsed.has(value);
}

/**
 * 计算标准 5 段 cron 表达式（分 时 日 月 周）严格晚于 fromMs 的下次触发时间戳。
 * 与 nanobot 引擎（croniter）语义一致：分钟粒度逐分钟扫描，最多前推约 5 年。
 * @param expr cron 表达式（5 段，空格分隔）
 * @param fromMs 基准时间戳（毫秒）
 * @returns 下次触发时间戳（毫秒）；表达式非法或 5 年内无匹配返回 null
 */
export function nextCronRunMs(expr: string, fromMs: number): number | null {
  const parts = (expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [fMin, fHour, fDom, fMon, fDow] = parts;
  // 预校验各段格式与范围，避免无效表达式进入逐分钟扫描
  if (
    parseCronField(fMin, 0, 59) === undefined ||
    parseCronField(fHour, 0, 23) === undefined ||
    parseCronField(fDom, 1, 31) === undefined ||
    parseCronField(fMon, 1, 12) === undefined ||
    parseCronField(fDow, 0, 7) === undefined
  ) {
    return null;
  }
  // 对齐到下一分钟起点（严格晚于基准时间）
  const cursor = new Date(fromMs);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  // 约 5 年的分钟数上限，防止病态表达式导致死循环
  const MAX_ITERATIONS = 5 * 366 * 24 * 60;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const month = cursor.getMonth() + 1; // 1-12
    const dom = cursor.getDate();
    const dow = cursor.getDay(); // 0=周日
    const hour = cursor.getHours();
    const minute = cursor.getMinutes();
    const dowOk = cronFieldMatches(dow, fDow, 0) || (dow === 0 && cronFieldMatches(7, fDow, 0));
    if (
      cronFieldMatches(minute, fMin, 0) &&
      cronFieldMatches(hour, fHour, 0) &&
      cronFieldMatches(dom, fDom, 1) &&
      cronFieldMatches(month, fMon, 1) &&
      dowOk
    ) {
      return cursor.getTime();
    }
    cursor.setMinutes(minute + 1);
  }
  return null;
}

/** 将调度配置转为人类可读的描述 */
export function describeSchedule(schedule: TaskSchedule): string {
  if (schedule.kind === 'interval') {
    const m = schedule.minutes;
    if (m >= 60) {
      const h = m / 60;
      return Number.isInteger(h) ? `每 ${h} 小时` : `每 ${m} 分钟`;
    }
    return `每 ${m} 分钟`;
  }
  if (schedule.kind === 'once') {
    const d = new Date(schedule.at);
    return Number.isNaN(d.getTime())
      ? '单次执行'
      : `单次 · ${d.toLocaleString()} 执行`;
  }
  if (schedule.kind === 'rrule') {
    // RRULE 是**本层的表达形态**，展示时直接用 `describeRrule` 说人话
    // （`FREQ=MONTHLY;BYMONTHDAY=1,15,28;BYHOUR=9` → 「每月 1,15,28 日 09:00」），
    // 降级成 cron 是下发引擎时才做的事，不该泄漏到 UI 文案里
    return describeRrule(schedule.rrule);
  }
  return `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
}

/**
 * 有效期窗口的中文描述（FR-5.4）；两侧都空时返回 `''`（调用方据此不显示这一行）。
 *
 * 与 `describeSchedule` 分开的原因：窗口是**任务的属性**（`TaskConfig`），
 * 不是调度的属性；混在一起会让「只在某个区间生效」这件事看起来像调度的一部分。
 */
export function describeValidity(validFrom?: string, validUntil?: string): string {
  const from = validFrom ? new Date(validFrom) : null;
  const until = validUntil ? new Date(validUntil) : null;
  const fromOk = from !== null && !Number.isNaN(from.getTime());
  const untilOk = until !== null && !Number.isNaN(until.getTime());
  if (!fromOk && !untilOk) return '';
  if (fromOk && untilOk) return `${fmtDate(from as Date)} 至 ${fmtDate(until as Date)}`;
  if (fromOk) return `${fmtDate(from as Date)} 起`;
  return `${fmtDate(until as Date)} 截止`;
}

/** 窗口展示用的日期格式（本地时区，精确到分钟） */
function fmtDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
