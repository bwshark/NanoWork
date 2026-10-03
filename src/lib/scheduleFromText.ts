/**
 * 从自然语言里推断执行调度（FR-5.5 补）。
 *
 * 设计纪律（与 `memoryDistill` / `taskRunStats` 同源）：
 *
 * 1. **不猜**：识别不出来就返回 `null`，由调用方保留表单默认值。「大概是要每天吧」这种猜测
 *    会变成一条**用户没设计过的自动化**，而自动化是会自己跑起来的东西 —— 猜错的代价远高于
 *    「没帮你填」（后者用户一眼就看得见，前者要等到它半夜发消息才发现）。
 * 2. **只产出引擎原生形态**（cron / interval），不产出 `rrule`：文本里的时间规则本来就能
 *    直接落到 cron，「先写 RRULE 再降级」只是多绕一圈。
 * 3. **命中即停、优先级固定**：工作日 > 每周 > 每月 > 每天 > 间隔。这几类写法在实践中互斥，
 *    固定顺序是为了让「一句话里出现多个时间词」时结果**可预测**，而不是看运气。
 * 4. **结果必须能被表单如实回显**：每天 / 单日 / 每月 / 间隔都能结构化回显；**多日与工作日
 *    只能落到 cron 原文**（`scheduleToUi` 的 `cronOverride`），这时表单会默认展开「高级」，
 *    让用户看到真正生效的那条表达式，而不是结构化控件的默认值。
 * 5. `description` 里的时刻若来自默认值，会**明说「按默认时刻」**——不把默认值伪装成用户写的。
 */

import type { TaskSchedule } from '@/types';

export interface ScheduleHint {
  /** 推断结果（引擎原生形态：cron 或 interval） */
  schedule: TaskSchedule;
  /** 命中的原文片段 —— 「凭什么这么填」的证据 */
  matched: string;
  /** 人类可读说明，可直接展示（如「每周一、周三 09:00」） */
  description: string;
}

/** 只说了「每天 / 每周几」却没说几点时的落点：与表单默认一致，且用户看得见、改得动 */
const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;

/** 星期字 → cron 的 dow（0 = 周日，与 cron 一致；「周天/周日」都归一成 0） */
const WEEKDAY_VALUES: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 0,
};

const WEEKDAY_LABELS: Readonly<Record<number, string>> = {
  0: '周日',
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
};

/**
 * 星期列表：`每周一、三、五` / `每周一三五` / `每周1,3,5`。
 *
 * 分隔符是**可选**的，但只收「单个」星期字或 1-7 —— 两个约束缺一不可：
 * - 不收分隔符 → `每周一三五` 只认到「一」；
 * - 收多字符数字 → `每周三 10 点` 里的 `10` 会被拆成周三与周日。
 * 空白**不算分隔符**：`每周一 三` 这种写法极少，而一旦允许用空白分隔，
 * 上面那条「10 点」就会漏进来。宁可只认「一」。
 */
const WEEKLY_LIST_RE =
  /每\s*(?:周|星期|礼拜)\s*((?:[一二三四五六日天]|[1-7])(?:(?:[,，、和及]\s*)?(?:[一二三四五六日天]|[1-7]))*)/;

/**
 * 星期区间：`每周一到周五`（第二个端点多半也带「周」字，所以它是可选的）。
 * 只在 a ≤ b 时当区间用，跨周界的写法（`周五到周一`）由调用方绕回成列表。
 */
const WEEKLY_RANGE_RE =
  /每\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])\s*(?:到|至|~)\s*(?:(?:周|星期|礼拜)\s*)?([一二三四五六日天1-7])/;

/** 时段词 → 该时段的锚点小时（只说了时段、没说几点时用） */
const PERIOD_ANCHORS: ReadonlyArray<{ re: RegExp; hour: number }> = [
  { re: /凌晨|深夜/, hour: 6 },
  { re: /早上|早晨|清晨|上午/, hour: 9 },
  { re: /中午|正午|午间/, hour: 12 },
  { re: /下午|午后|傍晚/, hour: 14 },
  { re: /晚上|夜里|夜间/, hour: 20 },
];

/** 命中的时刻是否属于「下午/晚上」这类需要补 12 小时的时段 */
const PM_RE = /下午|午后|傍晚|晚上|夜里|夜间/;
/** 12 点在这两个时段里指的是**零点**（凌晨 12 点 / 晚上 12 点都是 00:00） */
const MIDNIGHT_RE = /凌晨|深夜|夜里|夜间/;

/**
 * 时段词补正到 24 小时制。
 *
 * `near` 只取时刻**前面**的一小段原文 —— 传整句的话，句子里别处的一个「下午」会把
 * 一个本来无关的时刻补成 15 点。
 */
function applyPeriod(hour: number, near: string): number {
  if ((PM_RE.test(near) || MIDNIGHT_RE.test(near)) && hour === 12) return 0;
  if (PM_RE.test(near) && hour < 12) return hour + 12;
  return hour;
}

