import { create } from 'zustand';

/**
 * 会话级辅助功能的 UI 状态（非持久化，仅运行期）。
 *
 * 三个入口（对话内搜索 / 历史提问 / 产物面板）分别落在三个区域渲染，
 * 彼此跨组件，因此把开关与定位请求集中在这里：
 * - 产物面板挂载在 AppLayout 右侧；
 * - 搜索条与三个入口按钮都挂在 ChatHeader（会话标题右侧）；
 * - 关键词命中高亮与消息定位由 MessageStream 消费。
 */
/** 产物面板的列表口径：全部产物 / 只看被再次编辑过的（变更） */
export type ArtifactPanelView = 'all' | 'changes';

/** 打开面板时的可选项（由消息底部卡片区 / 变更入口传入） */
export interface ArtifactPanelOpenOptions {
  /** 直接在面板内打开的产物 id（作为标签页）；缺省 = 列表视图 */
  previewId?: string;
  /** 列表口径；缺省 `all` */
  view?: ArtifactPanelView;
}

interface SessionUiState {
  /** 右侧产物面板是否展开 */
  artifactPanelOpen: boolean;
  /** 面板当前跟随的会话 id（未展开时为 null） */
  artifactPanelSessionId: string | null;
  /**
   * 面板内已打开的**产物标签页**（顺序 = 打开顺序，去重）。
   *
   * 面板不再是「列表 / 预览」二态互斥，而是「常驻标签栏 + 列表」：
   * 用户可以同时打开多个产物，靠顶部标签栏来回切。
   * 标签是**会话级**的——换会话时上一会话的产物 id 在新会话里没有任何意义，必须整体重置。
   */
  artifactPanelTabs: string[];
  /**
   * 当前激活的标签页 id；`null` = 列表视图（概览 + 产物列表）。
   *
   * 由消息流里的产物卡片点击写入——「点卡片 → 右侧看内容」是产品要求的主路径，
   * 因此它属于跨组件的 UI 态（与面板开关同源），而不是某个组件内部的 state。
   */
  artifactPanelActiveTabId: string | null;
  /** 面板列表口径（产物 / 变更） */
  artifactPanelView: ArtifactPanelView;
  openArtifactPanel: (sessionId: string, opts?: ArtifactPanelOpenOptions) => void;
  /** 再次点击同一会话的按钮则收起；换会话则直接切换 */
  toggleArtifactPanel: (sessionId: string) => void;
  closeArtifactPanel: () => void;
  /** 打开产物标签：已开则激活，未开则追加到末尾并激活 */
  openArtifactTab: (artifactId: string) => void;
  /** 切到某个已打开的标签（不在标签栏里则忽略，避免凭空造出标签） */
  activateArtifactTab: (artifactId: string) => void;
  /** 关闭标签；关的是当前标签则激活右邻居（无右取左），全关则回列表 */
  closeArtifactTab: (artifactId: string) => void;
  /** 关闭全部标签并回到列表视图 */
  closeAllArtifactTabs: () => void;
  /** 回到列表视图（保留已打开的标签，便于再切回去） */
  showArtifactList: () => void;
  /** 切换面板列表口径（产物 / 变更） */
  setArtifactPanelView: (view: ArtifactPanelView) => void;

  /** 会话内搜索条：展开时记录目标会话 id，null 表示收起 */
  searchSessionId: string | null;
  openSearch: (sessionId: string) => void;
  closeSearch: () => void;

  /**
   * 当前检索关键词。放在 store 而非搜索条组件内，
   * 因为命中高亮由 MessageStream 依据**渲染后的 DOM** 完成，两处必须共享同一关键词。
   */
  searchQuery: string;
  /** 命中总数：由 MessageStream 遍历 DOM 后回填（搜索条只负责展示） */
  searchMatchCount: number;
  /** 当前选中命中的序号（0 基） */
  searchActiveMatch: number;
  /** 改写关键词：游标回到第一个命中 */
  setSearchQuery: (query: string) => void;
  /** 回填命中总数（值未变化时不触发订阅者重渲染） */
  setSearchMatchCount: (count: number) => void;
  /** 上一个 / 下一个命中，按命中总数循环 */
  stepSearchMatch: (delta: number) => void;

  /**
   * 一次性滚动定位请求：MessageStream 消费后立即清空，
   * 这样后续新消息仍能正常触发「自动滚到底部」。
   */
  focusMessageId: string | null;
  /** 定位后保持高亮的消息 id（由 MessageStream 定时清除） */
  highlightMessageId: string | null;
  /** 请求定位到某条消息（同时点亮高亮） */
  focusMessage: (messageId: string) => void;
  clearFocusRequest: () => void;
  clearHighlight: () => void;
}

