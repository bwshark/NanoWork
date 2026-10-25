/**
 * RRULE 降级（`src/lib/task/rrule.ts`，FR-5.4）。
 *
 * 这组用例守的是**时间语义**，写错了不会崩、只会「在错误的时间跑」或「永不跑」：
 * 1. **降级矩阵**：能表达的要降成**正确**的 cron / interval（不是「差不多」的）；
 * 2. **明确拒绝**：cron 表达不了的规则必须带一句人能读懂的原因被拒——绝不能
 *    「尽力猜一个」再静默跑偏（设计 §15.3 要求降级必须显式）；
 * 3. **`UNTIL`** 要落到窗口上界（cron 没有截止概念，漏掉它会永远跑下去）。
 *
 * ⚠️ 其中 `FREQ=MINUTELY` 一条是**真实踩过的错**：默认把「分」当成 `0`，
 * 于是「每分钟」被降成 `0 * * * *`（每小时一次），差 60 倍且不报错。
 */

import { describe, expect, it } from 'vitest';
import { describeRrule, lowerRrule, parseRrule } from '../src/lib/task/rrule';

/** 降级成功时取 cron 表达式（失败即抛，避免用例里散落类型收窄） */
function cron(rrule: string): string {
  const lowered = lowerRrule(rrule);
  if (!lowered.ok) throw new Error(`预期可降级，实际被拒：${lowered.reason}`);
  if (lowered.schedule.kind !== 'cron') {
    throw new Error(`预期降成 cron，实际是 ${lowered.schedule.kind}`);
  }
  return lowered.schedule.expr;
}

/** 降级失败时取原因（成功即抛） */
function reason(rrule: string): string {
  const lowered = lowerRrule(rrule);
  if (lowered.ok) throw new Error(`预期被拒，实际降成 ${JSON.stringify(lowered.schedule)}`);
  return lowered.reason;
}

describe('lowerRrule：能表达的规则要降成正确的 cron', () => {
  it('每周一/三/五 09:00', () => {
    expect(cron('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0')).toBe('0 9 * * 1,3,5');
  });

  it('每月 1、15、28 日 09:00 —— **设计文档说这条要拆 3 个任务，其实一条 cron 就够**', () => {
    // cron 的「日」字段本来就支持逗号枚举，拆任务只会让「一个任务」变成 N 个 job
    expect(cron('FREQ=MONTHLY;BYMONTHDAY=1,15,28;BYHOUR=9')).toBe('0 9 1,15,28 * *');
  });

  it('每天 09:30', () => {
    expect(cron('FREQ=DAILY;BYHOUR=9;BYMINUTE=30')).toBe('30 9 * * *');
  });

  it('每小时整点', () => {
    expect(cron('FREQ=HOURLY')).toBe('0 * * * *');
  });

  it('**每分钟**（曾经降错成 `0 * * * *` 的那条）', () => {
    expect(cron('FREQ=MINUTELY')).toBe('* * * * *');
  });

  it('每 15 分钟', () => {
    expect(cron('FREQ=MINUTELY;INTERVAL=15')).toBe('*/15 * * * *');
  });

  it('每 6 小时', () => {
    expect(cron('FREQ=HOURLY;INTERVAL=6')).toBe('0 */6 * * *');
  });

  it('每年 3 月 15 日 09:00', () => {
    expect(cron('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15;BYHOUR=9')).toBe('0 9 15 3 *');
  });

  it('每月所有周一 09:00（纯 BYDAY，不带序数）', () => {
    expect(cron('FREQ=MONTHLY;BYDAY=MO;BYHOUR=9')).toBe('0 9 * * 1');
  });

  it('周日要落成 cron 的 0（不是 7）', () => {
    expect(cron('FREQ=WEEKLY;BYDAY=SU;BYHOUR=8')).toBe('0 8 * * 0');
  });

  it('「每 n 天」走引擎原生的固定间隔（cron 的 `*/n` 跨月会错位）', () => {
    const lowered = lowerRrule('FREQ=DAILY;INTERVAL=2;BYHOUR=9');
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.schedule).toEqual({ kind: 'interval', minutes: 2 * 24 * 60 });
    // 降级是「近似」的，必须把差异说出来
    expect(lowered.note).toContain('每 2 天');
  });

  it('容错：小写、`RRULE:` 前缀、片段顺序任意', () => {
    expect(cron('rrule:byhour=9;byminute=0;freq=daily')).toBe('0 9 * * *');
  });
});

