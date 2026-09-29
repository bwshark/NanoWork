import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Chip,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { ArtifactRenderer } from '@/components/ArtifactRenderer';
import { ROUTES } from '@/lib/constants';
import {
  buildIndexEntry,
  filterItems,
  groupByHash,
  sortGroups,
  type ArtifactItem,
} from '@/lib/artifactIndex';
import { resolveArtifactContent, useArtifactsStore } from '@/stores/artifactsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import type { ArtifactIndexEntry, ArtifactType } from '@/types';

const TYPE_LABELS: Record<ArtifactType, string> = {
  html: 'HTML',
  svg: 'SVG',
  image: '图片',
  mermaid: '流程图',
  code: '代码',
  markdown: '文档',
  video: '视频',
};

const ALL_TYPES = Object.keys(TYPE_LABELS) as ArtifactType[];

type Order = 'newest' | 'oldest';
/** 两种组织方式互斥：按时间才能跨会话折叠，按会话则每节内不可能有重复（入库已去重） */
type ViewMode = 'time' | 'session';

/**
 * 产物库（FR-7.2：跨会话检索与去重）。
 *
 * 数据来自 **store 索引切片**（权威，两端一致）；`bySession` 只提供渲染需要的
 * 内容本体。索引缺失的旧产物（本版之前入库的）在此**即时补算**，不写回——
 * 写回是无谓的写放大，而补算只在渲染时发生一次。
 */
