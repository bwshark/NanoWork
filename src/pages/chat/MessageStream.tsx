import { useEffect, useRef } from 'react';
import { Box, Typography } from '@mui/material';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import {
  clearSearchHighlights,
  collectSearchRanges,
  paintSearchRanges,
  scrollRangeIntoView,
} from '@/lib/session/textHighlight';
import {
  clearQuoteHighlights,
  findTextRange,
  paintQuoteHighlights,
} from '@/lib/editor/selectionQuote';
import { chatColumnSx } from './chatColumnSx';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { SelectionQuoteBubble } from './SelectionQuoteBubble';
import { MessageTextContextMenu } from './MessageTextContextMenu';

/** 定位高亮的保留时长（毫秒）：短暂点亮后自动消退，不长期占据视觉焦点 */
const HIGHLIGHT_MS = 3600;

/** 消息锚点 id 前缀（搜索 / 历史提问跳转时按此查找 DOM 节点） */
const anchorId = (messageId: string) => `msg-${messageId}`;

/**
 * 消息流：渲染当前会话的所有消息、自动滚动到底部，
 * 并处理两类跳转：
 * - `sessionUiStore.focusMessage` 消费（历史提问跳转，整条消息高亮）；
 * - 对话内搜索：遍历已渲染 DOM 收集关键词命中，交 CSS Custom Highlight API
 *   着色（不改动 DOM，避免与 React 冲突），并把命中总数回填给搜索条。
 */
