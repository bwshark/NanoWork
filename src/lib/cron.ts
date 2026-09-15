/**
 * 定时任务调度校验与描述（增强项）。
 * - `validateCron`：轻量校验标准 5 段 cron 表达式（分 时 日 月 周）的格式与取值范围；
 * - `describeSchedule`：将 TaskConfig.schedule 转为人类可读的描述，供列表展示。
 * 纯函数、无副作用，便于单测。
 */

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
export function describeSchedule(
  schedule:
    | { kind: 'cron'; expr: string; tz?: string }
    | { kind: 'interval'; minutes: number }
    | { kind: 'once'; at: string },
): string {
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
  return `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
}
