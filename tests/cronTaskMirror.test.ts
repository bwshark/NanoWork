import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskConfig } from '@/types';

/**
 * mock tasksStore：镜像层仅依赖 getState().tasks 与 getState().addTask
 * 两个能力，直接以最小 zustand 形态替身（真实 store 的 addTask 幂等
 * 逻辑另行在 tests/tasksStore.test.ts 用真实 store 覆盖）。
 */
const storeMock = vi.hoisted(() => {
  let tasks: TaskConfig[] = [];
  let counter = 0;
  /** addTask 调用留痕（断言「已存在同 id 时不再调用」用） */
  const addCalls: Array<Partial<TaskConfig> | undefined> = [];
  const addTask = (partial?: Partial<TaskConfig>): TaskConfig => {
    addCalls.push(partial);
    const task: TaskConfig = {
      id: partial?.id ?? `gen-${++counter}`,
      name: partial?.name ?? '新任务',
      schedule: partial?.schedule ?? { kind: 'interval', minutes: 60 },
      prompt: partial?.prompt ?? '',
      agentId: partial?.agentId ?? '',
      status: partial?.status ?? 'enabled',
      createdAt: new Date().toISOString(),
    };
    tasks = [...tasks, task];
    return task;
  };
  return {
    get tasks() {
      return tasks;
    },
    get addCalls() {
      return addCalls;
    },
    addTask,
    /** 重置替身状态（每个用例前调用） */
    reset() {
      tasks = [];
      counter = 0;
      addCalls.length = 0;
    },
    /** 预置既有任务（模拟历史恢复后已存在同 id 任务） */
    seed(list: TaskConfig[]) {
      tasks = list;
    },
  };
});

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: {
    getState: () => ({ tasks: storeMock.tasks, addTask: storeMock.addTask }),
  },
}));

import {
  cronToolArgsToTaskDraft,
  mirrorCronToolEvent,
  parseCronJobId,
  resetMirrorDedup,
} from '@/ai/cronTaskMirror';

beforeEach(() => {
  storeMock.reset();
  resetMirrorDedup();
});

describe('parseCronJobId: 从引擎成功结果串提取 job id', () => {
  it('正常串：提取 8 位 id', () => {
    expect(parseCronJobId("Created job '早报' (id: ab12cd34)")).toBe('ab12cd34');
  });

  it('缺 id 段：返回 null', () => {
    expect(parseCronJobId("Created job '早报'")).toBeNull();
  });

  it('空串 / undefined：返回 null', () => {
    expect(parseCronJobId('')).toBeNull();
    expect(parseCronJobId(undefined)).toBeNull();
  });

  it('无 Created job 前缀：宁可不镜像也不误提取', () => {
    expect(parseCronJobId('任务完成 (id: ab12cd34)')).toBeNull();
  });
});

