/**
 * 启动屏状态机（`electron/splashState.ts`）。
 *
 * 断言的重点**不是"返回值长什么样"，而是三件会让用户直观受损的事**：
 * ① 进度不许造假 —— 未落地前永远到不了 100%；
 * ② 慢启动必须换话 —— 6 秒 / 15 秒两档，界面不能静默停住；
 * ③ 失败必须能行动 —— 每种成因都要给出"现在能做什么"，而不是把原始报错糊上去。
 *
 * 变异验证目标：
 * - 把 `progressOf` 的封顶 `0.99` 改成 `1` → "未落地不到 100%" 用例变红；
 * - 把 `slowHint` 的两档阈值写反 → 两档用例同时变红；
 * - 删掉 `classifyEngineFailure` 的端口分支 → 端口冲突用例退化成 unknown，变红。
 */

import { describe, expect, it } from 'vitest';
import {
  SPLASH_PHASES,
  SLOW_HINT_MS,
  VERY_SLOW_HINT_MS,
  buildView,
  classifyEngineFailure,
  classifyRendererFailure,
  createPhaseStatuses,
  currentPhase,
  isSplashEnabled,
  progressOf,
  slowHint,
  type PhaseStatuses,
} from '../../electron/splashState';

function statusesOf(patch: Partial<PhaseStatuses>): PhaseStatuses {
  return { ...createPhaseStatuses(), ...patch };
}

describe('进度只来自真实阶段', () => {
  it('刚开始是 0，全落地才是 1', () => {
    expect(progressOf(createPhaseStatuses())).toBe(0);
    expect(
      progressOf({ env: 'done', engine: 'done', gateway: 'done', ui: 'done' }),
    ).toBe(1);
  });

  it('还有阶段没落地时封顶 99%（不能出现「100% 了窗口还没出来」）', () => {
    // 引擎跑完、界面也画完了，只剩网关（并行、不拦首屏）
    const almost = statusesOf({ env: 'done', engine: 'done', ui: 'done', gateway: 'pending' });
    const progress = progressOf(almost);
    expect(progress).toBeGreaterThan(0.8);
    expect(progress).toBeLessThan(1);
  });

  it('进行中的阶段只记一半权重（进度条会动，但不会骗到 100%）', () => {
    const engineActive = progressOf(statusesOf({ env: 'done', engine: 'active' }));
    const engineDone = progressOf(statusesOf({ env: 'done', engine: 'done' }));
    expect(engineActive).toBeGreaterThan(0.1);
    expect(engineActive).toBeLessThan(engineDone);
    expect(engineDone).toBeLessThan(1);
  });

  it('失败/跳过也算"落地"，不会把进度永久钉在半路', () => {
    const failed = progressOf({ env: 'done', engine: 'failed', gateway: 'skipped', ui: 'done' });
    expect(failed).toBe(1);
  });
});

describe('当前阶段', () => {
  it('优先取进行中的那个', () => {
    const phase = currentPhase(statusesOf({ env: 'done', gateway: 'active' }));
    expect(phase?.id).toBe('gateway');
  });

  it('没有进行中的就取第一个未开始的', () => {
    const phase = currentPhase(statusesOf({ env: 'done', engine: 'done' }));
    expect(phase?.id).toBe('gateway');
  });

  it('全部落地时返回 null（视图回落成「即将就绪」）', () => {
    expect(currentPhase({ env: 'done', engine: 'done', gateway: 'skipped', ui: 'done' })).toBeNull();
  });
});

describe('慢启动提示分两档', () => {
  it('6 秒以内不啰嗦', () => {
    expect(slowHint(0)).toBe('');
    expect(slowHint(SLOW_HINT_MS - 1)).toBe('');
  });

  it('6 秒起给「首次启动较慢」的解释，15 秒起给「可以先进去」的出口', () => {
    expect(slowHint(SLOW_HINT_MS)).toContain('首次启动');
    expect(slowHint(VERY_SLOW_HINT_MS)).toContain('先进入应用');
    expect(slowHint(VERY_SLOW_HINT_MS)).not.toBe(slowHint(SLOW_HINT_MS));
  });
});

