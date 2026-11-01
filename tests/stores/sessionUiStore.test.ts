import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionUiStore } from '@/stores/sessionUiStore';

/** 每个用例前把跨组件的 UI 状态复位 */
function reset() {
  useSessionUiStore.setState({
    artifactPanelOpen: false,
    artifactPanelSessionId: null,
    panelBySession: {},
    artifactPanelTabs: [],
    artifactPanelActiveTabId: null,
    artifactPanelFullscreen: false,
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

describe('sessionUiStore: 边栏开合跟随会话', () => {
  beforeEach(reset);

  it('切到的会话没开过边栏 → 收起；切回原会话 → 恢复展开与标签', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    expect(ui().artifactPanelOpen).toBe(true);

    // 左侧点了另一条会话：B 从没开过边栏 → 收起
    ui().switchPanelSession('s2');
    expect(ui().artifactPanelOpen).toBe(false);
    expect(ui().artifactPanelSessionId).toBe('s2');
    expect(ui().artifactPanelTabs).toEqual([]);

    // 切回 A：它记的是「开着」，标签也一起回来
    ui().switchPanelSession('s1');
    expect(ui().artifactPanelOpen).toBe(true);
    expect(ui().artifactPanelTabs.map((t) => t.id)).toEqual(['a1']);
    expect(ui().artifactPanelActiveTabId).toBe('a1');
  });

  it('一方收起后切换，回来仍是收起（开合按会话各自记）', () => {
    const ui = () => useSessionUiStore.getState();
    ui().toggleArtifactPanel('s1');
    ui().closeArtifactPanel();
    ui().switchPanelSession('s2');
    ui().toggleArtifactPanel('s2');
    expect(ui().artifactPanelOpen).toBe(true);

    ui().switchPanelSession('s1');
    expect(ui().artifactPanelOpen).toBe(false);
  });

  it('同会话重复 switch 不动开合（不能把自己刚存的现场覆盖成收起）', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1');
    ui().switchPanelSession('s1');
    expect(ui().artifactPanelOpen).toBe(true);
    expect(ui().artifactPanelSessionId).toBe('s1');
  });

  it('两条会话的标签不串台：各开各的，切回来互不影响', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().switchPanelSession('s2');
    ui().openArtifactPanel('s2', { previewId: 'b1' });
    expect(ui().artifactPanelTabs.map((t) => t.id)).toEqual(['b1']);

    ui().switchPanelSession('s1');
    expect(ui().artifactPanelTabs.map((t) => t.id)).toEqual(['a1']);
  });

  it('全屏不跟着会话跑：切到另一条会话即退出全屏', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1');
    ui().toggleArtifactPanelFullscreen();
    expect(ui().artifactPanelFullscreen).toBe(true);

    ui().switchPanelSession('s2');
    expect(ui().artifactPanelFullscreen).toBe(false);
  });

  it('切回停在「变更」口径的会话 → 口径跟着回来，且不会被误当成「开变更标签」', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { view: 'changes' });
    expect(ui().artifactPanelView).toBe('changes');

    // 另一条会话从「查看所有产物」进来：它自己没记录 → 落到新标签页，口径为全部
    ui().switchPanelSession('s2');
    ui().openArtifactPanel('s2');
    const active = ui().artifactPanelTabs.find((t) => t.id === ui().artifactPanelActiveTabId);
    expect(active?.kind).toBe('list');
    expect(ui().artifactPanelView).toBe('all');

    ui().switchPanelSession('s1');
    expect(ui().artifactPanelView).toBe('changes');
  });
});

