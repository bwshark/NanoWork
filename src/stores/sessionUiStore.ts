import { create } from 'zustand';
import { genId } from '@/lib/core/id';
import type { QuoteRef } from '@/lib/editor/selectionQuote';

/**
 * 会话级辅助功能的 UI 状态（非持久化，仅运行期）。
 *
 * 三个入口（对话内搜索 / 历史提问 / 产物面板）分别落在三个区域渲染，
 * 彼此跨组件，因此把开关与定位请求集中在这里：
 * - 产物面板挂载在 AppLayout 右侧；
 * - 搜索条与三个入口按钮都挂在 ChatHeader（会话标题右侧）；
 * - 关键词命中高亮与消息定位由 MessageStream 消费。
 *
 * 面板还有一个**会话级**的口径：它记住「这条会话上次是开着还是收着」，切换会话时
 * 按对方的记录还原（`panelBySession` + `switchPanelSession`）。
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
 * 标签栏是异构的：产物预览、网页、工作空间文件树、变更、终端、以及「新标签页」
 * （会话概况 + 快捷入口 + 产物列表）混排。因此标签不能再用裸 id 表达 ——
 * 渲染时得知道该画哪一种页面。
 *
 * ## 为什么「新标签页」也是一个标签，而不是 `activeTabId === null`
 *
 * 参考稿（WorkBuddy 右栏）是浏览器模型：快捷入口点下去，**当前那个新标签页本身**
 * 变成「文件 / 变更 / 终端」——标题和图标就地切换，标签数不变。要做到这一点，
 * 「新标签页」必须是标签数组里的一员（可以被就地替换），而不是一个平行状态。
 *
 * `activeTabId === null` 因此只剩一个含义：**拉起的旧状态 / 会话刚切换**，
 * 渲染层遇到它一律当作「显示新标签页」处理（见 `ArtifactPanel` 的兜底）。
 *
 * 网页标签自带**历史栈**：iframe 的内容窗口跨域，`contentWindow.history` 碰不得，
 * 后退 / 前进只能自己记（地址栏是唯一的导航入口）。
 */
export type ArtifactPanelTab =
  /** 新标签页：会话概况 + 四个快捷入口 + 产物列表 */
  | { id: string; kind: 'list' }
  /** 工作空间文件树（会话级单例：再点一次只是激活，不再开第二个） */
  | { id: string; kind: 'files' }
  /** 工作区变更（git status + diff，会话级单例） */
  | { id: string; kind: 'changes' }
  /** 面板内终端（每次点「打开终端」都是新会话，故不做单例） */
  | { id: string; kind: 'terminal'; title: string }
  /** 从文件树点开的单个文件（只读预览；同路径复用同一标签） */
  | { id: string; kind: 'file'; path: string; name: string }
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

/**
 * 「打开一个页面」的统一规则（快捷入口 / 文件预览共用）。
 *
 * 三条约束按顺序生效：
 * 1. 单例页面（文件树 / 变更）已存在 → 只激活，不重复开；
 * 2. 当前标签是**新标签页** → 就地替换它（浏览器语义，也是参考稿的行为）；
 * 3. 其余情况 → 追加到末尾并激活。
 *
 * `make` 每次返回**全新 id**：就地替换要保留原 id（标签身份不变），但新建的页面
 * 不能复用旧 id，否则「关掉再开」会得到两个同 id 的标签，激活项指向谁就说不清了。
 */
function openPage(
  tabs: ArtifactPanelTab[],
  activeId: string | null,
  make: () => ArtifactPanelTab,
  singleton?: ArtifactPanelTab['kind'],
): { tabs: ArtifactPanelTab[]; activeId: string } {
  if (singleton !== undefined) {
    const existing = tabs.find((t) => t.kind === singleton);
    if (existing) return { tabs, activeId: existing.id };
  }
  const active = activeId === null ? undefined : tabs.find((t) => t.id === activeId);
  if (active && active.kind === 'list') {
    const page = make();
    return {
      tabs: tabs.map((t) => (t.id === active.id ? ({ ...page, id: active.id } as ArtifactPanelTab) : t)),
      activeId: active.id,
    };
  }
  const page = make();
  return { tabs: [...tabs, page], activeId: page.id };
}

/** 新建一个「新标签页」标签（关光所有标签时也要留一个，否则面板会变成空白页） */
function makeListTab(): ArtifactPanelTab {
  return { id: `list-${genId()}`, kind: 'list' };
}

