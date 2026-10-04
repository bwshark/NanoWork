import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOG_KEEP_DAYS,
  LOG_LEVEL_RANK,
  LOG_MODULES,
  formatLogLine,
  isLogDateSegment,
  isLogLevel,
  isLogModule,
  logDateSegment,
  logDateSegmentToMs,
  logFileName,
  logRetentionCutoff,
  normalizeLogLevel,
  shouldLog,
} from '@/observability/logging';

describe('等级与模块的收敛', () => {
  it('四个等级都认，其余一律不认（不是真值判断）', () => {
    for (const lv of ['debug', 'info', 'warn', 'error']) expect(isLogLevel(lv)).toBe(true);
    // 'INFO' / '' / undefined / 对象都不算——大小写不做归一，模块名与等级都是白名单取值
    for (const bad of ['INFO', '', 'trace', undefined, null, 1, {}])
      expect(isLogLevel(bad)).toBe(false);
  });

  it('模块名白名单就是文件名取值域，未知模块不认', () => {
    expect(isLogModule('chat')).toBe(true);
    expect(isLogModule('a/b')).toBe(false);
    expect(isLogModule('../x')).toBe(false);
    expect(isLogModule('unknown-module')).toBe(false);
    // 白名单里没有空串 / 带分隔符的项——这是「不用再挡路径穿越」的前提
    for (const m of LOG_MODULES) expect(/^[a-z][a-z0-9-]*$/.test(m)).toBe(true);
  });

  it('非法等级折回 info 而不抛错（日志是旁路，不能打断业务）', () => {
    expect(normalizeLogLevel('nope')).toBe('info');
    expect(normalizeLogLevel(undefined)).toBe('info');
    expect(normalizeLogLevel(undefined, 'warn')).toBe('warn');
    expect(normalizeLogLevel('error')).toBe('error');
  });

  it('shouldLog 按权重比较，不是按字符串', () => {
    expect(shouldLog('warn', 'info')).toBe(true);
    expect(shouldLog('info', 'info')).toBe(true);
    expect(shouldLog('debug', 'info')).toBe(false);
    expect(shouldLog('error', 'debug')).toBe(true);
    // 权重的相对顺序是这条判据的全部依据，钉住它
    expect(LOG_LEVEL_RANK.debug).toBeLessThan(LOG_LEVEL_RANK.info);
    expect(LOG_LEVEL_RANK.info).toBeLessThan(LOG_LEVEL_RANK.warn);
    expect(LOG_LEVEL_RANK.warn).toBeLessThan(LOG_LEVEL_RANK.error);
  });
});

describe('日期目录与文件名', () => {
  it('日期段用**本地**日（诊断目录回答「我哪天用的」）', () => {
    // 本地时区构造，避免用例随 CI 时区漂移
    expect(logDateSegment(new Date(2026, 9, 4, 0, 5, 0))).toBe('2026-10-04');
    expect(logDateSegment(new Date(2026, 0, 1, 23, 59, 59))).toBe('2026-01-01');
  });

  it('只有 YYYY-MM-DD 是合法日期段（清理时挡掉用户自己放的东西）', () => {
    expect(isLogDateSegment('2026-10-04')).toBe(true);
    expect(isLogDateSegment('2026-1-4')).toBe(false);
    expect(isLogDateSegment('20261004')).toBe(false);
    expect(isLogDateSegment('..')).toBe(false);
    expect(isLogDateSegment(undefined)).toBe(false);
  });

  it('文件名是 `<module>.log`', () => {
    expect(logFileName('chat')).toBe('chat.log');
  });

  it('日期段能还原成本地零点（日志年龄按目录名判，不按 mtime）', () => {
    expect(logDateSegmentToMs('2026-10-04')).toBe(new Date(2026, 9, 4).getTime());
    // 形状对但日历上不存在的日期必须挡掉：`new Date` 会静默滚到下个月
    expect(logDateSegmentToMs('2026-13-01')).toBeNull();
    expect(logDateSegmentToMs('2026-02-30')).toBeNull();
    expect(logDateSegmentToMs('2026-1-4')).toBeNull();
    expect(logDateSegmentToMs('')).toBeNull();
  });
});

describe('行格式', () => {
  const base = { at: Date.UTC(2026, 9, 4, 6, 20, 31, 123), module: 'chat' as const };

  it('形态固定：[ISO] [module] LEVEL message，时间为 UTC', () => {
    expect(formatLogLine({ ...base, level: 'error', message: '发送失败' })).toBe(
      '[2026-10-04T06:20:31.123Z] [chat] ERROR 发送失败',
    );
  });

  it('详情对象走 JSON、字符串原样、Error 取 name+message', () => {
    expect(formatLogLine({ ...base, level: 'info', message: 'm', detail: { a: 1 } })).toBe(
      '[2026-10-04T06:20:31.123Z] [chat] INFO m {"a":1}',
    );
    expect(formatLogLine({ ...base, level: 'info', message: 'm', detail: 'raw' })).toBe(
      '[2026-10-04T06:20:31.123Z] [chat] INFO m raw',
    );
    expect(
      formatLogLine({ ...base, level: 'warn', message: 'm', detail: new TypeError('boom') }),
    ).toBe('[2026-10-04T06:20:31.123Z] [chat] WARN m TypeError: boom');
  });

  it('无详情时不留尾随空格', () => {
    const line = formatLogLine({ ...base, level: 'info', message: 'm', detail: null });
    expect(line.endsWith('m')).toBe(true);
    expect(line).not.toContain('  ');
  });

  it('消息里的换行被转义——「一行一条」是 grep 与追加写入的前提', () => {
    const line = formatLogLine({ ...base, level: 'info', message: 'a\nb\r\nc' });
    expect(line).toBe('[2026-10-04T06:20:31.123Z] [chat] INFO a\\nb\\nc');
    expect(line.includes('\n')).toBe(false);
  });

  it('详情序列化失败也不抛（环状引用）', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const line = formatLogLine({ ...base, level: 'info', message: 'm', detail: circular });
    expect(line).toContain('[2026-10-04T06:20:31.123Z] [chat] INFO m');
  });
});

describe('保留期', () => {
  const NOW = Date.UTC(2026, 9, 4);

  it('按天折算', () => {
    expect(logRetentionCutoff(NOW, 14)).toBe(NOW - 14 * 86400000);
    expect(DEFAULT_LOG_KEEP_DAYS).toBeGreaterThan(0);
  });

  it('<=0 / 非有限数表示「不清理」——配置写坏时宁可占盘也不误删', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(logRetentionCutoff(NOW, bad)).toBe(0);
  });
});