/** 中文数字 → 数值（只服务时刻与间隔，覆盖常见写法） */
const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/**
 * 中文数字 → 数值（`十` / `十一` / `二十三` / `两`）。
 *
 * 为什么非支持不可：「每天下午**三**点」若认不出 `三`，就会落到时段锚点
 * `下午 → 14:00` —— 那不是「没帮你填」，而是**填了一个错的时刻**。错填比不填坏得多。
 */
function cnNumber(text: string): number | null {
  if (!text) return null;
  if (text === '十') return 10;
  if (text.length === 1) return CN_DIGITS[text] ?? null;
  if (text.length === 2) {
    if (text[0] === '十') {
      const unit = CN_DIGITS[text[1]];
      return unit === undefined ? null : 10 + unit;
    }
    const tens = CN_DIGITS[text[0]];
    if (tens !== undefined && text[1] === '十') return tens * 10;
    return null;
  }
  if (text.length === 3 && text[1] === '十') {
    const tens = CN_DIGITS[text[0]];
    const unit = CN_DIGITS[text[2]];
    return tens === undefined || unit === undefined ? null : tens * 10 + unit;
  }
  return null;
}

/** 数字的**唯一入口**：阿拉伯与中文数字都在这里归一，各条正则不必再各判一次 */
function toNumber(token: string): number | null {
  return /^\d+$/.test(token) ? Number(token) : cnNumber(token);
}

/** 抽取时刻；抽不到返回 null（由调用方决定用默认时刻还是放弃） */
function extractTime(src: string): { hour: number; minute: number; matched: string } | null {
  const near = (index: number): string => src.slice(Math.max(0, index - 4), index);

  const colon = src.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (colon) {
    const h = Number(colon[1]);
    const m = Number(colon[2]);
    if (h <= 23 && m <= 59) {
      return { hour: applyPeriod(h, near(colon.index ?? 0)) % 24, minute: m, matched: colon[0] };
    }
  }

  // 小时支持阿拉伯与中文数字（「3 点」「三点」「十一点」）
  const dian = src.match(
    /(\d{1,2}|[零一二两三四五六七八九十]{1,3})\s*点\s*(半|一刻|三刻|(\d{1,2})\s*分?)?/,
  );
  if (dian) {
    const h = toNumber(dian[1]);
    const rawMinute =
      dian[2] === '半' ? 30 : dian[2] === '一刻' ? 15 : dian[2] === '三刻' ? 45 : Number(dian[4] ?? 0);
    if (h !== null && h <= 24 && rawMinute <= 59) {
      return { hour: applyPeriod(h, near(dian.index ?? 0)) % 24, minute: rawMinute, matched: dian[0] };
    }
  }

  // 只说了时段（「每天早上」）：用锚点小时，用户能在表单里改
  for (const { re, hour } of PERIOD_ANCHORS) {
    const hit = src.match(re);
    if (hit) return { hour, minute: 0, matched: hit[0] };
  }
  return null;
}