describe('sessionUiStore: 产物标签页', () => {
  beforeEach(reset);

  it('同一会话内连开两个产物 → 两个标签，激活的是后打开的那个', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().openArtifactPanel('s1', { previewId: 'a2' });
    expect(ui().artifactPanelTabs.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(ui().artifactPanelActiveTabId).toBe('a2');
  });

  it('重复打开同一产物不产生重复标签，只把它激活', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().openArtifactPanel('s1', { previewId: 'a2' });
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    expect(ui().artifactPanelTabs.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(ui().artifactPanelActiveTabId).toBe('a1');
  });

  it('换会话时标签整体重置（旧会话的产物 id 指不到任何东西）', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().openArtifactPanel('s2', { previewId: 'b1' });
    expect(ui().artifactPanelTabs.map((t) => t.id)).toEqual(['b1']);
    expect(ui().artifactPanelActiveTabId).toBe('b1');
  });

  it('「查看所有变更」开的是变更标签，已打开的产物标签保留', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().openArtifactPanel('s1', { view: 'changes' });
    const active = ui().artifactPanelTabs.find((t) => t.id === ui().artifactPanelActiveTabId);
    expect(active?.kind).toBe('changes');
    expect(ui().artifactPanelTabs.map((t) => t.kind)).toEqual(['artifact', 'changes']);
    expect(ui().artifactPanelView).toBe('changes');
  });

  it('「查看所有产物」（不带 previewId）落到新标签页，已打开的标签保留', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().openArtifactPanel('s1');
    const active = ui().artifactPanelTabs.find((t) => t.id === ui().artifactPanelActiveTabId);
    expect(active?.kind).toBe('list');
    expect(ui().artifactPanelTabs.map((t) => t.kind)).toEqual(['artifact', 'list']);
  });

  it('activateArtifactTab 只认已打开的标签，不给未打开的凭空造标签', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().openArtifactTab('a2');
    ui().activateArtifactTab('a1');
    expect(ui().artifactPanelActiveTabId).toBe('a1');

    ui().activateArtifactTab('never-opened');
    expect(ui().artifactPanelActiveTabId).toBe('a1');
    expect(ui().artifactPanelTabs.map((t) => t.id)).toEqual(['a1', 'a2']);
  });

  it('关闭非当前标签不影响激活项', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().openArtifactTab('a2');
    ui().openArtifactTab('a3');
    ui().activateArtifactTab('a2');

    ui().closeArtifactTab('a1');
    expect(ui().artifactPanelTabs.map((t) => t.id)).toEqual(['a2', 'a3']);
    expect(ui().artifactPanelActiveTabId).toBe('a2');
  });

  it('关闭当前标签 → 激活右邻居；关掉最后一个 → 自动补一个新标签页', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().openArtifactTab('a2');
    ui().activateArtifactTab('a2');

    ui().closeArtifactTab('a2');
    // a2 在末尾，没有右邻居 → 取左邻居 a1
    expect(ui().artifactPanelActiveTabId).toBe('a1');

    ui().openArtifactTab('a3');
    ui().activateArtifactTab('a1');
    ui().closeArtifactTab('a1');
    // a1 后面还有 a3 → 顺位交给右邻居
    expect(ui().artifactPanelActiveTabId).toBe('a3');

    ui().closeArtifactTab('a3');
    // 面板不能留空白：补一个「新标签页」，并激活它
    const tabs = ui().artifactPanelTabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe('list');
    expect(ui().artifactPanelActiveTabId).toBe(tabs[0].id);
  });

  it('同一会话收起面板再展开 → 标签仍在（判据是会话，不是面板开关）', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().closeArtifactPanel();
    expect(ui().artifactPanelOpen).toBe(false);

    ui().toggleArtifactPanel('s1');
    expect(ui().artifactPanelOpen).toBe(true);
    expect(ui().artifactPanelTabs.map((t) => t.id)).toEqual(['a1']);
    expect(ui().artifactPanelActiveTabId).toBe('a1');
  });

  it('closeAllArtifactTabs 关光后留一个新标签页', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().openArtifactTab('a2');
    ui().closeAllArtifactTabs();
    const tabs = ui().artifactPanelTabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe('list');
    expect(ui().artifactPanelActiveTabId).toBe(tabs[0].id);
  });

  it('showArtifactList 回到列表页但不清标签（还能切回去）', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    ui().showArtifactList();
    const active = ui().artifactPanelTabs.find((t) => t.id === ui().artifactPanelActiveTabId);
    expect(active?.kind).toBe('list');
    // 产物标签还在，切回去就能看
    expect(ui().artifactPanelTabs.some((t) => t.id === 'a1')).toBe(true);
  });

  it('快捷入口在「新标签页」上是就地替换，不新开标签（浏览器语义）', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1');
    const listTabId = ui().artifactPanelActiveTabId;

    ui().openFilesTab();
    // 标签数不变，id 不变，只是页面变了
    expect(ui().artifactPanelTabs).toHaveLength(1);
    expect(ui().artifactPanelActiveTabId).toBe(listTabId);
    expect(ui().artifactPanelTabs.find((t) => t.id === listTabId)?.kind).toBe('files');

    // 单例：再点一次只激活，不再开第二个
    ui().openTerminalTab();
    ui().openFilesTab();
    expect(ui().artifactPanelTabs.filter((t) => t.kind === 'files')).toHaveLength(1);
  });
});

