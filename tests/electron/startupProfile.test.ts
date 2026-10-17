/**
 * 启动性能剖析器（FR-11.6）。
 *
 * **核心用例是「关闭态零 I/O」那一组**：剖析器的价值随开关打开才兑现，
 * 但它的代价必须在关闭态为零 —— 否则「为了优化启动而拖慢启动」。
 * 判据：关闭态下 sink 一次都不能被调用（sink 就是落盘）。
 *
 * 其次是区间并集：serve 与 gateway 是并行拉起的，各段相加会得出一个
 * 比墙钟还大的数字，人看到它会去优化一个不存在的瓶颈。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createNoopProfiler,
  createStartupProfiler,
  isStartupProfileEnabled,
  STARTUP_PROFILE_ENV,
  unionDurationMs,
  type StartupSpan,
} from '../../electron/startupProfile';

/** 手动时钟：每次调用前进固定步长，便于断言精确数值 */
function makeClock(start = 1000, step = 10) {
  let current = start;
  return {
    now: () => {
      const value = current;
      current += step;
      return value;
    },
  };
}

/**
 * 测试里一律显式传 `startedAtMs`：否则构造采集器那一次 `now()` 会吃掉一拍，
 * 让后面每个端点都偏移一个步长（断言全部差 10，看着像实现错了）。
 */
const FIXED_ORIGIN = 0;

const span = (name: string, start: number, end: number): StartupSpan => ({
  name,
  startedAtMs: start,
  endedAtMs: end,
});

describe('isStartupProfileEnabled', () => {
  it('只认 1 / true', () => {
    expect(isStartupProfileEnabled({ [STARTUP_PROFILE_ENV]: '1' })).toBe(true);
    expect(isStartupProfileEnabled({ [STARTUP_PROFILE_ENV]: 'true' })).toBe(true);
  });

  it('未设置 / 空串 / 0 / 其他取值一律关闭', () => {
    // 写错的取值应当表现为「没开」，而不是「莫名开了」——后者会让用户
    // 在自己没打算采集的时候发现磁盘上多出一堆文件。
    expect(isStartupProfileEnabled({})).toBe(false);
    expect(isStartupProfileEnabled({ [STARTUP_PROFILE_ENV]: '' })).toBe(false);
    expect(isStartupProfileEnabled({ [STARTUP_PROFILE_ENV]: '0' })).toBe(false);
    expect(isStartupProfileEnabled({ [STARTUP_PROFILE_ENV]: 'yes' })).toBe(false);
    expect(isStartupProfileEnabled({ [STARTUP_PROFILE_ENV]: 'TRUE' })).toBe(false);
  });
});

describe('关闭态：零 I/O', () => {
  it('flush 绝不触碰 sink（sink 就是落盘）', () => {
    const sink = vi.fn();
    const profiler = createStartupProfiler({ enabled: false, sink });
    expect(profiler.enabled).toBe(false);

    profiler.begin('app');
    profiler.end('app');
    profiler.span('serve', 0, 5);
    profiler.flush();

    expect(sink).not.toHaveBeenCalled();
  });

  it('report 是空记录，且不因埋点调用而变化', () => {
    const profiler = createStartupProfiler({ enabled: false });
    profiler.begin('serve');
    profiler.end('serve');
    const report = profiler.report();
    expect(report.spans).toEqual([]);
    expect(report.unionMs).toBe(0);
    expect(report.durationMs).toBe(0);
  });

  it('noop 实现的所有方法都可安全调用', () => {
    const profiler = createNoopProfiler();
    expect(() => {
      profiler.begin('x');
      profiler.end('x');
      profiler.span('y', 1, 2);
      profiler.flush();
    }).not.toThrow();
  });
});