/**
 * 一条会话的右侧边栏**现场**。
 *
 * 面板是会话级的：在 A 会话里开了「文件」标签、又点了产物预览，然后收起；切到 B
 * 再切回 A，看到的仍该是 A 那一套。因此现场（开合 / 标签 / 激活项 / 列表口径）
 * 按会话 id 存一份——切走时存、换入时取。
 *
 * 宽度与全屏刻意**不入现场**：
 * - 宽度是用户对窗口的偏好（拖一次就该到处生效），跟着会话来回跳像是拖动失效；
 * - 全屏是「这一次查看」的临时模式，带进新会话等于一进来就铺满整窗。
 */
interface PanelSnapshot {
  open: boolean;
  tabs: ArtifactPanelTab[];
  activeTabId: string | null;
  view: ArtifactPanelView;
}

/** `migratePanel` 的补丁：字段都给全，调用方可直接读而不用非空断言 */
interface PanelMigrated {
  panelBySession: Record<string, PanelSnapshot>;
  artifactPanelSessionId: string | null;
  artifactPanelOpen: boolean;
  artifactPanelTabs: ArtifactPanelTab[];
  artifactPanelActiveTabId: string | null;
  artifactPanelView: ArtifactPanelView;
  artifactPanelFullscreen: boolean;
}

/** 从当前 state 摘一份现场 */
function snapshotPanel(s: SessionUiState): PanelSnapshot {
  return {
    open: s.artifactPanelOpen,
    tabs: s.artifactPanelTabs,
    activeTabId: s.artifactPanelActiveTabId,
    view: s.artifactPanelView,
  };
}

/**
 * 换会话：把当前会话的现场存回快照表，再把目标会话的现场换进来。
 *
 * 目标会话没有快照 = 它从没在这里开过面板 → 收起、空标签（面板层会自动补落地页）。
 * 调用方必须先确认「当前跟随的会话 ≠ 目标会话」，否则会把目标会话自己的现场覆盖掉。
 */
function migratePanel(s: SessionUiState, toSessionId: string | null): PanelMigrated {
  const from = s.artifactPanelSessionId;
  const table =
    from === null ? s.panelBySession : { ...s.panelBySession, [from]: snapshotPanel(s) };
  const snap = toSessionId === null ? undefined : table[toSessionId];
  return {
    panelBySession: table,
    artifactPanelSessionId: toSessionId,
    artifactPanelOpen: snap?.open ?? false,
    artifactPanelTabs: snap?.tabs ?? [],
    artifactPanelActiveTabId: snap?.activeTabId ?? null,
    artifactPanelView: snap?.view ?? 'all',
    // 切会话顺带退出全屏：否则「在 A 全屏 → 切到 B」会让 B 一进来就铺满整窗，
    // 而 B 自己从没要求过全屏
    artifactPanelFullscreen: false,
  };
}

interface SessionUiState {
  /** 右侧产物面板是否展开（**当前跟随会话**的现场） */
  artifactPanelOpen: boolean;
  /** 面板当前跟随的会话 id；面板收起时也保留，供同会话重新展开时续上标签 */
  artifactPanelSessionId: string | null;
  /**
   * 每个会话各自的右侧边栏现场，键为会话 id。
   *
   * 只存内存：面板开合是「这次运行里看到哪儿」的临时状态，落盘后重启会凭空展开一块
   * 用户没有要求过的面板（与 `quotes` 不持久化同理）。
   */
  panelBySession: Record<string, PanelSnapshot>;
  /**
   * 面板内已打开的**标签页**（顺序 = 打开顺序；产物按 id 去重）。
   *
   * 面板不再是「列表 / 预览」二态互斥，而是「常驻标签栏 + 列表」：
   * 用户可以同时打开多个产物 / 网页，靠顶部标签栏来回切。
   * 标签是**会话级**的——换会话时上一会话的产物 id 在新会话里没有任何意义，
   * 因此整套标签跟着现场一起换出 / 换入（见 `panelBySession`），而不是留下来串台。
   */
  artifactPanelTabs: ArtifactPanelTab[];
  /**
   * 当前激活的标签页 id；`null` 只出现在「面板刚被拉起 / 会话已切换」这类
   * 还没建标签的时刻，渲染层一律把它当「新标签页」处理。
   */
  artifactPanelActiveTabId: string | null;
  /** 面板列表口径（产物 / 变更） */
  artifactPanelView: ArtifactPanelView;
  openArtifactPanel: (sessionId: string, opts?: ArtifactPanelOpenOptions) => void;
  /** 再次点击同一会话的按钮则收起；换会话则换入对方的现场并展开 */
  toggleArtifactPanel: (sessionId: string) => void;
  /**
   * 会话切换时让面板跟随（由布局层订阅 `sessionsStore.activeId` 调用）。
   *
   * 与 `toggleArtifactPanel(sessionId)` 分开：那个是「用户点了这条会话的边栏按钮」，
   * 语义是**展开**；这里只是跟随激活会话——它记的是开着就开着、记的是收起就收起。
   */
  switchPanelSession: (sessionId: string | null) => void;
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
  /**
   * 打开「工作空间」文件树标签（会话级单例）。
   *
   * 当前标签是「新标签页」时就地替换——这正是参考稿里点「查看工作空间」后
   * 标签标题变成「文件」的行为；否则追加或激活已有那个。
   */
  openFilesTab: () => void;
  /** 打开「变更」标签（同上，单例 + 就地替换） */
  openChangesTab: () => void;
  /** 打开一个面板内终端标签（每次都是新会话，返回新标签 id） */
  openTerminalTab: () => string;
  /**
   * 「+ 新建标签页」：**总是**追加一个空白新标签页并激活。
   *
   * 与 `showArtifactList` 的区别是「复用还是新建」：后者是「回到列表」，
   * 已经有列表标签时只激活它；这里点的是一次明确的「再开一个」。
   */
  openNewTab: () => void;
  /** 从文件树点开一个文件：同路径复用同一标签（反复点同一个文件不该堆一串标签） */
  openFileTab: (path: string, name?: string) => void;
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
  panelBySession: {},
  artifactPanelTabs: [],
  artifactPanelActiveTabId: null,
  artifactPanelFullscreen: false,
  artifactPanelView: 'all',