describe('cronToolArgsToTaskDraft: 工具入参 → 任务草稿', () => {
  it('at（带时区）→ once，输出完整 ISO', () => {
    const draft = cronToolArgsToTaskDraft({
      action: 'add',
      at: '2026-08-25T09:30:00+08:00',
      message: '生成早报',
    });
    expect(draft).toEqual({
      name: '生成早报',
      schedule: { kind: 'once', at: '2026-08-25T01:30:00.000Z' },
      prompt: '生成早报',
    });
  });

  it('at（无时区）→ 按本地时区解释并转为完整 ISO', () => {
    const draft = cronToolArgsToTaskDraft({
      action: 'add',
      at: '2026-08-25 09:30',
      message: '生成早报',
    });
    expect(draft?.schedule).toEqual({
      kind: 'once',
      at: new Date(2026, 7, 25, 9, 30).toISOString(),
    });
  });

  it('at 非法 → 宁可不镜像返回 null', () => {
    expect(
      cronToolArgsToTaskDraft({ action: 'add', at: 'not-a-date', message: 'x' }),
    ).toBeNull();
  });

  it('every_seconds → interval（秒换算分钟，至少 1 分钟）', () => {
    expect(
      cronToolArgsToTaskDraft({ action: 'add', every_seconds: 3600, message: '巡检' })?.schedule,
    ).toEqual({ kind: 'interval', minutes: 60 });
    expect(
      cronToolArgsToTaskDraft({ action: 'add', every_seconds: 30, message: '巡检' })?.schedule,
    ).toEqual({ kind: 'interval', minutes: 1 });
  });

  it('cron_expr → cron（validateCron 通过；可携带 tz）', () => {
    expect(
      cronToolArgsToTaskDraft({ action: 'add', cron_expr: '0 9 * * *', message: '早报' })
        ?.schedule,
    ).toEqual({ kind: 'cron', expr: '0 9 * * *' });
    expect(
      cronToolArgsToTaskDraft({
        action: 'add',
        cron_expr: '30 14 * * 1',
        tz: 'Asia/Shanghai',
        message: '周报',
      })?.schedule,
    ).toEqual({ kind: 'cron', expr: '30 14 * * 1', tz: 'Asia/Shanghai' });
  });

  it('非法 cron 表达式 → null', () => {
    expect(
      cronToolArgsToTaskDraft({ action: 'add', cron_expr: '0 25 * * *', message: 'x' }),
    ).toBeNull();
  });

  it('优先级：at > cron_expr > every_seconds', () => {
    const draft = cronToolArgsToTaskDraft({
      action: 'add',
      at: '2026-08-25T09:30:00+08:00',
      cron_expr: '0 9 * * *',
      every_seconds: 60,
      message: '早报',
    });
    expect(draft?.schedule).toEqual({ kind: 'once', at: '2026-08-25T01:30:00.000Z' });
  });

  it('缺 message → null', () => {
    expect(cronToolArgsToTaskDraft({ action: 'add', cron_expr: '0 9 * * *' })).toBeNull();
    expect(cronToolArgsToTaskDraft({ action: 'add', cron_expr: '0 9 * * *', message: '  ' })).toBeNull();
  });

  it('action 非 add → null', () => {
    expect(
      cronToolArgsToTaskDraft({ action: 'list', cron_expr: '0 9 * * *', message: 'x' }),
    ).toBeNull();
  });

  it('name 缺省时回退 makeTaskName（超长截断补省略号）', () => {
    const longMsg = '每天早上九点生成并推送今日行业新闻早报摘要';
    const draft = cronToolArgsToTaskDraft({ action: 'add', cron_expr: '0 9 * * *', message: longMsg });
    expect(draft?.name).toBe(longMsg.slice(0, 20) + '…');
    expect(draft?.prompt).toBe(longMsg);
  });

  it('显式 name 优先', () => {
    const draft = cronToolArgsToTaskDraft({
      action: 'add',
      name: '早报',
      cron_expr: '0 9 * * *',
      message: '生成早报',
    });
    expect(draft?.name).toBe('早报');
  });
});

describe('mirrorCronToolEvent: 镜像入任务列表（幂等）', () => {
  const okResult = "Created job '早报' (id: ab12cd34)";
  const addArgs = { action: 'add', name: '早报', cron_expr: '0 9 * * *', message: '生成早报' };

  it('成功镜像：以引擎 job id 落库', () => {
    const task = mirrorCronToolEvent({ callId: 'row-1', args: addArgs, result: okResult });
    expect(task?.id).toBe('ab12cd34');
    expect(task?.name).toBe('早报');
    expect(storeMock.tasks).toHaveLength(1);
    expect(storeMock.tasks[0].schedule).toEqual({ kind: 'cron', expr: '0 9 * * *' });
  });

  it('同 callId 去重：第二次调用不再追加', () => {
    mirrorCronToolEvent({ callId: 'row-1', args: addArgs, result: okResult });
    const second = mirrorCronToolEvent({ callId: 'row-1', args: addArgs, result: okResult });
    expect(second?.id).toBe('ab12cd34');
    expect(storeMock.tasks).toHaveLength(1);
    expect(storeMock.addCalls).toHaveLength(1);
  });

  it('result 解析失败 → null，绝不建任务（不自造 id）', () => {
    expect(
      mirrorCronToolEvent({ callId: 'row-2', args: addArgs, result: '执行成功' }),
    ).toBeNull();
    expect(mirrorCronToolEvent({ callId: 'row-3', args: addArgs })).toBeNull();
    expect(storeMock.tasks).toHaveLength(0);
  });

  it('带 error → null', () => {
    expect(
      mirrorCronToolEvent({ callId: 'row-4', args: addArgs, result: okResult, error: 'boom' }),
    ).toBeNull();
    expect(storeMock.tasks).toHaveLength(0);
  });

  it('草稿无效（非 add）→ null', () => {
    expect(
      mirrorCronToolEvent({
        callId: 'row-5',
        args: { action: 'list' },
        result: okResult,
      }),
    ).toBeNull();
  });

  it('store 已含同 id 任务（历史重放）→ 返回既有任务且不再 addTask', () => {
    const existing: TaskConfig = {
      id: 'ab12cd34',
      name: '早报（旧）',
      schedule: { kind: 'cron', expr: '0 8 * * *' },
      prompt: '旧提示词',
      agentId: 'a1',
      status: 'enabled',
      createdAt: new Date().toISOString(),
    };
    storeMock.seed([existing]);
    const task = mirrorCronToolEvent({ callId: 'row-6', args: addArgs, result: okResult });
    expect(task).toBe(existing);
    expect(storeMock.tasks).toHaveLength(1);
    expect(storeMock.addCalls).toHaveLength(0);
  });
});
