/**
 * 运行留痕统计与失败分类（`src/lib/task/taskRunStats.ts`，FR-5.3）。
 *
 * 两条纪律各有一组用例守着：
 * 1. **分类判据取自真实文案**——引擎写入的两位固定文案、客户端的中文提示都进用例；
 * 2. **认不出来必须归「未知」**——不许猜。猜错类别比说「未知」更坏：它会把用户
 *    引到错误的排查方向（例如把「任务没绑定会话」说成「工具失败」）。
 */

import { describe, expect, it } from 'vitest';
import {
  RUN_FAILURE_LABELS,
  classifyRunFailure,
  formatSuccessRate,
  summarizeRuns,
  summarizeRunsByTask,
} from '../src/lib/task/taskRunStats';
import type { TaskRunRecord } from '../src/types';

function run(over: Partial<TaskRunRecord>): TaskRunRecord {
  return {
    id: 'r1',
    taskId: 't1',
    taskName: '早报',
    trigger: 'scheduled',
    startedAt: '2026-10-03T01:00:00.000Z',
    status: 'success',
    ...over,
  };
}

describe('classifyRunFailure：按真实文案分类', () => {
  it('引擎的「未绑定投递上下文」两条固定文案', () => {
    // 这两条是**唯一可自愈**的原因（重建任务即可），必须能被单独识别出来
    expect(
      classifyRunFailure(
        'agent cron payload is missing bound session delivery context; recreate it from a chat session',
      ),
    ).toBe('unbound');
    expect(
      classifyRunFailure('legacy cron payload is missing channel/to; recreate it from a chat session'),
    ).toBe('unbound');
  });

  it('客户端的中断与超时文案', () => {
    expect(classifyRunFailure('已中断')).toBe('interrupted');
    expect(classifyRunFailure('响应超时：121 秒内网关没有返回任何内容。')).toBe('timeout');
  });

  it('模型调用失败（模型不存在 / 配额 / 限流 / 鉴权）', () => {
    expect(classifyRunFailure('The model `sciherd` does not exist')).toBe('model');
    expect(classifyRunFailure('Error calling LLM: Free quota exhausted')).toBe('model');
    expect(classifyRunFailure('429 rate limit exceeded')).toBe('model');
  });

  it('权限被拒与工具失败要分开（两者处置完全不同：一个去改授权，一个去看命令）', () => {
    expect(classifyRunFailure('工具 exec 未获批准')).toBe('permission');
    expect(classifyRunFailure('command execution failed with exit code 1')).toBe('tool');
  });

  it('连接失败', () => {
    expect(classifyRunFailure('fetch failed')).toBe('network');
    expect(classifyRunFailure('连接失败：网关未启动')).toBe('network');
  });

  it('**否定判据**：认不出来就归「未知」，不许猜', () => {
    expect(classifyRunFailure('something nobody has seen before')).toBe('unknown');
    expect(classifyRunFailure('')).toBe('unknown');
    expect(classifyRunFailure('   ')).toBe('unknown');
    expect(classifyRunFailure(undefined)).toBe('unknown');
  });

  it('每个分类都有中文标签（UI 不会出现 undefined）', () => {
    for (const kind of Object.keys(RUN_FAILURE_LABELS)) {
      expect(RUN_FAILURE_LABELS[kind as keyof typeof RUN_FAILURE_LABELS]).toBeTruthy();
    }
  });
});

describe('summarizeRuns：成功率与失败分布', () => {
  it('空集合给出「无样本」而不是 0%', () => {
    const s = summarizeRuns([]);
    expect(s.total).toBe(0);
    expect(s.successRate).toBeNull();
    expect(s.avgDurationMs).toBeNull();
    expect(formatSuccessRate(s.successRate)).toBe('—');
  });

  it('进行中的运行**不计入成功率分母**（用户刚点的那一下不是任务质量信号）', () => {
    const s = summarizeRuns([
      run({ id: 'a', status: 'success' }),
      run({ id: 'b', status: 'running' }),
    ]);
    expect(s.running).toBe(1);
    expect(s.success).toBe(1);
    expect(s.successRate).toBe(1); // 而不是 1/2
  });

  it('只有进行中的运行时成功率仍是 null', () => {
    expect(summarizeRuns([run({ status: 'running' })]).successRate).toBeNull();
  });

  it('平均耗时只统计有 durationMs 的已结束运行', () => {
    const s = summarizeRuns([
      run({ id: 'a', status: 'success', durationMs: 1000 }),
      run({ id: 'b', status: 'error', error: '已中断', durationMs: 3000 }),
      run({ id: 'c', status: 'running' }), // 没有 durationMs，也不该进分母
    ]);
    expect(s.avgDurationMs).toBe(2000);
  });

  it('失败分布按条数降序，并带一条样例原文', () => {
    const s = summarizeRuns([
      run({ id: 'a', status: 'error', error: '已中断' }),
      run({ id: 'b', status: 'error', error: '已中断' }),
      run({ id: 'c', status: 'error', error: '响应超时：120 秒内没有返回' }),
      run({ id: 'd', status: 'success' }),
    ]);
    expect(s.error).toBe(3);
    expect(s.failures.map((f) => [f.kind, f.count])).toEqual([
      ['interrupted', 2],
      ['timeout', 1],
    ]);
    expect(s.failures[0].label).toBe('被中断');
    expect(s.failures[1].sample).toContain('响应超时');
  });

  it('同数时排序稳定（否则每次渲染顺序都在变）', () => {
    const s = summarizeRuns([
      run({ id: 'a', status: 'error', error: '已中断' }),
      run({ id: 'b', status: 'error', error: 'fetch failed' }),
    ]);
    // 条数相同 → 按中文标签排序：'连接失败' < '被中断'（拼音无关，按 localeCompare）
    expect(s.failures.map((f) => f.kind)).toEqual(
      s.failures.map((f) => f.kind).slice().sort((k1, k2) =>
        RUN_FAILURE_LABELS[k1].localeCompare(RUN_FAILURE_LABELS[k2]),
      ),
    );
  });

  it('成功率为 0 与「无样本」要能区分', () => {
    expect(summarizeRuns([run({ status: 'error', error: '已中断' })]).successRate).toBe(0);
    expect(formatSuccessRate(0)).toBe('0%');
    expect(formatSuccessRate(1)).toBe('100%');
    expect(formatSuccessRate(2 / 3)).toBe('67%');
  });
});

describe('summarizeRunsByTask：按任务汇总', () => {
  it('分组统计，任务之间互不影响', () => {
    const map = summarizeRunsByTask([
      run({ id: 'a', taskId: 't1', status: 'success' }),
      run({ id: 'b', taskId: 't1', status: 'error', error: '已中断' }),
      run({ id: 'c', taskId: 't2', status: 'success' }),
    ]);
    expect(map.get('t1')?.successRate).toBe(0.5);
    expect(map.get('t2')?.successRate).toBe(1);
    expect(map.get('t1')?.error).toBe(1);
  });

  it('没有 taskId 的记录被跳过（不造一个空键的分组）', () => {
    const map = summarizeRunsByTask([run({ taskId: '' }), run({ taskId: 't2' })]);
    expect([...map.keys()]).toEqual(['t2']);
  });
});
