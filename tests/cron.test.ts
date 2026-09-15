import { describe, it, expect } from 'vitest';
import { validateCron, describeSchedule } from '@/lib/cron';

describe('validateCron', () => {
  it('合法表达式通过', () => {
    expect(validateCron('0 9 * * *').valid).toBe(true);
    expect(validateCron('*/5 * * * *').valid).toBe(true);
    expect(validateCron('1-10/2 0 * * 1,5').valid).toBe(true);
  });

  it('字段数错误被拒绝', () => {
    expect(validateCron('0 9 * *').valid).toBe(false);
    expect(validateCron('').valid).toBe(false);
  });

  it('超出取值范围被拒绝', () => {
    expect(validateCron('60 * * * *').valid).toBe(false); // 分 > 59
    expect(validateCron('* 24 * * *').valid).toBe(false); // 时 > 23
    expect(validateCron('* * 32 * *').valid).toBe(false); // 日 > 31
  });

  it('非法字符被拒绝', () => {
    expect(validateCron('abc * * * *').valid).toBe(false);
    expect(validateCron('0 9 * * ?').valid).toBe(false);
  });
});

describe('describeSchedule', () => {
  it('interval < 60 分钟显示为分钟', () => {
    expect(describeSchedule({ kind: 'interval', minutes: 30 })).toBe('每 30 分钟');
  });
  it('interval >= 60 分钟显示为小时', () => {
    expect(describeSchedule({ kind: 'interval', minutes: 120 })).toBe('每 2 小时');
  });
  it('cron 显示原始表达式', () => {
    expect(describeSchedule({ kind: 'cron', expr: '0 9 * * *' })).toBe('Cron: 0 9 * * *');
  });
  it('cron 带时区时附带时区', () => {
    expect(describeSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' })).toBe(
      'Cron: 0 9 * * * (Asia/Shanghai)',
    );
  });
  it('once 显示单次执行时间', () => {
    const at = new Date('2026-08-20T09:30:00').toISOString();
    expect(describeSchedule({ kind: 'once', at })).toContain('单次');
  });
});
