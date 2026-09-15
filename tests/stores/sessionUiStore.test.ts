import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionUiStore } from '@/stores/sessionUiStore';

/** 每个用例前把跨组件的 UI 状态复位 */
function reset() {
  useSessionUiStore.setState({
    artifactPanelOpen: false,
    artifactPanelSessionId: null,
    searchSessionId: null,
    searchQuery: '',
    searchMatchCount: 0,
    searchActiveMatch: 0,
    focusMessageId: null,
    highlightMessageId: null,
  });
}

describe('sessionUiStore: 产物面板开关', () => {
  beforeEach(reset);

  it('openArtifactPanel 展开并记录跟随的会话', () => {
    useSessionUiStore.getState().openArtifactPanel('s1');
    const s = useSessionUiStore.getState();
    expect(s.artifactPanelOpen).toBe(true);
    expect(s.artifactPanelSessionId).toBe('s1');
  });

  it('同一会话再次 toggle 收起，但保留会话记录', () => {
    useSessionUiStore.getState().toggleArtifactPanel('s1');
    expect(useSessionUiStore.getState().artifactPanelOpen).toBe(true);

    useSessionUiStore.getState().toggleArtifactPanel('s1');
    const s = useSessionUiStore.getState();
    expect(s.artifactPanelOpen).toBe(false);
    // 收起不清空 sessionId，重新展开时仍能续上原会话
    expect(s.artifactPanelSessionId).toBe('s1');
  });

  it('切换会话时直接跟随新会话，不收起面板', () => {
    useSessionUiStore.getState().toggleArtifactPanel('s1');
    useSessionUiStore.getState().toggleArtifactPanel('s2');
    const s = useSessionUiStore.getState();
    expect(s.artifactPanelOpen).toBe(true);
    expect(s.artifactPanelSessionId).toBe('s2');
  });

  it('closeArtifactPanel 收起面板', () => {
    useSessionUiStore.getState().openArtifactPanel('s1');
    useSessionUiStore.getState().closeArtifactPanel();
    expect(useSessionUiStore.getState().artifactPanelOpen).toBe(false);
  });
});

describe('sessionUiStore: 对话内搜索', () => {
  beforeEach(reset);

  it('openSearch 记录目标会话，closeSearch 清空', () => {
    useSessionUiStore.getState().openSearch('s1');
    expect(useSessionUiStore.getState().searchSessionId).toBe('s1');

    useSessionUiStore.getState().closeSearch();
    expect(useSessionUiStore.getState().searchSessionId).toBeNull();
  });

  it('openSearch 重置关键词/命中数/游标（换会话不带旧检索态）', () => {
    useSessionUiStore.setState({
      searchQuery: '网关',
      searchMatchCount: 17,
      searchActiveMatch: 5,
    });
    useSessionUiStore.getState().openSearch('s2');
    const s = useSessionUiStore.getState();
    expect(s.searchQuery).toBe('');
    expect(s.searchMatchCount).toBe(0);
    expect(s.searchActiveMatch).toBe(0);
  });

  it('closeSearch 一并清空关键词与命中统计', () => {
    useSessionUiStore.setState({
      searchSessionId: 's1',
      searchQuery: '网关',
      searchMatchCount: 17,
      searchActiveMatch: 5,
    });
    useSessionUiStore.getState().closeSearch();
    const s = useSessionUiStore.getState();
    expect(s.searchQuery).toBe('');
    expect(s.searchMatchCount).toBe(0);
    expect(s.searchActiveMatch).toBe(0);
  });

  it('setSearchQuery 改写关键词并把游标复位到首个命中', () => {
    useSessionUiStore.setState({ searchActiveMatch: 4, searchMatchCount: 9 });
    useSessionUiStore.getState().setSearchQuery('网关');
    const s = useSessionUiStore.getState();
    expect(s.searchQuery).toBe('网关');
    expect(s.searchActiveMatch).toBe(0);
  });

  it('stepSearchMatch 在命中间循环（末尾回绕到首个）', () => {
    useSessionUiStore.setState({ searchMatchCount: 3, searchActiveMatch: 0 });
    const step = () => useSessionUiStore.getState().stepSearchMatch(1);

    step();
    expect(useSessionUiStore.getState().searchActiveMatch).toBe(1);
    step();
    expect(useSessionUiStore.getState().searchActiveMatch).toBe(2);
    step();
    expect(useSessionUiStore.getState().searchActiveMatch).toBe(0);
  });

  it('stepSearchMatch 反向同样回绕（首个退到末尾）', () => {
    useSessionUiStore.setState({ searchMatchCount: 3, searchActiveMatch: 0 });
    useSessionUiStore.getState().stepSearchMatch(-1);
    expect(useSessionUiStore.getState().searchActiveMatch).toBe(2);
  });

  it('无命中时 stepSearchMatch 不改变游标', () => {
    useSessionUiStore.setState({ searchMatchCount: 0, searchActiveMatch: 0 });
    useSessionUiStore.getState().stepSearchMatch(1);
    expect(useSessionUiStore.getState().searchActiveMatch).toBe(0);
  });

  it('setSearchMatchCount 数量未变化时不通知订阅者', () => {
    useSessionUiStore.setState({ searchMatchCount: 7 });
    let notified = 0;
    const unsub = useSessionUiStore.subscribe(() => {
      notified += 1;
    });
    useSessionUiStore.getState().setSearchMatchCount(7);
    expect(notified).toBe(0);

    useSessionUiStore.getState().setSearchMatchCount(8);
    expect(notified).toBe(1);
    unsub();
  });
});

describe('sessionUiStore: 消息定位请求', () => {
  beforeEach(reset);

  it('focusMessage 同时点亮定位请求与高亮', () => {
    useSessionUiStore.getState().focusMessage('m1');
    const s = useSessionUiStore.getState();
    expect(s.focusMessageId).toBe('m1');
    expect(s.highlightMessageId).toBe('m1');
  });

  it('消费定位请求只清 focus，高亮继续保留到自动消退', () => {
    useSessionUiStore.getState().focusMessage('m1');
    useSessionUiStore.getState().clearFocusRequest();
    const s = useSessionUiStore.getState();
    expect(s.focusMessageId).toBeNull();
    // 关键：清 focus 不能顺手清高亮，否则定位后目标消息不会被点亮
    expect(s.highlightMessageId).toBe('m1');
  });

  it('clearHighlight 单独清理高亮', () => {
    useSessionUiStore.getState().focusMessage('m1');
    useSessionUiStore.getState().clearHighlight();
    expect(useSessionUiStore.getState().highlightMessageId).toBeNull();
  });

  it('连续定位到不同消息时高亮跟随切换', () => {
    useSessionUiStore.getState().focusMessage('m1');
    useSessionUiStore.getState().clearFocusRequest();
    useSessionUiStore.getState().focusMessage('m2');
    const s = useSessionUiStore.getState();
    expect(s.focusMessageId).toBe('m2');
    expect(s.highlightMessageId).toBe('m2');
  });
});
