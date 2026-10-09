import { create } from 'zustand';
import { genId } from '@/lib/id';
import type { QuoteRef } from '@/lib/selectionQuote';

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

/**
 * 面板里的一个**标签页**。
 *
 * 标签栏是异构的：产物预览（`artifact`）与「+ 新建标签页」开出来的网页（`web`）混排。
 * 因此标签不能再用裸 id 表达 —— 渲染时得知道该画产物正文还是地址栏。
 *
 * 网页标签自带**历史栈**：iframe 的内容窗口跨域，`contentWindow.history` 碰不得，
 * 后退 / 前进只能自己记（地址栏是唯一的导航入口）。
 */
export type ArtifactPanelTab =
  | { id: string; kind: 'artifact' }
  | {
      id: string;
      kind: 'web';
      /** 当前地址；空串 = 还没输入（就是那个写着「输入网址」的空白新标签） */
      url: string;
      /** 访问过的地址栈（提交新地址时截断游标之后的部分） */
      history: string[];
      /** 在 `history` 中的位置；-1 = 栈空 */
      cursor: number;
      /**
       * 「产物预览」模式的文档正文（围栏 html 产物没有磁盘文件，只能把源码直接喂给
       * iframe）。有它时优先于 `url` 渲染 —— 用户在地址栏输入真实地址后即退出这个模式。
       */
      doc?: string;
      /** 展示名（`doc` 模式或 `file://` 打开时用产物文件名，比一串路径好读） */
      label?: string;
    };

interface SessionUiState {
  /** 右侧产物面板是否展开 */
  artifactPanelOpen: boolean;
  /** 面板当前跟随的会话 id（未展开时为 null） */
  artifactPanelSessionId: string | null;
  /**
   * 面板内已打开的**标签页**（顺序 = 打开顺序；产物按 id 去重）。
   *
   * 面板不再是「列表 / 预览」二态互斥，而是「常驻标签栏 + 列表」：
   * 用户可以同时打开多个产物 / 网页，靠顶部标签栏来回切。
   * 标签是**会话级**的——换会话时上一会话的产物 id 在新会话里没有任何意义，必须整体重置
   * （网页标签同样重置：它的地址栏属于这一次浏览）。
   */
  artifactPanelTabs: ArtifactPanelTab[];
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
  /**
   * 面板是否**全屏**（铺满整个窗口，对话区让位）。
   *
   * 只动面板自己的定位（`fixed; inset: 0`），**不卸载**对话区与面板内容：
   * 换一种布局就重建 DOM 的话，网页标签的 iframe 会白屏重载、产物正文的滚动位置全丢。
   */
  artifactPanelFullscreen: boolean;
  /** 打开产物标签：已开则激活，未开则追加到末尾并激活 */
  openArtifactTab: (artifactId: string) => void;
  /**
   * 「+ 新建标签页」：追加一个网页标签并激活，返回新标签 id。
   *
   * 不传参数 = 空白标签（用户自己输地址）；传 `url` = 直接打开；
   * 传 `doc` = 用源码快照渲染（html 产物没有磁盘文件时的「在网页标签打开」）。
   */
  openWebTab: (opts?: { url?: string; doc?: string; label?: string }) => string;
  /** 提交网页标签的地址（写进历史栈；空串 / 与当前相同则忽略） */
  navigateWebTab: (tabId: string, url: string) => void;
  /** 网页标签后退 / 前进（delta = -1 / +1；越界不动） */
  stepWebTabHistory: (tabId: string, delta: number) => void;
  /** 切到某个已打开的标签（不在标签栏里则忽略，避免凭空造出标签） */
  activateArtifactTab: (tabId: string) => void;
  /** 关闭标签；关的是当前标签则激活右邻居（无右取左），全关则回列表 */
  closeArtifactTab: (tabId: string) => void;
  /** 关闭全部标签并回到列表视图 */
  closeAllArtifactTabs: () => void;
  /** 回到列表视图（保留已打开的标签，便于再切回去） */
  showArtifactList: () => void;
  /** 切换全屏（也可显式设值） */
  toggleArtifactPanelFullscreen: () => void;
  setArtifactPanelFullscreen: (fullscreen: boolean) => void;
  /** 切换面板列表口径（产物 / 变更） */
  setArtifactPanelView: (view: ArtifactPanelView) => void;

