/**
 * 侧栏「助理」Tab 的渠道筛选态（FR-6.4）。
 *
 * 为什么它必须在 store 里而不是组件 state：Tab 切换是条件渲染
 * （`tab === 'tasks' ? <SessionList/> : <ChannelSessionList/>`），
 * 切走再回来 `ChannelSessionList` 会重挂载，组件内的筛选会被重置成「全部」——
 * 用户每切一次 Tab 就要重选一遍渠道。这条用例钉的就是「状态活在组件之外」。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionUiStore } from '@/stores/sessionUiStore';

beforeEach(() => {
  useSessionUiStore.setState({ channelFilter: null });
});

describe('频道筛选态', () => {
  it('默认是「全部」（null），不是某个具体渠道', () => {
    expect(useSessionUiStore.getState().channelFilter).toBeNull();
  });

  it('设置后写进 store，组件重挂载也读得到', () => {
    useSessionUiStore.getState().setChannelFilter('weixin');
    // 模拟「切走 Tab 再切回来」：重新读一次 store（组件会重新订阅）
    expect(useSessionUiStore.getState().channelFilter).toBe('weixin');
  });

  it('可以切回「全部」', () => {
    useSessionUiStore.getState().setChannelFilter('wecom');
    useSessionUiStore.getState().setChannelFilter(null);
    expect(useSessionUiStore.getState().channelFilter).toBeNull();
  });

  it('存的是分组键（原始首段），不是展示名', () => {
    // 展示名会随后端渠道表变（`channelLabel` 的入参是原始名），
    // 拿展示名当键会在改名后静默筛空 —— 所以这里断言存进去的就是原样字符串。
    useSessionUiStore.getState().setChannelFilter('feishu');
    expect(useSessionUiStore.getState().channelFilter).toBe('feishu');
  });
});
