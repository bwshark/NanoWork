import { describe, expect, it } from 'vitest';
import { digestProcess, formatDuration } from '@/lib/processDigest';
import type { ProcessEvent } from '@/types';

/**
 * 过程时间线统计层单测。
 *
 * 覆盖重点：
 * - 时长格式化的分档与边界（不足 1s / 整分钟 / 进位 / 非法值）；
 * - 统计只认 kind 与 status，不依赖事件顺序。
 */

/** 构造工具行（默认 done） */
function tool(
  id: string,
  status: 'running' | 'done' | 'error' = 'done',
): ProcessEvent {
  return { id, kind: 'tool', tool: 'read_file', args: {}, status };
}

/** 构造思考段 */
function reasoning(id: string, closed = true): ProcessEvent {
  return { id, kind: 'reasoning', content: '...', closed };
}

describe('formatDuration', () => {
  it('秒级直接返回整数秒', () => {
    expect(formatDuration(33_000)).toBe('33s');
    expect(formatDuration(52_400)).toBe('52s');
  });

  it('不足 1s 保底显示 1s（避免出现 0s）', () => {
    expect(formatDuration(1)).toBe('1s');
    expect(formatDuration(300)).toBe('1s');
  });

  it('分钟级补零到两位秒（参考形态 1m41s）', () => {
    expect(formatDuration(101_000)).toBe('1m41s');
    expect(formatDuration(65_000)).toBe('1m05s');
  });

  it('整分钟不拖多余的 0s', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(3_600_000)).toBe('1h');
  });

  it('小时级补零到两位分', () => {
    expect(formatDuration(3_720_000)).toBe('1h02m');
    expect(formatDuration(7_500_000)).toBe('2h05m');
  });

  it('非正数 / 非法值返回空串（由调用方决定不渲染）', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(-5)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('digestProcess', () => {
  it('空数组全为 0', () => {
    expect(digestProcess([])).toEqual({
      steps: 0,
      running: 0,
      errors: 0,
      thinkingCount: 0,
    });
  });

  it('思考段不计入步数，只计 thinkingCount', () => {
    const d = digestProcess([reasoning('r1'), reasoning('r2'), tool('t1')]);
    expect(d.steps).toBe(1);
    expect(d.thinkingCount).toBe(2);
  });

  it('running / error 分别计数，done 只进步数', () => {
    const d = digestProcess([
      tool('t1', 'done'),
      tool('t2', 'running'),
      tool('t3', 'error'),
      tool('t4', 'error'),
    ]);
    expect(d).toEqual({ steps: 4, running: 1, errors: 2, thinkingCount: 0 });
  });

  it('统计与事件顺序无关', () => {
    const seq = [tool('t1'), tool('t2', 'error'), reasoning('r1')];
    const rev = [...seq].reverse();
    expect(digestProcess(seq)).toEqual(digestProcess(rev));
  });
});