  /**
   * 侧栏「助理」Tab 的渠道筛选：`null` = 全部渠道，否则是渠道**分组键**
   * （`channelGroupKey` 的原始首段，如 `weixin` / `feishu` / 未知渠道的自身名）。
   *
   * 放在 store 而不是 ChannelSessionList 的组件 state：Tab 切换是条件渲染
   * （`tab === 'tasks' ? <SessionList/> : <ChannelSessionList/>`），切走再回来
   * 组件会重挂载，组件内的筛选会被重置成「全部」——用户每切一次就要重选一遍。
   *
   * 存的是**分组键**而不是展示名：展示名会随后端渠道表变（`channelLabel` 的入参是
   * 原始名），拿展示名当键会在改名后静默筛空。
   */
  channelFilter: string | null;
  setChannelFilter: (key: string | null) => void;

  /**
   * 「选中文本 → 添加到对话」的引用列表。
   *
   * 放在 store 而非输入区组件内，是因为它有**两个读者**：消息流要按它在原文上
   * 画虚线下划线（原文在消息 DOM 里，不在输入区），输入区要把它画成可删除的胶囊。
   *
   * 刻意**不持久化**：它是「这一次输入还没发出去」的临时附着物；落了盘的话，
   * 重启后凭空冒出几个引用胶囊，用户没有任何办法解释它们从哪来。
   */
  quotes: QuoteRef[];
  /**
   * 新增一条引用（胶囊里出现 + 原文画下划线）。
   * 按「会话 + 消息 + 原文」去重：同一段文字加两次只会得到一枚胶囊。
   */
  addQuote: (quote: Omit<QuoteRef, 'id'>) => void;
  /** 删除一条引用（胶囊上的 ×）：原文的下划线随之消失 */
  removeQuote: (id: string) => void;
  /** 清空全部引用（发送成功后调用） */
  clearQuotes: () => void;
  /** 只保留某个会话的引用（切会话时调用；`null` = 全部清掉） */
  pruneQuotes: (sessionId: string | null) => void;

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
  artifactPanelFullscreen: false,
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
    const tabs: ArtifactPanelTab[] =
      id !== undefined && !kept.some((t) => t.id === id)
        ? [...kept, { id, kind: 'artifact' }]
        : kept;
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
      // 收起时一并退出全屏：否则下次打开会毫无征兆地铺满整个窗口
      set({ artifactPanelOpen: false, artifactPanelFullscreen: false });
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

  closeArtifactPanel: () =>
    set({ artifactPanelOpen: false, artifactPanelFullscreen: false }),

  openArtifactTab: (artifactId) => {
    const { artifactPanelTabs } = get();
    set({
      artifactPanelTabs: artifactPanelTabs.some((t) => t.id === artifactId)
        ? artifactPanelTabs
        : [...artifactPanelTabs, { id: artifactId, kind: 'artifact' }],
      artifactPanelActiveTabId: artifactId,
    });
  },

  openWebTab: (opts) => {
    const id = `web-${genId()}`;
    const url = opts?.url?.trim() ?? '';
    const doc = opts?.doc ?? '';
    set((s) => ({
      artifactPanelTabs: [
        ...s.artifactPanelTabs,
        {
          id,
          kind: 'web',
          url,
          history: url === '' ? [] : [url],
          cursor: url === '' ? -1 : 0,
          ...(doc !== '' ? { doc } : {}),
          ...(opts?.label ? { label: opts.label } : {}),
        },
      ],
      artifactPanelActiveTabId: id,
    }));
    return id;
  },

  navigateWebTab: (tabId, url) =>
    set((s) => ({
      artifactPanelTabs: s.artifactPanelTabs.map((t) => {
        if (t.id !== tabId || t.kind !== 'web') return t;
        const next = url.trim();
        if (next === '' || next === t.url) return t;
        // 从历史中间提交新地址 = 开新分支：游标之后的记录丢弃（与浏览器一致）。
        // 同时**丢掉 `doc` / `label`**：用户既然输入了真地址，这个标签就不再是
        // 「某产物的预览」，留着快照会让刷新又跳回旧内容
        const history = [...t.history.slice(0, t.cursor + 1), next];
        return { id: t.id, kind: 'web', url: next, history, cursor: history.length - 1 };
      }),
    })),

