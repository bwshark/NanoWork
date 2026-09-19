/**
 * 居中任务搜索窗（⌘K / 标题栏搜索图标唤起）。
 *
 * 与侧边栏列表共用 `filterTasks`，因此「搜索窗看到的结果」与「筛选后侧边栏看到的结果」
 * 必然一致——两处各写一份筛选逻辑历史上就漂移过。
 *
 * 交互要点：
 * - 关键词只作用于本窗口（`taskQueryStore.query`），筛选条件（状态/时间）两边共享；
 * - 键盘上下键移动高亮、Enter 打开、Esc 关闭（由 Dialog 默认行为提供）；
 * - 高亮行用 `data-row-index` + `scrollIntoView({block:'nearest'})` 跟随，
 *   而不是 ref 数组——行会被结果集变化重排，索引比元素身份更稳。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Dialog, IconButton, InputBase, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import { filterTasks } from '@/lib/taskQuery';
import { DEFAULT_WORKSPACE_LABEL, resolveWorkspaceLabel } from '@/lib/workspaceLabel';
import { ROUTES } from '@/lib/constants';
import { useTaskQueryStore } from '@/stores/taskQueryStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Session } from '@/types';

/** 结果上限：空关键词时退化成「最近任务」，没有上限就会把全部会话塞进 DOM */
const SEARCH_LIMIT = 60;

export function TaskSearchDialog() {
  const navigate = useNavigate();
  const searchOpen = useTaskQueryStore((s) => s.searchOpen);
  const closeSearch = useTaskQueryStore((s) => s.closeSearch);
  const query = useTaskQueryStore((s) => s.query);
  const setQuery = useTaskQueryStore((s) => s.setQuery);
  const filters = useTaskQueryStore((s) => s.filters);

  const sessions = useSessionsStore((s) => s.sessions);
  const streams = useSessionsStore((s) => s.streams);
  const selectSession = useSessionsStore((s) => s.selectSession);
  const workspaceAliases = useSettingsStore((s) => s.settings.workspaceAliases);

  /** 当前高亮行下标（键盘导航用） */
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 关闭时不参与计算：省掉「关了窗还在过滤全量会话」的无谓开销
  const results = useMemo(
    () =>
      searchOpen
        ? filterTasks(sessions, { query, filters, streams }).slice(0, SEARCH_LIMIT)
        : [],
    [searchOpen, sessions, query, filters, streams],
  );

  const hasQuery = query.trim();

  // 打开时聚焦输入框并把高亮归零；延迟 30ms 等 Dialog 的进场过渡把焦点让出来
  useEffect(() => {
    if (!searchOpen) return;
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [searchOpen]);

  // 结果集缩短时把越界的高亮拉回 0，否则 Enter 会取到 undefined
  useEffect(() => {
    setActiveIndex((i) => (i >= results.length ? 0 : i));
  }, [results.length]);

  // 键盘移动高亮后让它保持在可视区（就近滚动，不打断用户当前视口）
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const row = el.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const openSession = (session: Session) => {
    selectSession(session.id);
    closeSearch();
    navigate(ROUTES.chat);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length === 0) return;
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = results[activeIndex];
      if (target) openSession(target);
    }
  };

  return (
    <Dialog
      open={searchOpen}
      onClose={closeSearch}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 2.5,
          bgcolor: 'background.paper',
          backgroundImage: 'none',
          boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
          overflow: 'hidden',
        },
      }}
    >
      <Box onKeyDown={handleKeyDown} sx={{ display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1.5 }}>
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: 1.5,
              height: 44,
              borderRadius: 1.5,
              bgcolor: 'action.hover',
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            <SearchIcon sx={{ fontSize: 19, color: 'text.secondary' }} />
            <InputBase
              inputRef={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索任务"
              fullWidth
              sx={{ fontSize: 14.5 }}
              inputProps={{ 'aria-label': '搜索任务' }}
            />
          </Box>
          <IconButton
            size="small"
            onClick={closeSearch}
            aria-label="关闭搜索"
            sx={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              bgcolor: 'action.hover',
              color: 'text.secondary',
              '&:hover': { bgcolor: 'action.selected', color: 'text.primary' },
            }}
          >
            <CloseIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Box>

        <Typography
          sx={{ px: 2.5, pb: 0.75, fontSize: 12, fontWeight: 600, color: 'text.secondary' }}
        >
          {hasQuery ? `搜索结果（${results.length}）` : '最近任务'}
        </Typography>

        <Box
          ref={listRef}
          sx={{ px: 1, pb: 1.5, maxHeight: 'min(56vh, 520px)', overflowY: 'auto' }}
        >
          {results.length === 0 ? (
            <Typography sx={{ px: 1.5, py: 3, fontSize: 13, color: 'text.secondary' }}>
              {hasQuery ? '没有匹配的任务' : '还没有任务'}
            </Typography>
          ) : (
            results.map((session, index) => (
              <SearchResultRow
                key={session.id}
                session={session}
                label={
                  session.workdir
                    ? resolveWorkspaceLabel(session.workdir, workspaceAliases)
                    : DEFAULT_WORKSPACE_LABEL
                }
                active={index === activeIndex}
                index={index}
                onHover={() => setActiveIndex(index)}
                onOpen={() => openSession(session)}
              />
            ))
          )}
        </Box>
      </Box>
    </Dialog>
  );
}

/** 单条搜索结果：标题 + 右侧工作空间名（与侧边栏分组标题同源） */
function SearchResultRow({
  session,
  label,
  active,
  index,
  onHover,
  onOpen,
}: {
  session: Session;
  label: string;
  active: boolean;
  index: number;
  onHover: () => void;
  onOpen: () => void;
}) {
  return (
    <Box
      data-row-index={index}
      onClick={onOpen}
      onMouseEnter={onHover}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 1.5,
        height: 46,
        borderRadius: 1,
        cursor: 'pointer',
        bgcolor: active ? 'action.selected' : 'transparent',
        '&:hover': { bgcolor: 'action.selected' },
      }}
    >
      <Typography
        noWrap
        sx={{ flex: 1, minWidth: 0, fontSize: 14, color: 'text.primary' }}
      >
        {session.title}
      </Typography>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          maxWidth: '40%',
          flexShrink: 0,
          color: 'text.secondary',
        }}
      >
        <FolderOutlinedIcon sx={{ fontSize: 16, flexShrink: 0 }} />
        <Typography noWrap sx={{ fontSize: 13, color: 'text.secondary' }}>
          {label}
        </Typography>
      </Box>
    </Box>
  );
}