export const useSessionUiStore = create<SessionUiState>()((set, get) => ({
  artifactPanelOpen: false,
  artifactPanelSessionId: null,
  artifactPanelTabs: [],
  artifactPanelActiveTabId: null,
  artifactPanelView: 'all',

  openArtifactPanel: (sessionId, opts) => {
    const { artifactPanelSessionId, artifactPanelTabs } = get();
    // 判据是**会话**而不是「面板是否开着」：同一会话收起面板再打开，标签应当还在
    // （否则「点 ☰ 看列表 → 收起 → 再打开」会丢掉刚开的一堆产物）；
    // 换了会话才重置——上一会话的产物 id 在新会话里指不到任何东西
    const sameSession = artifactPanelSessionId === sessionId;
    const kept = sameSession ? artifactPanelTabs : [];
    const id = opts?.previewId;
    // 点卡片（带 previewId）是**追加**语义：连点两张卡片应该得到两个标签，
    // 而不是把上一个顶掉——这正是「同时预览多个产物」的入口
    const tabs = id && !kept.includes(id) ? [...kept, id] : kept;
    set({
      artifactPanelOpen: true,
      artifactPanelSessionId: sessionId,
      artifactPanelTabs: tabs,
      // 无 previewId（「查看所有产物 / 变更」）→ 回列表，但保留已打开的标签
      artifactPanelActiveTabId: id ?? null,
      artifactPanelView: opts?.view ?? 'all',
    });
  },

  toggleArtifactPanel: (sessionId) => {
    const { artifactPanelOpen, artifactPanelSessionId } = get();
    // 同一会话再点一次 = 收起；不同会话则直接切过去（保持展开）
    if (artifactPanelOpen && artifactPanelSessionId === sessionId) {
      set({ artifactPanelOpen: false });
      return;
    }
    // 展开（或切到另一个会话）：同会话续用标签，换会话整体重置
    const sameSession = artifactPanelSessionId === sessionId;
    set({
      artifactPanelOpen: true,
      artifactPanelSessionId: sessionId,
      ...(sameSession
        ? {}
        : {
            artifactPanelTabs: [],
            artifactPanelActiveTabId: null,
            artifactPanelView: 'all' as ArtifactPanelView,
          }),
    });
  },

  closeArtifactPanel: () => set({ artifactPanelOpen: false }),

  openArtifactTab: (artifactId) => {
    const { artifactPanelTabs } = get();
    set({
      artifactPanelTabs: artifactPanelTabs.includes(artifactId)
        ? artifactPanelTabs
        : [...artifactPanelTabs, artifactId],
      artifactPanelActiveTabId: artifactId,
    });
  },

  activateArtifactTab: (artifactId) => {
    if (!get().artifactPanelTabs.includes(artifactId)) return;
    set({ artifactPanelActiveTabId: artifactId });
  },

  closeArtifactTab: (artifactId) => {
    const { artifactPanelTabs, artifactPanelActiveTabId } = get();
    const index = artifactPanelTabs.indexOf(artifactId);
    if (index < 0) return;
    const tabs = artifactPanelTabs.filter((id) => id !== artifactId);
    // 关的不是当前标签 → 当前标签不受影响；关的是当前标签 → 让位给右邻居（按下标对齐
    // 过滤后的数组），没有右邻居就取左邻居，一个不剩则回到列表
    const nextActive =
      artifactPanelActiveTabId === artifactId
        ? (tabs[index] ?? tabs[index - 1] ?? null)
        : artifactPanelActiveTabId;
    set({ artifactPanelTabs: tabs, artifactPanelActiveTabId: nextActive });
  },

  closeAllArtifactTabs: () => set({ artifactPanelTabs: [], artifactPanelActiveTabId: null }),

  showArtifactList: () => set({ artifactPanelActiveTabId: null }),

  setArtifactPanelView: (view) => set({ artifactPanelView: view }),

  searchSessionId: null,
  openSearch: (sessionId) =>
    set({
      searchSessionId: sessionId,
      searchQuery: '',
      searchMatchCount: 0,
      searchActiveMatch: 0,
    }),
  closeSearch: () =>
    set({
      searchSessionId: null,
      searchQuery: '',
      searchMatchCount: 0,
      searchActiveMatch: 0,
    }),

  searchQuery: '',
  searchMatchCount: 0,
  searchActiveMatch: 0,

  setSearchQuery: (query) => set({ searchQuery: query, searchActiveMatch: 0 }),

  setSearchMatchCount: (count) => {
    // 只有数量真的变化才写，避免 MessageStream 每次 effect 都触发订阅者重渲染
    if (get().searchMatchCount === count) return;
    set({ searchMatchCount: count });
  },

  stepSearchMatch: (delta) => {
    const { searchMatchCount, searchActiveMatch } = get();
    if (searchMatchCount <= 0) return;
    const next =
      (searchActiveMatch + delta + searchMatchCount) % searchMatchCount;
    set({ searchActiveMatch: next });
  },

  focusMessageId: null,
  highlightMessageId: null,

  focusMessage: (messageId) =>
    set({ focusMessageId: messageId, highlightMessageId: messageId }),

  clearFocusRequest: () => set({ focusMessageId: null }),
  clearHighlight: () => set({ highlightMessageId: null }),
}));