  openArtifactPanel: (sessionId, opts) => {
    const state = get();
    // 判据是**会话**而不是「面板是否开着」：同一会话收起面板再打开，标签应当还在
    // （否则「看列表 → 收起 → 再打开」会丢掉刚开的一堆产物）；
    // 换了会话才换现场——上一会话的产物 id 在新会话里指不到任何东西
    const migrated = state.artifactPanelSessionId === sessionId ? null : migratePanel(state, sessionId);
    const kept = migrated ? migrated.artifactPanelTabs : state.artifactPanelTabs;
    const id = opts?.previewId;
    // 决定「开哪一类标签」只看调用方意图；写进 store 的列表口径则可以继承换入的会话
    // （切回一条停在「变更」口径的会话，不该被顺手复位成「全部」）
    const view = opts?.view ?? 'all';
    const listView = opts?.view ?? migrated?.artifactPanelView ?? 'all';

    let tabs: ArtifactPanelTab[] = kept;
    let activeId: string | null;
    if (id !== undefined) {
      // 点卡片（带 previewId）是**追加**语义：连点两张卡片应该得到两个标签，
      // 而不是把上一个顶掉——这正是「同时预览多个产物」的入口
      tabs = kept.some((t) => t.id === id) ? kept : [...kept, { id, kind: 'artifact' }];
      activeId = id;
    } else if (view === 'changes') {
      // 消息底部「查看所有变更」：落到变更标签，而不是列表页上的一个筛选口径
      const opened = openPage(tabs, null, () => ({ id: `changes-${genId()}`, kind: 'changes' }), 'changes');
      tabs = opened.tabs;
      activeId = opened.activeId;
    } else {
      const opened = openPage(tabs, null, makeListTab, 'list');
      tabs = opened.tabs;
      activeId = opened.activeId;
    }

    set({
      // 换了会话就顺带换入它的快照表与现场（含退出全屏），下面几项再覆盖
      ...(migrated ?? {}),
      artifactPanelOpen: true,
      artifactPanelSessionId: sessionId,
      artifactPanelTabs: tabs,
      artifactPanelActiveTabId: activeId,
      artifactPanelView: listView,
    });
  },

  toggleArtifactPanel: (sessionId) => {
    const state = get();
    // 同一会话再点一次 = 收起；现场留在内存里，下次展开仍是那套标签
    if (state.artifactPanelOpen && state.artifactPanelSessionId === sessionId) {
      // 收起时一并退出全屏：否则下次打开会毫无征兆地铺满整个窗口
      set({ artifactPanelOpen: false, artifactPanelFullscreen: false });
      return;
    }
    if (state.artifactPanelSessionId === sessionId) {
      set({ artifactPanelOpen: true, artifactPanelSessionId: sessionId });
      return;
    }
    // 换会话：换入目标会话的现场后**强制展开**（用户点的是「打开边栏」）。
    // 目标会话从没开过面板 → 给一个「新标签页」当落地页：空标签数组会让面板
    // 内容区一片空白，用户第一眼看到的是「坏了」而不是「可以点这里」
    const migrated = migratePanel(state, sessionId);
    const landing = migrated.artifactPanelTabs.length > 0 ? null : makeListTab();
    set({
      ...migrated,
      artifactPanelOpen: true,
      ...(landing ? { artifactPanelTabs: [landing], artifactPanelActiveTabId: landing.id } : {}),
    });
  },

