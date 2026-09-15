import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import { DEFAULT_GATEWAY } from '@/lib/constants';

/**
 * 侧边栏「工作空间分组」相关的两处 settings 行为。
 *
 * 单测针对的是两个容易被写错的边界：
 * 1. `setWorkspaceAlias` 的**判等基线**。自动任务分组的默认显示名是
 *    「自动任务-{日期}」，不是路径末级目录名；若仍按 dirBasename 判等，
 *    用户把它改回默认名时表项永远清不掉（重命名看起来「删不掉」）。
 * 2. `hideSessions` 的幂等性。「从列表中移除」在重复触发（连点、
 *    或同一分组两次移除）时不应把同一个 id 反复写进表里。
 */

function resetSettings() {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: DEFAULT_GATEWAY,
      apiToken: '',
      theme: 'dark',
      memoryEnabled: true,
      autoSummarize: false,
      transcription: DEFAULT_TRANSCRIPTION,
      desktop: DEFAULT_DESKTOP,
      workspaceAliases: {},
      sidebarCollapsed: false,
      hiddenSessions: [],
    },
    status: 'offline',
  });
}

const aliases = () => useSettingsStore.getState().settings.workspaceAliases ?? {};
const hidden = () => useSettingsStore.getState().settings.hiddenSessions ?? [];

beforeEach(resetSettings);

describe('setWorkspaceAlias：判等基线可由调用方指定', () => {
  it('别名与传入的 fallback 不同时写入表项', () => {
    useSettingsStore
      .getState()
      .setWorkspaceAlias('__cron__:abc', '每日巡检', '自动任务-2026-09-13');
    expect(aliases()['__cron__:abc']).toBe('每日巡检');
  });

  it('别名与 fallback 相同时不占表项（等同恢复默认名）', () => {
    useSettingsStore
      .getState()
      .setWorkspaceAlias('__cron__:abc', '每日巡检', '自动任务-2026-09-13');
    expect(aliases()['__cron__:abc']).toBe('每日巡检');

    useSettingsStore
      .getState()
      .setWorkspaceAlias('__cron__:abc', '自动任务-2026-09-13', '自动任务-2026-09-13');
    expect(aliases()['__cron__:abc']).toBeUndefined();
  });

  it('自动任务分组的 key 不含路径分隔符：仍按 fallback 判等而非 dirBasename', () => {
    // 若判等基线错误地回退到 dirBasename(key)，这里会得到 '__cron__:abc'，
    // 于是「改回默认名」不清除表项、留下一条永远不会被用到的脏数据
    useSettingsStore
      .getState()
      .setWorkspaceAlias('__cron__:abc', '自动任务-2026-09-13', '自动任务-2026-09-13');
    expect(aliases()['__cron__:abc']).toBeUndefined();
  });

  it('未传 fallback 时回退到路径末级目录名判等（真实目录分组）', () => {
    useSettingsStore
      .getState()
      .setWorkspaceAlias('D:\\work\\ranch', '牧场项目', undefined);
    expect(aliases()['D:\\work\\ranch']).toBe('牧场项目');

    useSettingsStore
      .getState()
      .setWorkspaceAlias('D:\\work\\ranch', 'ranch', undefined);
    expect(aliases()['D:\\work\\ranch']).toBeUndefined();
  });

  it('空白别名一律清除（含首尾空格）', () => {
    useSettingsStore.getState().setWorkspaceAlias('D:\\work\\ranch', '牧场项目');
    useSettingsStore.getState().setWorkspaceAlias('D:\\work\\ranch', '   ');
    expect(aliases()['D:\\work\\ranch']).toBeUndefined();
  });
});

describe('hideSessions：「从列表中移除」的隐藏表', () => {
  it('追加会话 id，且不影响其他会话', () => {
    useSettingsStore.getState().hideSessions(['s1', 's2']);
    expect(hidden().sort()).toEqual(['s1', 's2']);

    useSettingsStore.getState().hideSessions(['s3']);
    expect(hidden().sort()).toEqual(['s1', 's2', 's3']);
  });

  it('重复调用幂等：同一 id 不会重复写入', () => {
    useSettingsStore.getState().hideSessions(['s1']);
    useSettingsStore.getState().hideSessions(['s1']);
    useSettingsStore.getState().hideSessions(['s1', 's2']);
    expect(hidden().sort()).toEqual(['s1', 's2']);
  });

  it('空数组短路：直接返回原 state，不产生新的数组引用', () => {
    useSettingsStore.getState().hideSessions(['s1']);
    const before = useSettingsStore.getState().settings.hiddenSessions;

    useSettingsStore.getState().hideSessions([]);
    expect(useSettingsStore.getState().settings.hiddenSessions).toBe(before);
  });

  it('全部为已存在 id 时同样不产生新引用（避免无意义重渲染）', () => {
    useSettingsStore.getState().hideSessions(['s1']);
    const before = useSettingsStore.getState().settings.hiddenSessions;

    useSettingsStore.getState().hideSessions(['s1']);
    expect(useSettingsStore.getState().settings.hiddenSessions).toBe(before);
  });
});
