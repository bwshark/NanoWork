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
interface SessionUiState {
  /** 右侧产物面板是否展开 */
  artifactPanelOpen: boolean;
  /** 面板当前跟随的会话 id（未展开时为 null） */
  artifactPanelSessionId: string | null;
  openArtifactPanel: (sessionId: string) => void;
  /** 再次点击同一会话的按钮则收起；换会话则直接切换 */
  toggleArtifactPanel: (sessionId: string) => void;
  closeArtifactPanel: () => void;

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

  openArtifactPanel: (sessionId) =>
    set({ artifactPanelOpen: true, artifactPanelSessionId: sessionId }),

  toggleArtifactPanel: (sessionId) => {
    const { artifactPanelOpen, artifactPanelSessionId } = get();
    // 同一会话再点一次 = 收起；不同会话则直接切过去（保持展开）
    if (artifactPanelOpen && artifactPanelSessionId === sessionId) {
      set({ artifactPanelOpen: false });
      return;
    }
    set({ artifactPanelOpen: true, artifactPanelSessionId: sessionId });
  },

  closeArtifactPanel: () => set({ artifactPanelOpen: false }),

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