  switchPanelSession: (sessionId) => {
    // 面板已经在跟这条会话 → 开合由用户（或快捷入口）决定，这里不动
    if (get().artifactPanelSessionId === sessionId) return;
    set(migratePanel(get(), sessionId));
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
    const url = opts?.url?.trim() ?? '';
    const doc = opts?.doc ?? '';
    // 与「查看工作空间」同一条规则：当前是新标签页就地替换（浏览器语义）。
    // 「+」按钮追加新标签走的是 `ArtifactPanel` 里的 `openBlankTab`。
    const opened = openPage(
      get().artifactPanelTabs,
      get().artifactPanelActiveTabId,
      () => ({
        id: `web-${genId()}`,
        kind: 'web',
        url,
        history: url === '' ? [] : [url],
        cursor: url === '' ? -1 : 0,
        ...(doc !== '' ? { doc } : {}),
        ...(opts?.label ? { label: opts.label } : {}),
      }),
    );
    set({ artifactPanelTabs: opened.tabs, artifactPanelActiveTabId: opened.activeId });
    // 就地替换时真实 id 是原来的那个标签：返回它，调用方拿到的才是**可用**的 id
    return opened.activeId;
  },

  openFilesTab: () =>
    set((s) => {
      const opened = openPage(
        s.artifactPanelTabs,
        s.artifactPanelActiveTabId,
        () => ({ id: `files-${genId()}`, kind: 'files' }),
        'files',
      );
      return { artifactPanelTabs: opened.tabs, artifactPanelActiveTabId: opened.activeId };
    }),

  openChangesTab: () =>
    set((s) => {
      const opened = openPage(
        s.artifactPanelTabs,
        s.artifactPanelActiveTabId,
        () => ({ id: `changes-${genId()}`, kind: 'changes' }),
        'changes',
      );
      return { artifactPanelTabs: opened.tabs, artifactPanelActiveTabId: opened.activeId };
    }),

  openTerminalTab: () => {
    const tab: ArtifactPanelTab = {
      // 标签标题取 PTY 的 TERM 名（与参考稿一致，也是「这里是个真终端」最直接的说明）
      id: `term-${genId()}`,
      kind: 'terminal',
      title: 'xterm-256color',
    };
    set((s) => ({ artifactPanelTabs: [...s.artifactPanelTabs, tab], artifactPanelActiveTabId: tab.id }));
    return tab.id;
  },

  openFileTab: (path, name) =>
    set((s) => {
      const existing = s.artifactPanelTabs.find((t) => t.kind === 'file' && t.path === path);
      if (existing) return { artifactPanelActiveTabId: existing.id };
      const opened = openPage(s.artifactPanelTabs, s.artifactPanelActiveTabId, () => ({
        id: `file-${genId()}`,
        kind: 'file',
        path,
        // 展示名取路径最后一段：文件树里点的就是它，标签上再写全路径只会被截断
        name: name ?? path.split(/[\\/]/).pop() ?? path,
      }));
      return { artifactPanelTabs: opened.tabs, artifactPanelActiveTabId: opened.activeId };
    }),

  openNewTab: () => {
    const tab = makeListTab();
    set((s) => ({ artifactPanelTabs: [...s.artifactPanelTabs, tab], artifactPanelActiveTabId: tab.id }));
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
    // 关光了 → 补一个新的「新标签页」：面板不能没有页面（浏览器关掉最后一个标签
    // 是关窗，我们这里只有这一块界面，留空白等于把用户扔在一片黑里）
    if (tabs.length === 0) {
      const tab = makeListTab();
      set({ artifactPanelTabs: [tab], artifactPanelActiveTabId: tab.id });
      return;
    }
    // 关的不是当前标签 → 当前标签不受影响；关的是当前标签 → 让位给右邻居（按下标对齐
    // 过滤后的数组），没有右邻居就取左邻居
    const neighbor = tabs[index] ?? tabs[index - 1] ?? null;
    const nextActive =
      artifactPanelActiveTabId === artifactId ? (neighbor?.id ?? null) : artifactPanelActiveTabId;
    set({ artifactPanelTabs: tabs, artifactPanelActiveTabId: nextActive });
  },

  closeAllArtifactTabs: () => {
    const tab = makeListTab();
    set({ artifactPanelTabs: [tab], artifactPanelActiveTabId: tab.id });
  },

  showArtifactList: () =>
    set((s) => {
      const opened = openPage(s.artifactPanelTabs, s.artifactPanelActiveTabId, makeListTab, 'list');
      return { artifactPanelTabs: opened.tabs, artifactPanelActiveTabId: opened.activeId };
    }),

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
