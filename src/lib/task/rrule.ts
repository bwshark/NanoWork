/**
 * RFC 5545 `RRULE` → **引擎可执行的调度**（FR-5.4）。
 *
 * ## 为什么需要「降级」而不是直接支持
 *
 * 真实调度在引擎侧（nanobot 的 `CronService`），而它只认三种形态：
 * `at`（单次）/ `every`（固定间隔）/ `cron`（5 段表达式，croniter 语义）。
 * 引擎仓库是**只读的**（`nanobot/` 有独立 git 且对象库受损，且约定不新增
 * `[LOCAL PATCH]`），所以 RRULE 必须由前端**降级**成上面三种之一。
 *
 * 设计文档 `nanowork-prd-design-v2.md` §15.3 要求「这个降级必须**显式**：UI 要告知用户
 * 『当前引擎不支持该规则，已展开为 N 条任务』」。本模块把「能不能降级、降成什么」
 * 收成一个纯函数，于是 UI 与同步链路读的是同一个结论，不会各判各的。
 *
 * ⚠️ **对设计文档的一处纠正**：§15.3 举的例子是
 * `FREQ=MONTHLY;BYMONTHDAY=1,15,28`「无法用单条 cron 表达 → 拆成 3 条 cron job」。
 * 这个前提**不成立**——cron 的「日」字段本来就支持逗号枚举，`0 9 1,15,28 * *` 就是它。
 * 真需要拆任务的是**序数星期**（`BYDAY=1MO` 表示「每月第一个周一」）与
 * `INTERVAL>1` 的周期（「每两周」），这两类 cron 根本表达不了，拆也没用。
 * 因此本实现**不拆任务**（拆任务会让「一个任务」变成 N 个 job，连带 enable/disable、
 * 删除、运行留痕、幂等合并全部要跟着改），而是：能降级的降成单条 cron / interval，
 * 不能降级的**明确拒绝并给出原因**，由表单在录入时就拦住。
 *
 * ## 支持的子集（超出即为「不可降级」，不静默猜测）
 *
 * | FREQ | 要求 | 降级结果 |
 * |---|---|---|
 * | `MINUTELY` | `INTERVAL` 整除 60 | cron `分 步长` |
 * | `HOURLY` | `INTERVAL` 整除 24 | cron `分 时步长` |
 * | `DAILY` | `INTERVAL=1` | cron `分 时 * * *` |
 * | `DAILY` | `INTERVAL>1` 且未指定 `BYHOUR` | `{kind:'interval'}`（每 n 天） |
 * | `WEEKLY` | 必填 `BYDAY`（纯星期名）、`INTERVAL=1` | cron `分 时 * * 周列表` |
 * | `MONTHLY` | 必填 `BYMONTHDAY`（正数）或纯 `BYDAY`、`INTERVAL=1` | cron `分 时 日列表 * *` |
 * | `YEARLY` | 必填 `BYMONTH` + （`BYMONTHDAY` 或纯 `BYDAY`）、`INTERVAL=1` | cron `分 时 日 月 列表` |
 *
 * **不支持（明确拒绝）**：`COUNT=`（cron 无次数语义）、序数 `BYDAY`（`1MO` / `-1SU`）、
 * 负数 `BYMONTHDAY`（`-1` = 月末）、`BYWEEKNO` / `BYYEARDAY` / `BYSETPOS` / `WKST`、
 * 以及 `INTERVAL>1` 的 WEEKLY / MONTHLY / YEARLY（cron 无「隔 n 周/月」）。
 *
 * `UNTIL=` **可降级**：它不改变触发时刻，只是有效期上界。它的值随结果一起返回，
 * 由调用方写进 `TaskConfig.validUntil`（`cron` 没有「截止」概念，必须落到窗口字段）。
 */

import type { TaskSchedule } from '@/types';

