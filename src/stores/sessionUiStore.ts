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
  /** 直接在面板内预览的产物 id；缺省 = 列表视图 */
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
   * 面板内正在预览的产物 id。
   *
   * 有值即进入**预览态**（列表让位给预览，顶部有返回入口）；`null` = 列表态。
   * 由消息流里的产物卡片点击写入——「点卡片 → 右侧看内容」是产品要求的主路径，
   * 因此它属于跨组件的 UI 态（与面板开关同源），而不是某个组件内部的 state。
   */
  artifactPanelPreviewId: string | null;
  /** 面板列表口径（产物 / 变更） */
  artifactPanelView: ArtifactPanelView;
  openArtifactPanel: (sessionId: string, opts?: ArtifactPanelOpenOptions) => void;
  /** 再次点击同一会话的按钮则收起；换会话则直接切换 */
  toggleArtifactPanel: (sessionId: string) => void;
  closeArtifactPanel: () => void;
  /** 在面板内切换预览的产物（传 null 回到列表） */
  setArtifactPanelPreview: (artifactId: string | null) => void;
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
  artifactPanelPreviewId: null,
  artifactPanelView: 'all',

  openArtifactPanel: (sessionId, opts) =>
    set({
      artifactPanelOpen: true,
      artifactPanelSessionId: sessionId,
      // 换会话时上一会话的预览 id 无意义，必须一并重置
      artifactPanelPreviewId: opts?.previewId ?? null,
      artifactPanelView: opts?.view ?? 'all',
    }),

  toggleArtifactPanel: (sessionId) => {
    const { artifactPanelOpen, artifactPanelSessionId } = get();
    // 同一会话再点一次 = 收起；不同会话则直接切过去（保持展开）
    if (artifactPanelOpen && artifactPanelSessionId === sessionId) {
      set({ artifactPanelOpen: false });
      return;
    }
    set({
      artifactPanelOpen: true,
      artifactPanelSessionId: sessionId,
      artifactPanelPreviewId: null,
      artifactPanelView: 'all',
    });
  },

  closeArtifactPanel: () => set({ artifactPanelOpen: false }),

  setArtifactPanelPreview: (artifactId) => set({ artifactPanelPreviewId: artifactId }),

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
