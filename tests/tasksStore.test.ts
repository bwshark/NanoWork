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
  // `tombstones` 必须一起清：`addTask` 会拿它判「这个 id 是否已被删过」，
  // 跨用例残留会让新建被当成「镜像重放」而拒绝写入
  useTasksStore.setState({
    tasks: [],
    tombstones: {},
    runs: [],
    lastSync: null,
    syncing: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('addTask: 带 id 幂等', () => {
  it('不带 id：自动生成 id 并追加', () => {
    const task = useTasksStore.getState().addTask({ name: '新任务' });
    expect(task?.id).toBeTruthy();
    expect(useTasksStore.getState().tasks).toHaveLength(1);
  });

  it('带 id：按指定 id 新增', () => {
    const task = useTasksStore
      .getState()
      .addTask({ id: 'ab12cd34', name: '早报', prompt: '生成早报' });
    expect(task?.id).toBe('ab12cd34');
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
    expect(merged?.id).toBe('ab12cd34');
    expect(merged?.name).toBe('早报（镜像更新）'); // partial 字段覆盖
    expect(merged?.prompt).toBe('生成早报'); // 未提供的字段保留既有值
    expect(merged?.schedule).toEqual({ kind: 'cron', expr: '0 9 * * *' });
    expect(merged?.createdAt).toBe(first?.createdAt); // createdAt 不被重置
  });
});

describe('addTask: 新建时必须照搬草稿的可选字段（回归）', () => {
  /*
   * 这条守的是**静默丢字段**：新建分支曾经逐个列举可选字段，`validFrom` /
   * `validUntil` / `delivery` 都在那里被丢掉过。它特别难发现，因为链路两头都是对的
   * ——表单草稿带上了、同步接线也写进了 payload，只有中间落库这一跳漏了；
   * 单测全绿，靠真机验证才现形（见 `tasks/verify-task-delivery.mjs`）。
   *
   * 加新的可选字段时**不需要**改这个用例：它断言的就是「照搬」这件事本身。
   */
  it('生效区间 / 结果推送 / 执行配置都进落库结果', () => {
    const task = useTasksStore.getState().addTask({
      name: '早报',
      validFrom: '2026-10-01T00:00:00.000Z',
      validUntil: '2026-11-01T00:00:00.000Z',
      delivery: { targets: [{ channel: 'wecom', chatId: 'c1' }], on: 'error' },
      runOptions: { model: 'm1', skillIds: ['s1'], fullAccess: true },
    });

    expect(task?.validFrom).toBe('2026-10-01T00:00:00.000Z');
    expect(task?.validUntil).toBe('2026-11-01T00:00:00.000Z');
    expect(task?.delivery).toEqual({
      targets: [{ channel: 'wecom', chatId: 'c1' }],
      on: 'error',
    });
    expect(task?.runOptions).toEqual({ model: 'm1', skillIds: ['s1'], fullAccess: true });

    // 落库那份也要对，不只是返回值
    const stored = useTasksStore.getState().tasks[0];
    expect(stored?.delivery).toEqual({
      targets: [{ channel: 'wecom', chatId: 'c1' }],
      on: 'error',
    });
    expect(stored?.validFrom).toBe('2026-10-01T00:00:00.000Z');
  });

  it('同步元数据仍由 store 独占（草稿给的版本号与墓碑不生效）', () => {
    const task = useTasksStore.getState().addTask({
      name: '早报',
      rev: 99,
      updatedBy: '伪造设备',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(task?.rev).toBe(1);
    expect(task?.updatedBy).not.toBe('伪造设备');
    expect(task?.deletedAt).toBeNull();
  });
});