/** 支持的 `FREQ` 取值（数组与类型共用一份数据，避免两处漂移） */
const RRULE_FREQS = ['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;

/** `FREQ` 的字面量联合 */
type RruleFreq = (typeof RRULE_FREQS)[number];

/** `includes` 不做类型收窄，故用类型谓词（否则 `freq` 一直是 `string`） */
function isRruleFreq(value: string): value is RruleFreq {
  return (RRULE_FREQS as readonly string[]).includes(value);
}

/** 解析后的 RRULE 各部件（`BY*` 一律是**已去重且升序**的数字/星期列表） */
export interface RruleParts {
  freq: RruleFreq;
  interval: number;
  byMinute: number[];
  byHour: number[];
  /** 星期，0=周日 … 6=周六（已展开 `SU`…`SA`） */
  byDay: string[];
  /** 原始 `BYDAY` 文本（用于识别序数形态并给出准确报错） */
  byDayRaw: string[];
  byMonthDay: number[];
  byMonth: number[];
  /** `UNTIL` 规范化后的 ISO 字符串（可被 `Date.parse`） */
  until?: string;
  count?: number;
}

/** 降级成功 */
export interface RruleLowered {
  ok: true;
  /** 引擎可执行的调度（cron 或 interval） */
  schedule: TaskSchedule;
  /** 由 `UNTIL` 推出的有效期上界（ISO）；调用方应写进 `TaskConfig.validUntil` */
  until?: string;
  /** 可选的用户可见说明（如「已按固定间隔表达」） */
  note?: string;
}

/** 降级失败：**必须**带上人能读懂的原因（UI 要原样展示，不能只说「不支持」） */
export interface RruleRejected {
  ok: false;
  reason: string;
}

export type RruleLowerResult = RruleLowered | RruleRejected;

/** 星期名 → cron 的 day-of-week 数字（0=周日，与 `nextCronRunMs` 的取值一致） */
const WEEKDAY_NUM: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/** `UNTIL` 允许的两种形态：`YYYYMMDDTHHMMSSZ`（UTC）与 `YYYYMMDD`（全天） */
function parseUntil(raw: string): string | null {
  const utc = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (utc) {
    const iso = `${utc[1]}-${utc[2]}-${utc[3]}T${utc[4]}:${utc[5]}:${utc[6]}Z`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  const dateOnly = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    // 全天形态按**当地当天结束**理解：RFC 5545 里 `UNTIL` 是「含」的边界，
    // 取 23:59:59 才不会把当天 09:00 的那次触发误判成过期
    const iso = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T23:59:59`;
    return Number.isNaN(new Date(iso).getTime()) ? null : iso;
  }
  // 带时区偏移的形态（`20261101T000000+0800`）也接受，交给 Date.parse 判合法性
  const offset = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})([+-]\d{4})$/);
  if (offset) {
    const iso = `${offset[1]}-${offset[2]}-${offset[3]}T${offset[4]}:${offset[5]}:${offset[6]}${offset[7].slice(0, 3)}:${offset[7].slice(3)}`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  return null;
}

/** 解析 `BYHOUR` / `BYMINUTE` / `BYMONTHDAY` / `BYMONTH` 的整数列表 */
function parseIntList(
  raw: string,
  min: number,
  max: number,
  allowNegative: boolean,
): number[] | null {
  const out = new Set<number>();
  for (const token of raw.split(',')) {
    if (!/^-?\d+$/.test(token)) return null;
    const value = Number(token);
    if (value < 0 && !allowNegative) return null;
    if (Math.abs(value) < min || Math.abs(value) > max) return null;
    out.add(value);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 解析 RRULE 字符串。**任一部件非法即整体失败**（不部分采纳——半个规则比没有规则更危险）。
 */
export function parseRrule(rrule: string): RruleParts | { error: string } {
  const raw = (rrule ?? '').trim().toUpperCase();
  if (raw === '') return { error: 'RRULE 为空' };
  // RFC 5545 的完整形态允许 `RRULE:` 前缀，容忍用户粘贴过来
  const body = raw.startsWith('RRULE:') ? raw.slice('RRULE:'.length) : raw;

  const fields = new Map<string, string>();
  for (const part of body.split(';')) {
    if (part.trim() === '') continue;
    const eq = part.indexOf('=');
    if (eq <= 0) return { error: `片段「${part}」缺少「=」` };
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (value === '') return { error: `「${key}」的值为空` };
    fields.set(key, value);
  }

  const unsupported = ['BYWEEKNO', 'BYYEARDAY', 'BYSETPOS', 'WKST'].filter((k) => fields.has(k));
  if (unsupported.length > 0) {
    return { error: `暂不支持 ${unsupported.join(' / ')}（cron 无法表达）` };
  }

  const freq = fields.get('FREQ');
  if (freq === undefined) return { error: '缺少 FREQ' };
  if (!isRruleFreq(freq)) {
    return { error: `不支持的 FREQ=「${freq}」（支持 ${RRULE_FREQS.join(' / ')}）` };
  }

  let interval = 1;
  const intervalRaw = fields.get('INTERVAL');
  if (intervalRaw !== undefined) {
    if (!/^\d+$/.test(intervalRaw) || Number(intervalRaw) < 1) {
      return { error: `INTERVAL=「${intervalRaw}」非法（需 ≥1 的整数）` };
    }
    interval = Number(intervalRaw);
  }

  let count: number | undefined;
  const countRaw = fields.get('COUNT');
  if (countRaw !== undefined) {
    if (!/^\d+$/.test(countRaw) || Number(countRaw) < 1) {
      return { error: `COUNT=「${countRaw}」非法（需 ≥1 的整数）` };
    }
    count = Number(countRaw);
  }

  let until: string | undefined;
  const untilRaw = fields.get('UNTIL');
  if (untilRaw !== undefined) {
    const parsed = parseUntil(untilRaw);
    if (parsed === null) return { error: `UNTIL=「${untilRaw}」无法解析（支持 YYYYMMDD 或 YYYYMMDDTHHMMSSZ）` };
    until = parsed;
  }

  const byMinute = fields.has('BYMINUTE')
    ? parseIntList(fields.get('BYMINUTE') as string, 0, 59, false)
    : [];
  if (byMinute === null) return { error: `BYMINUTE=「${fields.get('BYMINUTE')}」非法（0-59）` };

  const byHour = fields.has('BYHOUR')
    ? parseIntList(fields.get('BYHOUR') as string, 0, 23, false)
    : [];
  if (byHour === null) return { error: `BYHOUR=「${fields.get('BYHOUR')}」非法（0-23）` };

  const byMonthDay = fields.has('BYMONTHDAY')
    ? parseIntList(fields.get('BYMONTHDAY') as string, 1, 31, true)
    : [];
  if (byMonthDay === null) return { error: `BYMONTHDAY=「${fields.get('BYMONTHDAY')}」非法（±1-31）` };

  const byMonth = fields.has('BYMONTH')
    ? parseIntList(fields.get('BYMONTH') as string, 1, 12, false)
    : [];
  if (byMonth === null) return { error: `BYMONTH=「${fields.get('BYMONTH')}」非法（1-12）` };

  const byDayRaw = fields.has('BYDAY') ? (fields.get('BYDAY') as string).split(',') : [];
  const byDay: string[] = [];
  for (const day of byDayRaw) {
    // 序数形态（`1MO` / `-1SU`）在此**不拒绝**，留给 `lowerRrule` 给出更贴切的报错
    // （「每月第一个周一」是常见诉求，只说「BYDAY 非法」用户无法理解）
    const ordinal = day.match(/^([+-]?\d+)([A-Z]{2})$/);
    const weekday = ordinal ? ordinal[2] : day;
    if (!(weekday in WEEKDAY_NUM)) {
      return { error: `BYDAY 含未知星期「${day}」（支持 SU/MO/TU/WE/TH/FR/SA，或 1MO 这类序数）` };
    }
    byDay.push(day);
  }

  return {
    freq,
    interval,
    byMinute,
    byHour,
    byDay,
    byDayRaw,
    byMonthDay,
    byMonth,
    ...(until ? { until } : {}),
    ...(count !== undefined ? { count } : {}),
  };
}

/** 把「星期名列表」转成 cron 的 day-of-week 字段（0=周日） */
function toCronDow(byDay: string[]): number[] | null {
  const nums: number[] = [];
  for (const day of byDay) {
    const n = WEEKDAY_NUM[day];
    if (n === undefined) return null;
    nums.push(n);
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** `[1,5,28]` → `1,5,28` */
function list(values: number[]): string {
  return values.join(',');
}

/** 分钟/小时字段：空列表 → 默认值；`interval` 用到时由调用方单独拼 */
function timeFields(parts: RruleParts): { minute: string; hour: string } {
  const minute = parts.byMinute.length > 0 ? list(parts.byMinute) : '0';
  const hour = parts.byHour.length > 0 ? list(parts.byHour) : '0';
  return { minute, hour };
}

/**
 * 把 RRULE 降级为引擎可执行的调度。
 *
 * 返回**要么**可执行调度（可能附带 `UNTIL` 推出的 `validUntil`），**要么**一句人能读懂的
 * 拒绝原因。刻意不做「尽力而为」的猜测：猜错的调度会在用户不知情的时候按错误的时间跑。
 */
export function lowerRrule(rrule: string): RruleLowerResult {
  const parsed = parseRrule(rrule);
  if ('error' in parsed) return { ok: false, reason: parsed.error };
  const parts = parsed;

  if (parts.count !== undefined) {
    return {
      ok: false,
      reason: 'COUNT=（限定执行次数）无法降级：引擎的 cron 没有次数概念，请改用 UNTIL= 指定截止日期',
    };
  }

  const ordinal = parts.byDayRaw.find((d) => /^[+-]?\d+[A-Z]{2}$/.test(d));
  if (ordinal) {
    return {
      ok: false,
      reason: `序数星期「${ordinal}」（如每月第一个周一）无法降级：cron 只支持「所有周一」，不支持「第 N 个」`,
    };
  }
  if (parts.byMonthDay.some((d) => d < 0)) {
    return {
      ok: false,
      reason: '负数 BYMONTHDAY（如 -1 表示月末）无法降级：cron 的日字段只能是 1-31',
    };
  }

  const { minute, hour } = timeFields(parts);
  const withUntil = (schedule: TaskSchedule, note?: string): RruleLowered => ({
    ok: true,
    schedule,
    ...(parts.until ? { until: parts.until } : {}),
    ...(note ? { note } : {}),
  });
  const tooFine = (unit: string, per: number): RruleRejected => ({
    ok: false,
    reason: `INTERVAL=${parts.interval} 无法用 ${unit}表达：cron 的步长要整除 ${per}，否则会与自然${unit}错开`,
  });

  switch (parts.freq) {
    case 'MINUTELY': {
      // 分钟粒度的规则里再出现「时 / 日 / 月 / 周」是自相矛盾的，明确拒绝而不是猜
      if (parts.byHour.length > 0) {
        return { ok: false, reason: 'MINUTELY 不能与 BYHOUR 组合（分钟粒度下「限定小时」等于每天一次），请改用 DAILY' };
      }
      if (parts.interval === 1) {
        // ⚠️ 默认不能取 `minute`（那是 `0`）：`FREQ=MINUTELY` 是**每分钟**，
        // 写成 `0 * * * *` 就变成每小时一次了（差 60 倍，且不报错）
        const minuteField = parts.byMinute.length > 0 ? list(parts.byMinute) : '*';
        return withUntil({ kind: 'cron', expr: `${minuteField} * * * *` });
      }
      if (parts.byMinute.length > 0) {
        return { ok: false, reason: `MINUTELY;INTERVAL=${parts.interval} 不能与 BYMINUTE 组合` };
      }
      if (60 % parts.interval !== 0) return tooFine('分钟', 60);
      return withUntil({ kind: 'cron', expr: `*/${parts.interval} * * * *` });
    }

    case 'HOURLY': {
      if (parts.byHour.length > 0) {
        return { ok: false, reason: 'HOURLY 不能与 BYHOUR 组合（「每小时」再限定小时等于每天一次），请改用 DAILY' };
      }
      if (parts.interval === 1) return withUntil({ kind: 'cron', expr: `${minute} * * * *` });
      if (24 % parts.interval !== 0) return tooFine('小时', 24);
      return withUntil({ kind: 'cron', expr: `${minute} */${parts.interval} * * *` });
    }

    case 'DAILY': {
      if (parts.interval === 1) {
        return withUntil({ kind: 'cron', expr: `${minute} ${hour} * * *` });
      }
      // 固定间隔在引擎里有原生形态（`every`），比 cron 的「隔 n 天」更准确：
      // cron 的 `*/n` 是按「月内第几天的偏移」算的，跨月会错位
      if (parts.byHour.length > 1 || parts.byMinute.length > 1) {
        return {
          ok: false,
          reason: `DAILY;INTERVAL=${parts.interval} 无法降级：固定间隔每天只能有一个时刻，请改为单次时刻或用 cron`,
        };
      }
      return withUntil(
        { kind: 'interval', minutes: parts.interval * 24 * 60 },
        `已按「每 ${parts.interval} 天」的固定间隔表达（与自然日的对齐方式略不同于日历规则）`,
      );
    }

    case 'WEEKLY': {
      if (parts.interval > 1) {
        return {
          ok: false,
          reason: `每 ${parts.interval} 周无法降级：cron 没有「隔 n 周」的表达（BYDAY 只能是星期几）`,
        };
      }
      const dow = toCronDow(parts.byDay);
      if (dow === null || dow.length === 0) {
        return { ok: false, reason: 'WEEKLY 必须指定 BYDAY（如 BYDAY=MO,WE,FR）' };
      }
      return withUntil({ kind: 'cron', expr: `${minute} ${hour} * * ${list(dow)}` });
    }

    case 'MONTHLY': {
      if (parts.interval > 1) {
        return { ok: false, reason: `每 ${parts.interval} 个月无法降级：cron 没有「隔 n 月」的表达` };
      }
      if (parts.byMonthDay.length > 0) {
        return withUntil({ kind: 'cron', expr: `${minute} ${hour} ${list(parts.byMonthDay)} * *` });
      }
      const dow = toCronDow(parts.byDay);
      if (dow === null || dow.length === 0) {
        return {
          ok: false,
          reason: 'MONTHLY 需要 BYMONTHDAY（如 BYMONTHDAY=1,15）或 BYDAY（如 BYDAY=MO 表示每月所有周一）',
        };
      }
      return withUntil({ kind: 'cron', expr: `${minute} ${hour} * * ${list(dow)}` });
    }

    case 'YEARLY': {
      if (parts.interval > 1) {
        return { ok: false, reason: `每 ${parts.interval} 年无法降级：cron 没有「隔 n 年」的表达` };
      }
      if (parts.byMonth.length === 0) {
        return { ok: false, reason: 'YEARLY 必须指定 BYMONTH（如 BYMONTH=3）' };
      }
      if (parts.byMonthDay.length > 0) {
        return withUntil({
          kind: 'cron',
          expr: `${minute} ${hour} ${list(parts.byMonthDay)} ${list(parts.byMonth)} *`,
        });
      }
      const dow = toCronDow(parts.byDay);
      if (dow === null || dow.length === 0) {
        return { ok: false, reason: 'YEARLY 需要 BYMONTHDAY 或 BYDAY' };
      }
      return withUntil({
        kind: 'cron',
        expr: `${minute} ${hour} * ${list(parts.byMonth)} ${list(dow)}`,
      });
    }
  }
}

/** 常见 RRULE 的中文描述（列表展示用；无法降级时由调用方展示 `reason`） */
export function describeRrule(rrule: string): string {
  const parsed = parseRrule(rrule);
  if ('error' in parsed) return `RRULE: ${rrule}`;
  const parts = parsed;
  const time =
    parts.byHour.length > 0 || parts.byMinute.length > 0
      ? `${(parts.byHour.length > 0 ? parts.byHour : [0])
          .map((h) => String(h).padStart(2, '0'))
          .join('/')}:${(parts.byMinute.length > 0 ? parts.byMinute : [0])
          .map((m) => String(m).padStart(2, '0'))
          .join('/')}`
      : '';
  const every = parts.interval > 1 ? `每 ${parts.interval} ` : '';
  const zhWeek = (d: string): string =>
    ({ SU: '日', MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六' })[d] ?? d;

  switch (parts.freq) {
    case 'MINUTELY':
      return `${every}分钟${time ? `（${time}）` : ''}`;
    case 'HOURLY':
      return `${every}小时${time ? ` 的 ${time}` : ''}`;
    case 'DAILY':
      return `${every}天 ${time}`.trim();
    case 'WEEKLY':
      return `${every}周 ${parts.byDay.map(zhWeek).join('、')} ${time}`.trim();
    case 'MONTHLY':
      return parts.byMonthDay.length > 0
        ? `${every}月 ${list(parts.byMonthDay)} 日 ${time}`.trim()
        : `${every}月 每周${parts.byDay.map(zhWeek).join('、')} ${time}`.trim();
    case 'YEARLY':
      return `${every}年 ${list(parts.byMonth)} 月 ${list(parts.byMonthDay)} 日 ${time}`.trim();
  }
}