  stepWebTabHistory: (tabId, delta) =>
    set((s) => ({
      artifactPanelTabs: s.artifactPanelTabs.map((t) => {
        if (t.id !== tabId || t.kind !== 'web') return t;
        const cursor = t.cursor + delta;
        if (cursor < 0 || cursor >= t.history.length) return t;
        return { ...t, cursor, url: t.history[cursor] };
      }),
    })),

  activateArtifactTab: (artifactId) => {
    if (!get().artifactPanelTabs.some((t) => t.id === artifactId)) return;
    set({ artifactPanelActiveTabId: artifactId });
  },

  closeArtifactTab: (artifactId) => {
    const { artifactPanelTabs, artifactPanelActiveTabId } = get();
    const index = artifactPanelTabs.findIndex((t) => t.id === artifactId);
    if (index < 0) return;
    const tabs = artifactPanelTabs.filter((t) => t.id !== artifactId);
    // 关的不是当前标签 → 当前标签不受影响；关的是当前标签 → 让位给右邻居（按下标对齐
    // 过滤后的数组），没有右邻居就取左邻居，一个不剩则回到列表
    const neighbor = tabs[index] ?? tabs[index - 1] ?? null;
    const nextActive =
      artifactPanelActiveTabId === artifactId ? (neighbor?.id ?? null) : artifactPanelActiveTabId;
    set({ artifactPanelTabs: tabs, artifactPanelActiveTabId: nextActive });
  },

  closeAllArtifactTabs: () => set({ artifactPanelTabs: [], artifactPanelActiveTabId: null }),

  showArtifactList: () => set({ artifactPanelActiveTabId: null }),

  toggleArtifactPanelFullscreen: () =>
    set((s) => ({ artifactPanelFullscreen: !s.artifactPanelFullscreen })),

  setArtifactPanelFullscreen: (fullscreen) => set({ artifactPanelFullscreen: fullscreen }),

  setArtifactPanelView: (view) => set({ artifactPanelView: view }),

  channelFilter: null,
  setChannelFilter: (key) => set({ channelFilter: key }),

  quotes: [],

  addQuote: (quote) =>
    set((s) => {
      // 同一段原文重复添加 → 幂等：连点两次不该出现两枚一模一样的胶囊
      const exists = s.quotes.some(
        (q) =>
          q.sessionId === quote.sessionId &&
          q.messageId === quote.messageId &&
          q.text === quote.text,
      );
      if (exists) return {};
      /** 单会话上限：超出时从最旧开始丢（引用只是临时附着物，不该无限堆在输入区） */
      const MAX_QUOTES = 20;
      const next = [...s.quotes, { ...quote, id: genId() }];
      // 上限只约束**同一个会话**：别的会话的引用在切回去之前一直有效，
      // 拿它们占额度会出现「在 A 里加满 → 回到 B 加不进去」这种怪事
      const sameSession = next.filter((q) => q.sessionId === quote.sessionId);
      if (sameSession.length <= MAX_QUOTES) return { quotes: next };
      const drop = new Set(
        sameSession.slice(0, sameSession.length - MAX_QUOTES).map((q) => q.id),
      );
      return { quotes: next.filter((q) => !drop.has(q.id)) };
    }),

  removeQuote: (id) => set((s) => ({ quotes: s.quotes.filter((q) => q.id !== id) })),

  clearQuotes: () => set({ quotes: [] }),

  pruneQuotes: (sessionId) =>
    set((s) => {
      // 没有可清理的东西时返回空补丁：MessageStream 在会话切换时无条件调它，
      // 每次都回一个「新数组」会让订阅它的组件白重渲染一轮
      if (sessionId === null) return s.quotes.length === 0 ? {} : { quotes: [] };
      const kept = s.quotes.filter((q) => q.sessionId === sessionId);
      return kept.length === s.quotes.length ? {} : { quotes: kept };
    }),

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
