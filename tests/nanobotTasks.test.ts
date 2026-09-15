import { describe, it, expect } from 'vitest';
import {
  MANAGED_BY_SMARTAGENT,
  buildNanobotJobsFragment,
  toNanobotJob,
  toNanobotSchedule,
} from '@/ai/nanobotTasks';
import type { TaskConfig } from '@/types';

/** 构造最小 TaskConfig */
function task(schedule: TaskConfig['schedule']): TaskConfig {
  return {
    id: 't1',
    name: '早报',
    schedule,
    prompt: '生成早报',
    agentId: 'a1',
    status: 'enabled',
    createdAt: new Date().toISOString(),
  };
}

describe('toNanobotSchedule: 三种形态对齐 nanobot CronSchedule', () => {
  it('cron → { kind: cron, expr, tz }', () => {
    expect(toNanobotSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' })).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'Asia/Shanghai',
    });
  });

  it('interval → { kind: every, everyMs }（分钟转毫秒）', () => {
    expect(toNanobotSchedule({ kind: 'interval', minutes: 90 })).toEqual({
      kind: 'every',
      everyMs: 90 * 60_000,
    });
  });

  it('once → { kind: at, atMs }', () => {
    const at = '2026-08-20T01:30:00.000Z';
    expect(toNanobotSchedule({ kind: 'once', at })).toEqual({
      kind: 'at',
      atMs: Date.parse(at),
    });
  });
});

describe('toNanobotJob: payload 与 deleteAfterRun 语义', () => {
  it('payload 为 agent_turn + message；单次任务 deleteAfterRun=true', () => {
    const job = toNanobotJob(task({ kind: 'once', at: '2026-08-20T01:30:00.000Z' }));
    expect(job.payload.kind).toBe('agent_turn');
    expect(job.payload.message).toBe('生成早报');
    expect(job.payload.originMetadata?.agentId).toBe('a1');
    expect(job.deleteAfterRun).toBe(true);
    expect(job.enabled).toBe(true);
  });

  it('周期任务 deleteAfterRun=false；disabled 映射 enabled=false', () => {
    const t = task({ kind: 'cron', expr: '0 9 * * *' });
    t.status = 'disabled';
    const job = toNanobotJob(t);
    expect(job.deleteAfterRun).toBe(false);
    expect(job.enabled).toBe(false);
  });

  it('runOptions 落入 payload.originMetadata', () => {
    const t = task({ kind: 'cron', expr: '0 9 * * *' });
    t.runOptions = { model: 'qwen-max', skillIds: ['s1'], fullAccess: true };
    const job = toNanobotJob(t);
    expect(job.payload.originMetadata).toEqual({
      // 托管标记必须下发：网关据此区分前端创建与服务端自建任务
      managedBy: MANAGED_BY_SMARTAGENT,
      agentId: 'a1',
      runOptions: { model: 'qwen-max', skillIds: ['s1'], fullAccess: true },
    });
  });
});

describe('buildNanobotJobsFragment: 输出 jobs.json 兼容结构', () => {
  it('含 version 与 jobs 数组', () => {
    const parsed = JSON.parse(
      buildNanobotJobsFragment([task({ kind: 'interval', minutes: 60 })]),
    ) as { version: number; jobs: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.jobs).toHaveLength(1);
  });
});