describe('lowerRrule：cron 表达不了的要**明确拒绝并给出原因**', () => {
  it('COUNT=（cron 没有次数概念）', () => {
    expect(reason('FREQ=DAILY;COUNT=5')).toContain('COUNT');
  });

  it('序数星期（每月第一个周一）', () => {
    const r = reason('FREQ=MONTHLY;BYDAY=1MO;BYHOUR=9');
    expect(r).toContain('序数星期');
    expect(r).toContain('第 N 个');
  });

  it('负数 BYMONTHDAY（月末）', () => {
    expect(reason('FREQ=MONTHLY;BYMONTHDAY=-1')).toContain('月末');
  });

  it('每 2 周 / 每 2 月 / 每 2 年（cron 无「隔 n」）', () => {
    expect(reason('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')).toContain('每 2 周');
    expect(reason('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1')).toContain('每 2 个月');
    expect(reason('FREQ=YEARLY;INTERVAL=2;BYMONTH=1;BYMONTHDAY=1')).toContain('每 2 年');
  });

  it('步长不整除（会与自然单位错开）', () => {
    expect(reason('FREQ=MINUTELY;INTERVAL=7')).toContain('整除 60');
    expect(reason('FREQ=HOURLY;INTERVAL=5')).toContain('整除 24');
  });

  it('信息不足的规则（WEEKLY 缺 BYDAY、MONTHLY 缺日/周、YEARLY 缺 BYMONTH）', () => {
    expect(reason('FREQ=WEEKLY')).toContain('必须指定 BYDAY');
    expect(reason('FREQ=MONTHLY')).toContain('BYMONTHDAY');
    expect(reason('FREQ=YEARLY;BYMONTHDAY=1')).toContain('BYMONTH');
  });

  it('自相矛盾的组合（MINUTELY+BYHOUR / HOURLY+BYHOUR）', () => {
    expect(reason('FREQ=MINUTELY;BYHOUR=9')).toContain('BYHOUR');
    expect(reason('FREQ=HOURLY;BYHOUR=9')).toContain('BYHOUR');
  });

  it('完全不支持的部件（BYWEEKNO 等）', () => {
    expect(reason('FREQ=YEARLY;BYWEEKNO=1')).toContain('BYWEEKNO');
  });
});

describe('parseRrule：非法输入要报出「哪里非法」', () => {
  it('空 / 缺 FREQ / 片段没有等号', () => {
    expect(parseRrule('')).toEqual({ error: 'RRULE 为空' });
    expect(parseRrule('BYHOUR=9')).toEqual({ error: '缺少 FREQ' });
    expect(parseRrule('FREQ=DAILY;BYHOUR')).toMatchObject({ error: expect.stringContaining('=') });
  });

  it('越界取值', () => {
    expect(parseRrule('FREQ=DAILY;BYHOUR=24')).toMatchObject({ error: expect.stringContaining('BYHOUR') });
    expect(parseRrule('FREQ=DAILY;BYMINUTE=60')).toMatchObject({ error: expect.stringContaining('BYMINUTE') });
    expect(parseRrule('FREQ=WEEKLY;BYDAY=XX')).toMatchObject({ error: expect.stringContaining('未知星期') });
    expect(parseRrule('FREQ=DAILY;INTERVAL=0')).toMatchObject({ error: expect.stringContaining('INTERVAL') });
  });
});

describe('UNTIL → 窗口上界（cron 没有截止概念，漏掉它会永远跑下去）', () => {
  it('UTC 形态原样转 ISO', () => {
    const lowered = lowerRrule('FREQ=DAILY;BYHOUR=9;UNTIL=20261101T000000Z');
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.until).toBe('2026-11-01T00:00:00Z');
  });

  it('只给日期的形态取**当天结束**（`UNTIL` 是含边界，否则当天 09:00 那次会被误判过期）', () => {
    const lowered = lowerRrule('FREQ=DAILY;BYHOUR=9;UNTIL=20261101');
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.until).toBe('2026-11-01T23:59:59');
  });

  it('带时区偏移的形态也能解析', () => {
    const lowered = lowerRrule('FREQ=DAILY;UNTIL=20261101T000000+0800');
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(Number.isNaN(Date.parse(lowered.until as string))).toBe(false);
  });

  it('无法解析的 UNTIL 直接拒绝（不猜日期）', () => {
    expect(reason('FREQ=DAILY;UNTIL=下个月')).toContain('UNTIL');
  });
});

describe('describeRrule：列表文案', () => {
  it('说人话，而不是把 RRULE 原样丢给用户', () => {
    expect(describeRrule('FREQ=MONTHLY;BYMONTHDAY=1,15,28;BYHOUR=9')).toBe('月 1,15,28 日 09:00');
    expect(describeRrule('FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0')).toBe('周 一、三 09:00');
    expect(describeRrule('FREQ=DAILY;INTERVAL=2;BYHOUR=9')).toBe('每 2 天 09:00');
  });

  it('解析不了时退回原文（不显示半句中文）', () => {
    expect(describeRrule('FREQ=NOPE')).toBe('RRULE: FREQ=NOPE');
  });
});