describe('失败分类：说人话 + 给下一步', () => {
  const cases: Array<[string, string, string]> = [
    ['listen EADDRINUSE 127.0.0.1:18900', 'port-conflict', '端口'],
    ['[WinError 10048] 通常每个套接字地址只允许使用一次', 'port-conflict', '端口'],
    ['spawn D:\\rt\\python.exe ENOENT', 'engine-missing', '引擎'],
    ['127.0.0.1:18900 在 20 秒内未进入监听', 'engine-timeout', '超时'],
    ['something exploded', 'unknown', '引擎'],
  ];

  it.each(cases)('%s → %s', (detail, kind) => {
    const failure = classifyEngineFailure(detail);
    expect(failure.kind).toBe(kind);
    // 原始报错必须原样保留：错误卡片折叠展示，日志靠它定位
    expect(failure.detail).toBe(detail);
    expect(failure.title.length).toBeGreaterThan(2);
    expect(failure.advice.length).toBeGreaterThan(10);
  });

  it('渲染层加载失败与引擎失败是不同的两件事', () => {
    const failure = classifyRendererFailure('ERR_FILE_NOT_FOUND');
    expect(failure.kind).toBe('renderer-load');
    expect(failure.title).not.toBe(classifyEngineFailure('x').title);
  });
});

describe('buildView 是纯数据', () => {
  it('启动中：带阶段行、进度与当前阶段文案', () => {
    const view = buildView({
      theme: 'dark',
      version: '0.1.0',
      statuses: statusesOf({ env: 'done', engine: 'active' }),
      elapsedMs: 1200,
      detail: '127.0.0.1:18900',
    });

    expect(view.title).toBe('正在启动');
    expect(view.message).toContain('启动智能体引擎');
    expect(view.message).toContain('127.0.0.1:18900');
    expect(view.hint).toBe('');
    expect(view.error).toBeNull();
    expect(view.phases).toHaveLength(SPLASH_PHASES.length);
    expect(view.phases.find((row) => row.id === 'env')?.status).toBe('done');
  });

  it('错误态：标题换成错误 title、hint 换成建议，并带上倒计时', () => {
    const error = classifyEngineFailure('EADDRINUSE');
    const view = buildView({
      theme: 'light',
      version: '0.1.0',
      statuses: statusesOf({ env: 'done', engine: 'failed' }),
      elapsedMs: 3000,
      error,
      autoEnterInSec: 5,
    });

    expect(view.title).toBe('启动未完成');
    expect(view.message).toBe(error.title);
    expect(view.hint).toBe(error.advice);
    expect(view.autoEnterInSec).toBe(5);
  });

  it('四步全绿后：进度 1、文案回落成「即将就绪」（这是交接前的那一帧）', () => {
    const view = buildView({
      theme: 'dark',
      version: '0.1.0',
      statuses: { env: 'done', engine: 'done', gateway: 'done', ui: 'done' },
      elapsedMs: 9000,
    });
    expect(view.progress).toBe(1);
    expect(view.message).toBe('即将就绪');
    // 全绿那一帧不该再显示"首次启动较慢"——那会和四个勾自相矛盾
    expect(view.hint).not.toContain('首次启动');
  });

  it('可以安全地经过一次 JSON 序列化（IPC 只传纯数据）', () => {    const view = buildView({
      theme: 'dark',
      version: '0.1.0',
      statuses: statusesOf({ env: 'done', engine: 'failed' }),
      elapsedMs: 9000,
      error: classifyEngineFailure('timed out'),
      autoEnterInSec: 8,
    });
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
});

describe('排障开关', () => {
  it('只有 1/true 才算关掉（写错的取值应当表现为「没关」）', () => {
    expect(isSplashEnabled({})).toBe(true);
    expect(isSplashEnabled({ NANOWORK_SKIP_SPLASH: '0' })).toBe(true);
    expect(isSplashEnabled({ NANOWORK_SKIP_SPLASH: 'yes' })).toBe(true);
    expect(isSplashEnabled({ NANOWORK_SKIP_SPLASH: '1' })).toBe(false);
    expect(isSplashEnabled({ NANOWORK_SKIP_SPLASH: 'true' })).toBe(false);
  });
});
