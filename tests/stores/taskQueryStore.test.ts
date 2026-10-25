import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskQueryStore } from '@/stores/taskQueryStore';
import { DEFAULT_TASK_FILTERS } from '@/lib/task/taskQuery';

/** 每个用例前把运行期状态复位（store 不持久化，但模块级单例跨用例共享） */
function reset() {
  useTaskQueryStore.setState({
    searchOpen: false,
    query: '',
    filters: { ...DEFAULT_TASK_FILTERS },
  });
}

describe('taskQueryStore: 搜索面板开关', () => {
  beforeEach(reset);

  it('openSearch / closeSearch 切换开关', () => {
    useTaskQueryStore.getState().openSearch();
    expect(useTaskQueryStore.getState().searchOpen).toBe(true);

    useTaskQueryStore.getState().closeSearch();
    expect(useTaskQueryStore.getState().searchOpen).toBe(false);
  });

  it('关闭搜索窗时一并清空关键词（避免下次打开看到上次的检索）', () => {
    const s = useTaskQueryStore.getState();
    s.openSearch();
    s.setQuery('网关');
    expect(useTaskQueryStore.getState().query).toBe('网关');

    useTaskQueryStore.getState().closeSearch();
    expect(useTaskQueryStore.getState().query).toBe('');
  });

  it('closeSearch 不影响筛选条件（筛选是长期偏好，不该被关窗重置）', () => {
    const s = useTaskQueryStore.getState();
    s.setStatusFilter('running');
    s.openSearch();
    useTaskQueryStore.getState().closeSearch();

    expect(useTaskQueryStore.getState().filters.status).toBe('running');
  });
});

describe('taskQueryStore: 筛选条件', () => {
  beforeEach(reset);

  it('setStatusFilter 只改状态维度，保留时间维度', () => {
    const s = useTaskQueryStore.getState();
    s.setTimeFilter('week');
    s.setStatusFilter('done');

    expect(useTaskQueryStore.getState().filters).toEqual({
      status: 'done',
      time: 'week',
      agentId: 'all',
      workspace: 'all',
    });
  });

  it('setTimeFilter 只改时间维度，保留状态维度', () => {
    const s = useTaskQueryStore.getState();
    s.setStatusFilter('failed');
    s.setTimeFilter('today');

    expect(useTaskQueryStore.getState().filters).toEqual({
      status: 'failed',
      time: 'today',
      agentId: 'all',
      workspace: 'all',
    });
  });

  it('resetFilters 回到默认，但不触碰关键词', () => {
    const s = useTaskQueryStore.getState();
    s.setStatusFilter('planning');
    s.setTimeFilter('month');
    s.setQuery('牧场');

    useTaskQueryStore.getState().resetFilters();

    expect(useTaskQueryStore.getState().filters).toEqual(DEFAULT_TASK_FILTERS);
    expect(useTaskQueryStore.getState().query).toBe('牧场');
  });

  it('filters 是整体替换而非就地改写（保证订阅者能感知变化）', () => {
    const before = useTaskQueryStore.getState().filters;
    useTaskQueryStore.getState().setStatusFilter('running');
    const after = useTaskQueryStore.getState().filters;

    expect(after).not.toBe(before);
    expect(before.status).toBe('all');
  });
});

describe('taskQueryStore: Agent / 工作空间 维度', () => {
  beforeEach(reset);

  it('setAgentFilter 只改 Agent 维度，保留其它维度', () => {
    const s = useTaskQueryStore.getState();
    s.setStatusFilter('done');
    s.setAgentFilter('a2');

    expect(useTaskQueryStore.getState().filters).toEqual({
      status: 'done',
      time: 'all',
      agentId: 'a2',
      workspace: 'all',
    });
  });

  it('setWorkspaceFilter 只改工作空间维度，保留其它维度', () => {
    const s = useTaskQueryStore.getState();
    s.setTimeFilter('month');
    s.setWorkspaceFilter('D:/proj/x');

    expect(useTaskQueryStore.getState().filters).toEqual({
      status: 'all',
      time: 'month',
      agentId: 'all',
      workspace: 'D:/proj/x',
    });
  });

  it('resetFilters 回到默认（四维全 all），且不触碰关键词', () => {
    const s = useTaskQueryStore.getState();
    s.setAgentFilter('a1');
    s.setWorkspaceFilter('');
    s.setQuery('牧场');

    useTaskQueryStore.getState().resetFilters();

    expect(useTaskQueryStore.getState().filters).toEqual(DEFAULT_TASK_FILTERS);
    expect(useTaskQueryStore.getState().query).toBe('牧场');
  });
});