export function MessageStream() {
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const session = sessions.find((s) => s.id === activeId);

  const focusMessageId = useSessionUiStore((s) => s.focusMessageId);
  const highlightMessageId = useSessionUiStore((s) => s.highlightMessageId);
  const clearFocusRequest = useSessionUiStore((s) => s.clearFocusRequest);
  const clearHighlight = useSessionUiStore((s) => s.clearHighlight);

  const searchSessionId = useSessionUiStore((s) => s.searchSessionId);
  const searchQuery = useSessionUiStore((s) => s.searchQuery);
  const searchActiveMatch = useSessionUiStore((s) => s.searchActiveMatch);
  const setSearchMatchCount = useSessionUiStore((s) => s.setSearchMatchCount);

  /** 滚动容器（同时是搜索遍历的根节点） */
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** 上一次触发自动滚底时的「会话 + 消息」签名，用于区分「消息真的变了」与「定位请求被消费」 */
  const lastSigRef = useRef<string>('');
  /** 当前关键词的命中 Range（按文档顺序），定位与计数共用同一份 */
  const rangesRef = useRef<Range[]>([]);
  /** 上一次已滚动过的「关键词 + 序号」，避免同一命中被反复滚动 */
  const lastScrolledRef = useRef<string>('');

  /** 搜索是否对当前会话生效（关键词非空且目标会话就是当前会话） */
  const searchActive =
    searchSessionId !== null &&
    searchSessionId === activeId &&
    searchQuery.trim() !== '';

  // 自动滚到底部。判定条件用消息签名而非单纯的依赖数组：
  // 定位请求被消费（focusMessageId 归 null）也会触发本 effect，此时签名未变、
  // 直接返回，否则会把刚定位好的视图又拉回底部。
  // 搜索期间不抢滚动权，否则会把刚跳到的命中项顶走。
  useEffect(() => {
    const sig = `${session?.id ?? ''}:${session?.messages.length ?? 0}:${session?.updatedAt ?? ''}`;
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    if (focusMessageId || searchActive) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [
    session?.messages,
    session?.updatedAt,
    session?.id,
    focusMessageId,
    searchActive,
  ]);

  // 消费定位请求：滚动到目标消息并清除请求（高亮另行消退）。
  // 依赖里带上会话 id 与消息数，保证「先切会话、再定位」时能等到目标渲染出来
  useEffect(() => {
    if (!focusMessageId) return;
    const el = document.getElementById(anchorId(focusMessageId));
    if (!el) {
      // 目标不属于当前会话（跨会话的残留请求）→ 放弃，让自动滚底恢复
      clearFocusRequest();
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    clearFocusRequest();
  }, [
    focusMessageId,
    session?.id,
    session?.messages.length,
    clearFocusRequest,
  ]);

  // 高亮自动消退
  useEffect(() => {
    if (!highlightMessageId) return;
    const timer = setTimeout(clearHighlight, HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightMessageId, clearHighlight]);

  // 搜索命中收集：在**渲染后的 DOM** 上遍历文本节点（消息正文是 Markdown 渲染结果，
  // 无法在源码字符串层替换），拿到命中 Range 后着色并把总数回填给搜索条。
  // 依赖消息数组：流式追加会让命中位置变化，必须重算。
  useEffect(() => {
    const root = scrollRef.current;
    if (!searchActive || !root) {
      clearSearchHighlights();
      rangesRef.current = [];
      lastScrolledRef.current = '';
      setSearchMatchCount(0);
      return;
    }
    const ranges = collectSearchRanges(root, searchQuery);
    rangesRef.current = ranges;
    const idx = Math.min(
      useSessionUiStore.getState().searchActiveMatch,
      Math.max(ranges.length - 1, 0),
    );
    paintSearchRanges(ranges, idx);
    setSearchMatchCount(ranges.length);
  }, [
    searchActive,
    searchQuery,
    session?.id,
    session?.messages,
    setSearchMatchCount,
  ]);

  // 切换命中项：重涂「当前项」高亮并滚动定位（同一项不重复滚动）
  useEffect(() => {
    if (!searchActive) return;
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const idx = Math.min(searchActiveMatch, ranges.length - 1);
    paintSearchRanges(ranges, idx);
    const key = `${searchQuery}|${idx}|${ranges.length}`;
    if (lastScrolledRef.current === key) return;
    lastScrolledRef.current = key;
    scrollRangeIntoView(ranges[idx], scrollRef.current);
  }, [searchActive, searchQuery, searchActiveMatch, session?.messages]);

  // —— 「添加到对话」的引用下划线 ——
  const quotes = useSessionUiStore((s) => s.quotes);
  const activeSessionId = session?.id;

  // 按引用在**消息 DOM** 上重新找回原文并登记高亮。
  // 刻意不存 DOM 偏移：那是渲染细节，消息一变（流式追加 / 产物挂载 / 档位切换）
  // 就失效，下划线会静默飘到别的字上。改用归一化文本查找，重渲染后依然找得到
  //（`findTextRange` 的原理见 lib/editor/selectionQuote.ts 文件头）。
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !activeSessionId) {
      clearQuoteHighlights();
      return;
    }
    const ranges: Range[] = [];
    for (const q of quotes) {
      // 别的会话的引用在当前 DOM 里指不到任何东西（切换时由下面那个 effect 清理）
      if (q.sessionId !== activeSessionId) continue;
      const host = document.getElementById(anchorId(q.messageId));
      if (!host) continue;
      // 查找限定在正文容器内，与选区判定同一口径（data-quote-body）：
      // 否则工具卡片 / 过程时间线里的同名字样也会被画上下划线
      const body = host.querySelector('[data-quote-body]');
      if (!body) continue;
      const range = findTextRange(body as HTMLElement, q.text);
      if (range) ranges.push(range);
    }
    paintQuoteHighlights(ranges);
  }, [quotes, activeSessionId, session?.messages]);

  // 卸载时撤掉下划线，别把它留给下一个会话的消息
  useEffect(() => clearQuoteHighlights, []);

  // 切换会话即清理上一会话的引用：引用的消息 id 在新会话里指不到东西，
  // 留着只会攒出「胶囊删不掉、下划线又不见」的幽灵状态
  useEffect(() => {
    useSessionUiStore.getState().pruneQuotes(activeSessionId ?? null);
  }, [activeSessionId]);

  if (!session) {
    return (
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.secondary',
        }}
      >
        选择一个会话，或新建会话开始对话
      </Box>
    );
  }

  return (
    // 横向留白交给内容列（chatColumnSx），滚动容器只留纵向：
    // 外层留白不参与居中计算，窄窗口下内容才不会比输入框多缩进一层。
    // `scrollbarGutter: stable both-edges` 把滚动条槽位在两侧各留一份：
    // 只留右边时，内容区是 [0, W-8]，居中后的列会左移 4px，而输入框在滚动容器
    // 之外、中心仍在 W/2 —— 两者错开，且滚动条一出现/消失就跳一下。
    <Box
      ref={scrollRef}
      sx={{ flex: 1, overflow: 'auto', py: 2, scrollbarGutter: 'stable both-edges' }}
    >
      <Box sx={chatColumnSx}>
        {session.messages.map((m) => (
          <Box
            key={m.id}
            id={anchorId(m.id)}
            // 选中文本 → 加入对话 时用它认出「这段文字属于哪条消息」
            data-message-id={m.id}
            sx={{
              borderRadius: 2,
              transition: 'background-color 400ms ease',
              bgcolor:
                highlightMessageId === m.id
                  ? 'action.selected'
                  : 'transparent',
            }}
          >
            {m.role === 'user' ? (
              <UserMessage message={m} sessionId={session!.id} />
            ) : (
              <AssistantMessage
                message={m}
                agentId={session?.agentId ?? ''}
                sessionId={session.id}
              />
            )}
          </Box>
        ))}
        <div ref={bottomRef} />
      </Box>
      {/* 选中文本气泡：Portal 到 body，挂在滚动容器之外（fixed 定位才不会被裁掉） */}
      <SelectionQuoteBubble rootRef={scrollRef} sessionId={session.id} />
      {/* 正文右键菜单（剪切 / 复制 / 粘贴 / 全选）：应用菜单置空后原生菜单不弹 */}
      <MessageTextContextMenu rootRef={scrollRef} sessionId={session.id} />
    </Box>
  );
}
