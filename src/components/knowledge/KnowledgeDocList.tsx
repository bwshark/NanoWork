import { useState } from "react";
import {
  Box,
  Button,
  Chip,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import RestoreFromTrashIcon from "@mui/icons-material/RestoreFromTrash";
import SearchIcon from "@mui/icons-material/Search";
import ViewListIcon from "@mui/icons-material/ViewList";
import ViewModuleIcon from "@mui/icons-material/ViewModule";
import type { KbDocument, KbSearchHit } from "@/lib/kb/kbClient";
import { kindLabel } from "@/lib/kb/kbUpload";
import { docUpdatedAt, formatRelativeTime } from "@/lib/kb/kbDocumentMeta";
import { KbDocIcon, KbEmpty } from "@/components/knowledge/kbAtoms";

export type KbDocView = "list" | "grid";

export interface KnowledgeDocListProps {
  docs: readonly KbDocument[];
  loading: boolean;
  error: string;
  trashOpen: boolean;
  onToggleTrash: () => void;
  view: KbDocView;
  onViewChange: (view: KbDocView) => void;
  /** 缺索引提示（空串 = 不提示）。判定在 `kbDocumentMeta.docIndexHint`，这里只负责画 */
  indexHint: (doc: KbDocument) => string;
  retrieval: {
    caption: string;
    warning: boolean;
    canReindex: boolean;
    reindexing: boolean;
    onReindex: () => void;
  };
  search: {
    query: string;
    onQueryChange: (value: string) => void;
    onSubmit: () => void;
    searching: boolean;
    error: string;
    hits: readonly KbSearchHit[] | null;
    /** 引擎是纯词法（不命中同义词要明说，否则用户以为库坏了） */
    lexicalOnly: boolean;
  };
  actions: {
    /** 点行 = 打开阅读抽屉（正文另取，见 `getDocument`） */
    onOpen: (doc: KbDocument) => void;
    onRename: (doc: KbDocument) => void;
    onDelete: (doc: KbDocument) => void;
    onRestore: (doc: KbDocument) => void;
    onPurge: (doc: KbDocument) => void;
  };
  /** 空态文案由页面决定：三种「没有」是三件不同的事 */
  emptyHint: string;
}

/** 副标题：`PDF · 1234 字 · 5 块`（格式显示出来，出问题时排查路径完全不同）。 */
function docSecondary(doc: KbDocument): string {
  return `${kindLabel(doc.kind)} · ${doc.chars} 字 · ${doc.chunkCount} 块`;
}

/**
 * 「所有知识」：检索 + 列表/网格 + 行操作。
 *
 * ## 三条不能省的东西
 *
 * 1. **回收站是一个视图，不是一个过滤器**：服务端两个口径，前端就必须真的去要
 *    第二个（本地筛等于把「删掉了」和「还在」混成一件）。
 * 2. **缺索引要在行上标出来**：没索引 = 搜不到，而它和其它文档长得一样。
 * 3. **行操作只在一处**（改名 / 删除 / 恢复 / 彻底删除），回收站里不给「改名」——
 *    它不是正常资料了，改它的名字没有意义。
 */
export function KnowledgeDocList({
  docs,
  loading,
  error,
  trashOpen,
  onToggleTrash,
  view,
  onViewChange,
  indexHint,
  retrieval,
  search,
  actions,
  emptyHint,
}: KnowledgeDocListProps) {
  const [hovered, setHovered] = useState<string>("");

  const timeCell = (doc: KbDocument) => formatRelativeTime(docUpdatedAt(doc));

  /** 行尾操作：回收站与正常列表是两套，别混在一个 `if` 里 */
  const rowActions = (doc: KbDocument) =>
    trashOpen ? (
      <>
        <Tooltip title="恢复">
          <IconButton
            size="small"
            aria-label={`恢复 ${doc.title}`}
            data-testid={`kb-doc-restore-${doc.id}`}
            onClick={() => actions.onRestore(doc)}
          >
            <RestoreFromTrashIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="彻底删除（不可恢复）">
          <IconButton
            size="small"
            aria-label={`彻底删除 ${doc.title}`}
            data-testid={`kb-doc-purge-${doc.id}`}
            onClick={() => actions.onPurge(doc)}
          >
            <DeleteForeverIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </>
    ) : (
      <>
        <Tooltip title="重命名">
          <IconButton
            size="small"
            aria-label={`重命名 ${doc.title}`}
            data-testid={`kb-doc-rename-${doc.id}`}
            onClick={() => actions.onRename(doc)}
          >
            <EditOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="删除（进回收站）">
          <IconButton
            size="small"
            aria-label={`删除 ${doc.title}`}
            data-testid={`kb-doc-delete-${doc.id}`}
            onClick={() => actions.onDelete(doc)}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </>
    );

  const indexChip = (doc: KbDocument) => {
    const hint = indexHint(doc);
    if (hint === "") return null;
    return (
      <Chip
        size="small"
        color="warning"
        variant="outlined"
        label={hint}
        data-testid={`kb-doc-index-${doc.id}`}
        sx={{ height: 17, fontSize: 10.5 }}
      />
    );
  };

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* 工具条 */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ px: 2.5, py: 1, borderBottom: "1px solid", borderColor: "divider" }}
      >
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
          {trashOpen ? "回收站" : "所有知识"}
        </Typography>
        <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{docs.length} 篇</Typography>

        <Box sx={{ flex: 1 }} />

        <TextField
          size="small"
          // 说明的是「范围」而不是「搜索」：接口带 kbId，只在本库内找
          placeholder="在本库内检索"
          value={search.query}
          onChange={(event) => search.onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") search.onSubmit();
          }}
          inputProps={{ "data-testid": "kb-query" }}
          sx={{ width: 190 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 16 }} />
              </InputAdornment>
            ),
          }}
        />
        <Button
          size="small"
          variant="outlined"
          disabled={search.searching || search.query.trim() === ""}
          onClick={() => search.onSubmit()}
          sx={{ minWidth: 56 }}
        >
          检索
        </Button>

        <Button
          size="small"
          variant={trashOpen ? "contained" : "text"}
          startIcon={<RestoreFromTrashIcon />}
          data-testid="kb-trash-toggle"
          onClick={onToggleTrash}
        >
          {trashOpen ? "返回文档" : "回收站"}
        </Button>

        <ToggleButtonGroup
          size="small"
          exclusive
          value={view}
          onChange={(_event, next: KbDocView | null) => {
            // 再点一次同一个图标会得到 null：保持当前视图，而不是把界面变成"没有视图"
            if (next !== null) onViewChange(next);
          }}
        >
          <ToggleButton value="list" aria-label="列表视图" sx={{ px: 0.75, py: 0.25 }}>
            <ViewListIcon sx={{ fontSize: 17 }} />
          </ToggleButton>
          <ToggleButton value="grid" aria-label="网格视图" sx={{ px: 0.75, py: 0.25 }}>
            <ViewModuleIcon sx={{ fontSize: 17 }} />
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {/* 检索说明（能力 + 覆盖率）与重建入口 */}
      {!trashOpen && (
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ px: 2.5, pt: 1, pb: 0.5 }}
        >
          <Typography
            variant="caption"
            data-testid="kb-caption"
            color={retrieval.warning ? "warning.main" : "text.secondary"}
            sx={{ minWidth: 0 }}
          >
            {retrieval.caption}
          </Typography>
          {/* 只在「引擎开着但还有块没索引」时出现：其余时候点了也没意义 */}
          {retrieval.canReindex && (
            <Button
              size="small"
              data-testid="kb-reindex"
              disabled={retrieval.reindexing}
              onClick={retrieval.onReindex}
              sx={{ minWidth: 0, flexShrink: 0 }}
            >
              {retrieval.reindexing ? "重建中…" : "重建索引"}
            </Button>
          )}
        </Stack>
      )}

      {trashOpen && (
        <Typography sx={{ px: 2.5, pt: 1, pb: 0.5, fontSize: 11.5, color: "text.secondary" }}>
          回收站里的资料不参与检索；保留 30 天，过期自动清理
        </Typography>
      )}

      {search.error !== "" && (
        <Typography sx={{ px: 2.5, py: 0.75, fontSize: 12.5, color: "error.main" }}>
          {search.error}
        </Typography>
      )}

      {search.hits !== null && search.error === "" && (
        <Box sx={{ px: 2.5, py: 1 }} data-testid="kb-hits">
          {search.hits.length === 0 ? (
            <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
              没有命中。换个关键词试试
              {search.lexicalOnly ? "（当前是词法匹配，同义词不会命中）" : "。"}
            </Typography>
          ) : (
            <Stack spacing={0.75}>
              {search.hits.map((hit) => (
                <Paper key={hit.chunkId} variant="outlined" sx={{ p: 1.25, borderRadius: 1.5 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{hit.docTitle}</Typography>
                    <Chip size="small" variant="outlined" label={hit.score.toFixed(3)} />
                  </Stack>
                  <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.5 }}>
                    {hit.snippet}
                  </Typography>
                </Paper>
              ))}
            </Stack>
          )}
        </Box>
      )}

      {error !== "" && (
        <Typography sx={{ px: 2.5, py: 1, fontSize: 12.5, color: "error.main" }}>{error}</Typography>
      )}

      {/* 文件区 */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2.5, pb: 2 }}>
        {view === "list" ? (
          <>
            <Stack
              direction="row"
              alignItems="center"
              sx={{
                px: 1,
                py: 0.75,
                borderBottom: "1px solid",
                borderColor: "divider",
                fontSize: 11,
                color: "text.secondary",
                whiteSpace: "nowrap",
              }}
            >
              <Box sx={{ flex: 1 }}>文件名称</Box>
              {/* 宽度与行里的时间格对齐（88 + 操作区 68），否则表头与数据会错开 */}
              <Box sx={{ width: 88, textAlign: "right" }}>更新时间</Box>
              <Box sx={{ width: 68 }} />
            </Stack>
            {docs.map((doc) => (
              <Stack
                key={doc.id}
                direction="row"
                alignItems="center"
                spacing={1}
                data-testid={`kb-doc-row-${doc.id}`}
                onClick={() => actions.onOpen(doc)}
                onMouseEnter={() => setHovered(doc.id)}
                onMouseLeave={() => setHovered("")}
                sx={{
                  px: 1,
                  py: 0.75,
                  borderRadius: 1.5,
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  cursor: "pointer",
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                <KbDocIcon kind={doc.kind} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" alignItems="center" spacing={0.75}>
                    <Typography
                      sx={{
                        fontSize: 12.5,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {doc.title}
                    </Typography>
                    {indexChip(doc)}
                  </Stack>
                  <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>
                    {docSecondary(doc)}
                  </Typography>
                </Box>
                <Typography
                  sx={{ fontSize: 11.5, color: "text.secondary", width: 88, textAlign: "right" }}
                >
                  {timeCell(doc)}
                </Typography>
                <Stack
                  direction="row"
                  spacing={0.25}
                  // 行内按钮自己处理点击：不拦的话「点改名」会同时打开阅读抽屉
                  onClick={(event) => event.stopPropagation()}
                  sx={{
                    width: 68,
                    justifyContent: "flex-end",
                    // 平时淡出但**不隐藏**：`display:none` 会让键盘/自动化都点不到，
                    // 而且行高会在 hover 时跳一下
                    opacity: hovered === doc.id ? 1 : 0.35,
                    transition: "opacity .12s",
                  }}
                >
                  {rowActions(doc)}
                </Stack>
              </Stack>
            ))}
          </>
        ) : (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 1.25,
              pt: 1,
            }}
          >
            {docs.map((doc) => (
              <Paper
                key={doc.id}
                variant="outlined"
                onClick={() => actions.onOpen(doc)}
                onMouseEnter={() => setHovered(doc.id)}
                onMouseLeave={() => setHovered("")}
                sx={{
                  p: 1.5,
                  borderRadius: 2,
                  cursor: "pointer",
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                <Stack direction="row" alignItems="flex-start" spacing={1}>
                  <KbDocIcon kind={doc.kind} size={20} />
                  <Typography
                    sx={{
                      fontSize: 12.5,
                      flex: 1,
                      minWidth: 0,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {doc.title}
                  </Typography>
                </Stack>
                <Typography sx={{ mt: 0.75, fontSize: 10.5, color: "text.secondary" }}>
                  {docSecondary(doc)}
                </Typography>
                <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.75 }}>
                  <Typography sx={{ fontSize: 10.5, color: "text.secondary", flex: 1 }}>
                    {timeCell(doc)}
                  </Typography>
                  {indexChip(doc)}
                  <Stack
                    direction="row"
                    spacing={0.25}
                    onClick={(event) => event.stopPropagation()}
                    sx={{ opacity: hovered === doc.id ? 1 : 0.35, transition: "opacity .12s" }}
                  >
                    {rowActions(doc)}
                  </Stack>
                </Stack>
              </Paper>
            ))}
          </Box>
        )}

        {!loading && docs.length === 0 && error === "" && <KbEmpty>{emptyHint}</KbEmpty>}
      </Box>
    </Box>
  );
}