describe('sessionUiStore: 新建标签页（网页）与全屏', () => {
  beforeEach(reset);

  it('openWebTab 追加一个空白网页标签并激活，返回其 id', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    const webId = ui().openWebTab();

    const tabs = ui().artifactPanelTabs;
    expect(tabs.map((t) => t.id)).toEqual(['a1', webId]);
    expect(tabs[1]).toMatchObject({ kind: 'web', url: '', history: [], cursor: -1 });
    expect(ui().artifactPanelActiveTabId).toBe(webId);
  });

  it('openWebTab 带 url / doc：url 进历史栈，doc 模式不带地址', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1');
    const fileTab = ui().openWebTab({ url: 'file:///D:/aa/snake.html', label: 'snake.html' });
    const docTab = ui().openWebTab({ doc: '<html/>', label: 'inline.html' });

    expect(ui().artifactPanelTabs[0]).toMatchObject({
      id: fileTab,
      url: 'file:///D:/aa/snake.html',
      history: ['file:///D:/aa/snake.html'],
      cursor: 0,
      label: 'snake.html',
    });
    expect(ui().artifactPanelTabs[1]).toMatchObject({
      id: docTab,
      url: '',
      doc: '<html/>',
      label: 'inline.html',
      cursor: -1,
    });
  });

  it('在产物预览标签里输入真实地址 → 丢掉 doc / label（退出预览模式）', () => {
    const ui = () => useSessionUiStore.getState();
    const id = ui().openWebTab({ doc: '<html/>', label: 'inline.html' });

    // store 只接收**最终 URL**（裸域名 → 可加载地址的归一化在地址栏那一层做）
    ui().navigateWebTab(id, 'https://example.com');

    const tab = ui().artifactPanelTabs[0];
    expect(tab).toMatchObject({ url: 'https://example.com' });
    if (tab.kind !== 'web') throw new Error('unreachable');
    // 留着快照的话，刷新会又跳回那张产物预览 —— 必须一并丢掉
    expect(tab.doc).toBeUndefined();
    expect(tab.label).toBeUndefined();
  });

  it('navigateWebTab 写入历史；空地址 / 同地址一律忽略', () => {
    const ui = () => useSessionUiStore.getState();
    const id = ui().openWebTab();

    ui().navigateWebTab(id, '  http://localhost:5176/  ');
    ui().navigateWebTab(id, 'https://example.com');
    ui().navigateWebTab(id, ''); // 空 → 忽略
    ui().navigateWebTab(id, 'https://example.com'); // 同地址 → 忽略

    expect(ui().artifactPanelTabs[0]).toMatchObject({
      kind: 'web',
      url: 'https://example.com',
      history: ['http://localhost:5176/', 'https://example.com'],
      cursor: 1,
    });
  });

  it('从历史中间提交新地址 → 截断游标之后的记录（浏览器语义）', () => {
    const ui = () => useSessionUiStore.getState();
    const id = ui().openWebTab();
    ui().navigateWebTab(id, 'https://a.com');
    ui().navigateWebTab(id, 'https://b.com');
    ui().stepWebTabHistory(id, -1); // 回到 a
    ui().navigateWebTab(id, 'https://c.com');

    expect(ui().artifactPanelTabs[0]).toMatchObject({
      url: 'https://c.com',
      history: ['https://a.com', 'https://c.com'],
      cursor: 1,
    });
  });

  it('stepWebTabHistory 越界不动（栈底 / 栈顶各试一次）', () => {
    const ui = () => useSessionUiStore.getState();
    const id = ui().openWebTab();
    ui().navigateWebTab(id, 'https://a.com');

    ui().stepWebTabHistory(id, -1);
    expect(ui().artifactPanelTabs[0]).toMatchObject({ url: 'https://a.com', cursor: 0 });
    ui().stepWebTabHistory(id, 1);
    expect(ui().artifactPanelTabs[0]).toMatchObject({ url: 'https://a.com', cursor: 0 });
  });

  it('网页标签与产物标签同栏关闭，邻居顺位对它同样生效', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1', { previewId: 'a1' });
    const webId = ui().openWebTab();

    ui().closeArtifactTab(webId);
    expect(ui().artifactPanelTabs.map((t) => t.id)).toEqual(['a1']);
    expect(ui().artifactPanelActiveTabId).toBe('a1');
  });

  it('全屏可切换；收起面板会一并退出全屏', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1');
    expect(ui().artifactPanelFullscreen).toBe(false);

    ui().toggleArtifactPanelFullscreen();
    expect(ui().artifactPanelFullscreen).toBe(true);

    ui().closeArtifactPanel();
    expect(ui().artifactPanelFullscreen).toBe(false);
  });

  it('换会话时网页标签一起重置（地址栏属于这一次浏览）', () => {
    const ui = () => useSessionUiStore.getState();
    ui().openArtifactPanel('s1');
    const webId = ui().openWebTab();
    ui().navigateWebTab(webId, 'https://a.com');

    ui().openArtifactPanel('s2');
    // 换会话：网页标签整体丢弃，只留一个干净的落地页
    expect(ui().artifactPanelTabs.map((t) => t.kind)).toEqual(['list']);
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
