import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTasksStore } from '@/stores/tasksStore';

/**
 * tasksStore.addTask 幂等语义（真实 store）：
 * 聊天 cron 工具镜像以引擎 job id 写入，同 id 必须合并覆盖而非重复追加，
 * 避免历史消息重放造成双份任务/双份调度。
 */

beforeEach(() => {
  // 假定时器：吞掉 addTask 后的 600ms 防抖自动同步，避免测试尾焰
  vi.useFakeTimers();
  useTasksStore.setState({ tasks: [], runs: [], lastSync: null, syncing: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('addTask: 带 id 幂等', () => {
  it('不带 id：自动生成 id 并追加', () => {
    const task = useTasksStore.getState().addTask({ name: '新任务' });
    expect(task.id).toBeTruthy();
    expect(useTasksStore.getState().tasks).toHaveLength(1);
  });

  it('带 id：按指定 id 新增', () => {
    const task = useTasksStore
      .getState()
      .addTask({ id: 'ab12cd34', name: '早报', prompt: '生成早报' });
    expect(task.id).toBe('ab12cd34');
    expect(useTasksStore.getState().tasks).toHaveLength(1);
  });

  it('同 id 重复写入：幂等合并覆盖，不重复追加，保留原 createdAt', () => {
    const first = useTasksStore
      .getState()
      .addTask({
        id: 'ab12cd34',
        name: '早报',
        prompt: '生成早报',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
      });

    const merged = useTasksStore
      .getState()
      .addTask({ id: 'ab12cd34', name: '早报（镜像更新）' });

    const tasks = useTasksStore.getState().tasks;
    expect(tasks).toHaveLength(1); // 未重复追加
    expect(merged.id).toBe('ab12cd34');
    expect(merged.name).toBe('早报（镜像更新）'); // partial 字段覆盖
    expect(merged.prompt).toBe('生成早报'); // 未提供的字段保留既有值
    expect(merged.schedule).toEqual({ kind: 'cron', expr: '0 9 * * *' });
    expect(merged.createdAt).toBe(first.createdAt); // createdAt 不被重置
  });
});
