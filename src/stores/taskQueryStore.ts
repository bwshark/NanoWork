import { create } from 'zustand';
import {
  DEFAULT_TASK_FILTERS,
  type TaskFilters,
  type TaskStatusFilter,
  type TaskTimeFilter,
} from '@/lib/taskQuery';

/**
 * 窗口标题栏「搜索任务 / 筛选任务」的运行期状态（不持久化）。
 *
 * 两者放在同一个 store：筛选条件既作用于侧边栏任务列表，也作用于搜索窗的结果集，
 * 而搜索窗的关键词只作用于自身——拆成两个 store 反而要在三处同步「筛选变了」。
 */
interface TaskQueryState {
  /** 居中搜索窗是否打开 */
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;

  /** 搜索关键词（仅作用于搜索窗结果集） */
  query: string;
  setQuery: (query: string) => void;

  /** 筛选条件（同时作用于侧边栏任务列表与搜索窗结果集） */
  filters: TaskFilters;
  setStatusFilter: (status: TaskStatusFilter) => void;
  setTimeFilter: (time: TaskTimeFilter) => void;
  /** 重置为「全部状态 + 全部时间」，关键词不动（关键词由关闭搜索窗清空） */
  resetFilters: () => void;
  /** 关闭搜索窗时清空关键词，避免下次打开看到上次的残留检索 */
  resetQuery: () => void;
}

export const useTaskQueryStore = create<TaskQueryState>()((set) => ({
  searchOpen: false,
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false, query: '' }),

  query: '',
  setQuery: (query) => set({ query }),

  filters: { ...DEFAULT_TASK_FILTERS },
  setStatusFilter: (status) =>
    set((s) => ({ filters: { ...s.filters, status } })),
  setTimeFilter: (time) => set((s) => ({ filters: { ...s.filters, time } })),
  resetFilters: () => set({ filters: { ...DEFAULT_TASK_FILTERS } }),
  resetQuery: () => set({ query: '' }),
}));