export function ArtifactsPage() {
  const bySession = useArtifactsStore((s) => s.bySession);
  const index = useArtifactsStore((s) => s.index);
  const bodies = useArtifactsStore((s) => s.bodies);
  const sessions = useSessionsStore((s) => s.sessions);
  const selectSession = useSessionsStore((s) => s.selectSession);
  const focusMessage = useSessionUiStore((s) => s.focusMessage);
  const navigate = useNavigate();

  const [keyword, setKeyword] = useState('');
  const [types, setTypes] = useState<ArtifactType[]>([]);
  const [order, setOrder] = useState<Order>('newest');
  const [view, setView] = useState<ViewMode>('time');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** FR-7.4：仅显示被编辑 / 回退过（有多于一版）的产物 */
  const [editedOnly, setEditedOnly] = useState(false);

  const items = useMemo<ArtifactItem[]>(() => {
    const out: ArtifactItem[] = [];
    for (const [sessionId, list] of Object.entries(bySession)) {
      for (const artifact of list) {
        const entry = index[artifact.id] ?? buildIndexEntry(sessionId, '', artifact);
        // 引用去 content 入库（彻底去重）：渲染前从 `bodies` 按 contentHash 回填正文；
        // `bodies` 缺失（图片 / 未迁移旧数据）回落内联 `artifact.content`。
        const content = resolveArtifactContent(entry.contentHash, bodies, artifact.content);
        out.push({ entry, artifact: { ...artifact, content } });
      }
    }
    return out;
  }, [bySession, index, bodies]);

  const filtered = useMemo(
    () => filterItems(items, { keyword, types, editedOnly }),
    [items, keyword, types, editedOnly],
  );
  const groups = useMemo(() => sortGroups(groupByHash(filtered), order), [filtered, order]);

  const sessionTitle = (id: string) => sessions.find((s) => s.id === id)?.title ?? '未知会话';

  const gotoSession = (entry: ArtifactIndexEntry) => {
    selectSession(entry.sessionId);
    navigate(ROUTES.chat);
    if (entry.messageId) focusMessage(entry.messageId);
  };

  const toggleExpanded = (hash: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  const renderEntryBar = (entry: ArtifactIndexEntry) => (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1, flexWrap: 'wrap', gap: 1 }}>
      <Chip size="small" label={TYPE_LABELS[entry.type] ?? entry.type} variant="outlined" />
      {entry.version && entry.version > 1 && (
        <Chip
          size="small"
          color="secondary"
          variant="outlined"
          label={`v${entry.version}`}
          title={`该产物有 ${entry.versions?.length ?? entry.version} 个版本，可在产物面板查看历史`}
        />
      )}
      <Chip
        size="small"
        label={sessionTitle(entry.sessionId)}
        onClick={() => gotoSession(entry)}
        sx={{ cursor: 'pointer' }}
      />
      <Typography variant="caption" color="text.secondary">
        {entry.createdAt.replace('T', ' ').slice(0, 16)}
      </Typography>
    </Stack>
  );

  const emptyHint =
    items.length === 0
      ? '暂无富产物。在会话中触发工具（搜索 / 抓取 / 画图 / 文件 / 命令）即可生成产物。'
      : '没有匹配的产物，试试换个关键词或清空类型筛选。';

  return (
    <Box sx={{ p: 3, maxWidth: 1000, margin: '0 auto' }}>
      <Typography variant="h5" fontWeight={700} gutterBottom>
        产物库
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        共 {items.length} 项产物，折叠后 {groups.length} 条
      </Typography>

      <Stack spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          size="small"
          fullWidth
          placeholder="搜索标题 / 内容 / 语言"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          InputProps={{
            startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1, color: 'text.disabled' }} />,
          }}
        />
        <Stack direction="row" spacing={2} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
          <ToggleButtonGroup
            size="small"
            value={types}
            onChange={(_e, next: ArtifactType[]) => setTypes(next)}
          >
            {ALL_TYPES.map((t) => (
              <ToggleButton key={t} value={t} sx={{ textTransform: 'none', fontSize: 12 }}>
                {TYPE_LABELS[t]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={order}
            onChange={(_e, next: Order | null) => next && setOrder(next)}
          >
            <ToggleButton value="newest" sx={{ textTransform: 'none', fontSize: 12 }}>
              最新优先
            </ToggleButton>
            <ToggleButton value="oldest" sx={{ textTransform: 'none', fontSize: 12 }}>
              最早优先
            </ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={view}
            onChange={(_e, next: ViewMode | null) => next && setView(next)}
          >
            <ToggleButton value="time" sx={{ textTransform: 'none', fontSize: 12 }}>
              按时间
            </ToggleButton>
            <ToggleButton value="session" sx={{ textTransform: 'none', fontSize: 12 }}>
              按会话
            </ToggleButton>
          </ToggleButtonGroup>
          <ToggleButton
            size="small"
            value="edited"
            selected={editedOnly}
            onClick={() => setEditedOnly((v) => !v)}
            sx={{ textTransform: 'none', fontSize: 12 }}
          >
            仅编辑过
          </ToggleButton>
        </Stack>
      </Stack>

      {filtered.length === 0 && (
        <Typography color="text.secondary">{emptyHint}</Typography>
      )}

      {view === 'time' &&
        groups.map((g) => {
          const isOpen = expanded.has(g.contentHash);
          // 折叠时只显示**最近一次**出现，但把出现过的会话都列出来供跳转
          const visible = isOpen ? g.items : [g.items[g.items.length - 1]];
          return (
            <Paper key={g.contentHash} variant="outlined" sx={{ p: 1.5, mb: 2 }}>
              {g.items.length > 1 && (
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                  <Chip
                    size="small"
                    color="primary"
                    variant="outlined"
                    label={`${g.items.length} 处出现`}
                    onClick={() => toggleExpanded(g.contentHash)}
                    sx={{ cursor: 'pointer' }}
                  />
                  {!isOpen && (
                    <Typography variant="caption" color="text.secondary">
                      还有 {g.items.length - 1} 个会话产出过相同内容
                    </Typography>
                  )}
                </Stack>
              )}
              {visible.map(({ entry, artifact }) => (
                <Box key={entry.id} sx={{ mb: 1 }}>
                  {renderEntryBar(entry)}
                  <ArtifactRenderer artifact={artifact} />
                </Box>
              ))}
            </Paper>
          );
        })}

      {view === 'session' &&
        Object.entries(
          filtered.reduce<Record<string, ArtifactItem[]>>((acc, item) => {
            const list = acc[item.entry.sessionId];
            if (list) list.push(item);
            else acc[item.entry.sessionId] = [item];
            return acc;
          }, {}),
        ).map(([sid, list]) => (
          <Box key={sid} sx={{ mb: 3 }}>
            <Typography sx={{ fontWeight: 600, mb: 1 }}>
              {sessionTitle(sid)} · {list.length} 项
            </Typography>
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              {[...list]
                .sort((a, b) =>
                  order === 'newest'
                    ? b.entry.createdAt.localeCompare(a.entry.createdAt)
                    : a.entry.createdAt.localeCompare(b.entry.createdAt),
                )
                .map(({ entry, artifact }) => (
                  <Box key={entry.id} sx={{ mb: 1 }}>
                    {renderEntryBar(entry)}
                    <ArtifactRenderer artifact={artifact} />
                  </Box>
                ))}
            </Paper>
          </Box>
        ))}
    </Box>
  );
}