/** 星期组 → 去重升序的 dow 列表 */
function parseWeekdays(group: string): number[] {
  const values = new Set<number>();
  for (const ch of group) {
    const v = WEEKDAY_VALUES[ch];
    if (v !== undefined) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

function cronExpr(minute: number, hour: number, dom: string, dow: string): TaskSchedule {
  return { kind: 'cron', expr: `${minute} ${hour} ${dom} * ${dow}` };
}

function interval(minutes: number, matched: string, description: string): ScheduleHint {
  return { schedule: { kind: 'interval', minutes }, matched, description };
}

/**
 * 从文本里推断调度。识别不出来返回 `null`（**不猜**）。
 *
 * @param text 用户的原文（通常是消息正文；整个正文都会被扫）
 */
export function inferScheduleFromText(text: string): ScheduleHint | null {
  const src = (text ?? '').trim();
  if (!src) return null;

  const time = extractTime(src);
  const hour = time?.hour ?? DEFAULT_HOUR;
  const minute = time?.minute ?? DEFAULT_MINUTE;
  const at = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  // 没写时刻时明说是默认值 —— 不把默认值伪装成用户写下的东西
  const atLabel = time ? ` ${at}` : ` ${at}（按默认时刻，可改）`;

  // ① 每个工作日。放在「每周」之前：「每个工作日」里不含「每周」，但反过来
  //    「每周工作日」这种写法存在，先判它就两种情况都覆盖。
  const workday = src.match(/每\s*(?:个)?\s*工作日/);
  if (workday) {
    return {
      schedule: cronExpr(minute, hour, '*', '1-5'),
      matched: workday[0],
      description: `每个工作日${atLabel}`,
    };
  }

  // ② 每周 X。区间写法（每周一到周五）比列举更贴近原话，优先用 cron 区间
  const range = src.match(WEEKLY_RANGE_RE);
  if (range) {
    const from = WEEKDAY_VALUES[range[1]];
    const to = WEEKDAY_VALUES[range[2]];
    if (from !== undefined && to !== undefined) {
      /*
       * 跨周界的写法（`周五到周一`）要**绕回**：它指的是 {5,6,0,1}，不是 {5,1}。
       * 绕回来正好七天时直接给 `*`（`周一到周日` 就是「每天」，写 `0-6` 等价但更长）。
       * 列表保持升序：cron 实现普遍接受任意顺序，但升序是最保险的形态。
       */
      const wrapped = [0, 1, 2, 3, 4, 5, 6].filter((d) => d >= from || d <= to);
      const dow = from <= to ? `${from}-${to}` : wrapped.length === 7 ? '*' : wrapped.join(',');
      return {
        schedule: cronExpr(minute, hour, '*', dow),
        matched: range[0],
        description: `${WEEKDAY_LABELS[from]}至${WEEKDAY_LABELS[to]}${atLabel}`,
      };
    }
  }

  const weekly = src.match(WEEKLY_LIST_RE);
  if (weekly) {
    const days = parseWeekdays(weekly[1]);
    if (days.length > 0) {
      return {
        schedule: cronExpr(minute, hour, '*', days.join(',')),
        matched: weekly[0],
        description: `每${days.map((d) => WEEKDAY_LABELS[d]).join('、')}${atLabel}`,
      };
    }
    // 「每周」之后读不出星期 → 落到下面继续找，最终可能什么都不填（不猜）
  }

  // ③ 每月 N 号（含中文数字：「每月十五号」）
  const monthly = src.match(
    /每\s*(?:个)?\s*月\s*(?:的)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[号日]/,
  );
  if (monthly) {
    const dom = toNumber(monthly[1]);
    if (dom !== null && dom >= 1 && dom <= 31) {
      return {
        schedule: cronExpr(minute, hour, String(dom), '*'),
        matched: monthly[0],
        description: `每月 ${dom} 日${atLabel}`,
      };
    }
  }

  // ④ 每天 / 每日 / 每一天
  const daily = src.match(/每\s*(?:一\s*)?(?:天|日)/);
  if (daily) {
    return {
      schedule: cronExpr(minute, hour, '*', '*'),
      matched: daily[0],
      description: `每天${atLabel}`,
    };
  }

  /*
   * ⑤ 间隔（数字同样支持中文：「每半小时」「每两小时」「每五分钟」）。
   *
   * ⚠️「每 N 天 / 每 N 周」走引擎原生 `every` 而**不是** cron 的步长写法（`*` 斜杠 `N`）：
   * 日字段的步长是按「月内偏移」算的，跨月会错位（与 FR-5.4 的 RRULE 降级是同一个结论）。
   * 分钟上限与表单一致（59999）：超出就**不填**，绝不产出一个会被表单静默夹掉的数字。
   *
   * （顺带一个书写陷阱：这一段刻意不写「星号紧跟斜杠」的字面量 —— 那两个字在一行里
   * 会**提前终止这个块注释**，后面的代码全被当成语句解析，报的还是别处的语法错。）
   */
  const MAX_MINUTES = 59999;
  const NUM = '(\\d{1,4}|[一两二三四五六七八九十]{1,3})';

  const halfHour = src.match(/每\s*半\s*(?:个)?\s*小时/);
  if (halfHour) return interval(30, halfHour[0], '每半小时');

  const perMinutes = src.match(new RegExp(`每\\s*${NUM}\\s*分钟`));
  if (perMinutes) {
    const n = toNumber(perMinutes[1]);
    if (n !== null && n >= 1 && n <= MAX_MINUTES) return interval(n, perMinutes[0], `每 ${n} 分钟`);
  }

  const perHours = src.match(new RegExp(`每\\s*${NUM}\\s*(?:个)?\\s*小时`));
  if (perHours) {
    const n = toNumber(perHours[1]);
    if (n !== null && n >= 1 && n * 60 <= MAX_MINUTES) {
      return interval(n * 60, perHours[0], `每 ${n} 小时`);
    }
  }

  const hourly = src.match(/每\s*(?:个)?\s*小时/);
  if (hourly) return interval(60, hourly[0], '每小时');

  const perDays = src.match(new RegExp(`每\\s*${NUM}\\s*(?:个)?\\s*天`));
  if (perDays) {
    const n = toNumber(perDays[1]);
    if (n !== null && n >= 1 && n * 1440 <= MAX_MINUTES) {
      return interval(n * 1440, perDays[0], `每 ${n} 天`);
    }
  }

  const perWeeks = src.match(new RegExp(`每\\s*${NUM}\\s*(?:个)?\\s*(?:周|星期|礼拜)`));
  if (perWeeks) {
    const n = toNumber(perWeeks[1]);
    if (n !== null && n >= 1 && n * 7 * 1440 <= MAX_MINUTES) {
      return interval(n * 7 * 1440, perWeeks[0], `每 ${n} 周`);
    }
  }

  return null;
}
