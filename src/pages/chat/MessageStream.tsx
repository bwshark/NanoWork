import { useEffect, useRef } from 'react';
import { Box, Typography } from '@mui/material';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import {
  clearSearchHighlights,
  collectSearchRanges,
  paintSearchRanges,
  scrollRangeIntoView,
} from '@/lib/textHighlight';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';

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
    <Box ref={scrollRef} sx={{ flex: 1, overflow: 'auto', p: 2 }}>
      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        {session.messages.map((m) => (
          <Box
            key={m.id}
            id={anchorId(m.id)}
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
    </Box>
  );
}