describe('开启态：区间采集', () => {
  it('begin / end 产出一段区间，端点取自时钟', () => {
    const { now } = makeClock(1000, 10);
    const profiler = createStartupProfiler({ enabled: true, now, pid: 42, startedAtMs: FIXED_ORIGIN });
    profiler.begin('serve');
    profiler.end('serve');
    const [first] = profiler.report().spans;
    expect(first.name).toBe('serve');
    expect(first.startedAtMs).toBe(1000);
    expect(first.endedAtMs).toBe(1010);
    expect(profiler.report().pid).toBe(42);
  });

  it('end 一个没 begin 过的名字：静默忽略，不抛也不产出', () => {
    // 埋点写错（少写一个 begin / 名字拼错）不该让主进程启动链路报错。
    const profiler = createStartupProfiler({ enabled: true, now: () => 0 });
    expect(() => profiler.end('never-begun')).not.toThrow();
    expect(profiler.report().spans).toEqual([]);
  });

  it('同名重复 begin 以最后一次为准，不叠加成两段', () => {
    const { now } = makeClock(0, 100);
    const profiler = createStartupProfiler({ enabled: true, now, startedAtMs: FIXED_ORIGIN });
    profiler.begin('serve'); // 0
    profiler.begin('serve'); // 100 —— 重入，覆盖起点
    profiler.end('serve'); // 200
    const spans = profiler.report().spans;
    expect(spans).toHaveLength(1);
    expect(spans[0].startedAtMs).toBe(100);
    expect(spans[0].endedAtMs).toBe(200);
  });

  it('span() 直接接收外部区间（如引擎日志里读到的首 token）', () => {
    const profiler = createStartupProfiler({ enabled: true, now: () => 999 });
    profiler.span('first-token', 100, 150);
    expect(profiler.report().spans).toEqual([span('first-token', 100, 150)]);
  });

  it('仍未闭合的区间按「记到此刻」收口，不丢信息', () => {
    const { now } = makeClock(500, 50);
    const profiler = createStartupProfiler({ enabled: true, now, startedAtMs: FIXED_ORIGIN });
    profiler.begin('gateway'); // 起点 500
    const report = profiler.report(); // 报告时刻 550
    expect(report.spans).toEqual([span('gateway', 500, 550)]);
  });

  it('flush 把报告交给 sink；report() 可重复调用不污染既有区间', () => {
    const sink = vi.fn();
    const profiler = createStartupProfiler({ enabled: true, sink, now: () => 7 });
    profiler.span('app', 0, 3);
    profiler.flush();
    profiler.flush();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0][0].spans).toHaveLength(1);
    expect(sink.mock.calls[1][0].spans).toHaveLength(1);
  });

  it('extras 在报告时刻才求值（可读「须等 ready」的值）', () => {
    const extras = vi.fn(() => ({ version: '1.6.0' }));
    const profiler = createStartupProfiler({ enabled: true, extras, now: () => 0 });
    expect(extras).not.toHaveBeenCalled();
    expect(profiler.report().extras).toEqual({ version: '1.6.0' });
    expect(extras).toHaveBeenCalledTimes(1);
  });

  it('durationMs 是墙钟，不是各段之和', () => {
    // 报告时刻 = 9000（serve 刚 listen），而网关早在 4100 就绪
    const profiler = createStartupProfiler({
      enabled: true,
      now: () => 9000,
      startedAtMs: FIXED_ORIGIN,
    });
    profiler.span('serve', 0, 9000); // 并行阶段的墙钟就是 9 秒
    profiler.span('gateway', 100, 4100);
    const report = profiler.report();
    expect(report.durationMs).toBe(9000);
    expect(report.unionMs).toBe(9000);
    // 各段相加会是 13 秒 —— 那是一个不存在的数字，正是 unionMs 要避免的
    expect(report.spans.reduce((sum, s) => sum + (s.endedAtMs - s.startedAtMs), 0)).toBe(13000);
  });
});

describe('unionDurationMs', () => {
  it('空数组为 0', () => {
    expect(unionDurationMs([])).toBe(0);
  });

  it('互不重叠的区间相加', () => {
    expect(unionDurationMs([span('a', 0, 100), span('b', 200, 300)])).toBe(200);
  });

  it('重叠区间只算一次', () => {
    expect(unionDurationMs([span('a', 0, 100), span('b', 50, 150)])).toBe(150);
  });

  it('完全包含的区间不重复计数', () => {
    expect(unionDurationMs([span('a', 0, 1000), span('b', 100, 200)])).toBe(1000);
  });

  it('首尾相接算作连续（端点相等不产生空洞）', () => {
    expect(unionDurationMs([span('a', 0, 100), span('b', 100, 200)])).toBe(200);
  });

  it('乱序输入同样正确', () => {
    expect(unionDurationMs([span('c', 500, 600), span('a', 0, 100), span('b', 50, 200)])).toBe(300);
  });

  it('零长度与反向区间不计入（时钟回拨不该造出比墙钟还大的数字）', () => {
    expect(unionDurationMs([span('a', 100, 100), span('b', 300, 200)])).toBe(0);
    expect(unionDurationMs([span('a', 0, 100), span('b', 300, 200)])).toBe(100);
  });
});
