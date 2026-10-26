import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import ImageIcon from "@mui/icons-material/Image";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { toast } from "@/components/Toast";
import { MarkdownView } from "@/components/MarkdownView";
import {
  DocEditor,
  type DocEditorHandle,
  type UploadedImage,
} from "@/components/knowledge/DocEditor";
import { docTableSx } from "@/components/knowledge/docTableSx";
import type { KbDocument, KbDocumentDetail } from "@/lib/kb/kbClient";
import { docUpdatedAt, formatRelativeTime } from "@/lib/kb/kbDocumentMeta";
import { kindLabel } from "@/lib/kb/kbUpload";
import { KbDocIcon } from "@/components/knowledge/kbAtoms";

/**
 * 文档阅读抽屉（点列表里的一行打开）。
 *
 * ## 为什么不是「打开原文件」
 *
 * 服务端**没有原文件**：入库时正文被切成块，原文件就丢了。所以这里显示的正文是
 * 「块按序拼回来」的（`chunking.join_chunks`），原始排版（表格结构、图片、字号）
 * 不在其中。这句话必须写在界面上 —— 否则用户会拿它当原件核对，然后发现对不上。
 *
 * ## 三条状态都要说人话
 *
 * - **加载中**：只画骨架（标题已经从列表拿到了，先给标题，正文区转圈）。
 * - **403**：原样显示服务端那句「当前角色无权访问该知识库」—— 权限配错不能
 *   被显示成「内容为空」。
 * - **正文为空**：单独一句，而不是一片白（解析出 0 字的文档是真实存在的情况）。
 *
 * ## 「⋯」里只放真能做的
 *
 * 参考界面那一列（分享 / 点赞 / 收藏 / 评论 / 演示模式 / 数据与统计…）在这个系统里
 * 都没有后端支撑。摆上去只会变成一排点了没反应的按钮 —— 那比少几个入口更糟。
 */
export interface DocViewerDrawerProps {
  open: boolean;
  /** 列表行给的元数据：先画标题，正文随后到（避免「点开一片空白」） */
  doc: KbDocument | null;
  detail: KbDocumentDetail | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onClose: () => void;
  onRename: (doc: KbDocument) => void;
  onDelete: (doc: KbDocument) => void;
  /**
   * 能不能编辑正文（服务端写权限是 admin；部门负责人那条路径这里不细分，
   * 真有权限的人保存时不会被拦，没权限的人会在保存时被 403 如实告知）。
   */
  canEdit: boolean;
  saving: boolean;
  /** 保存；`true` = 服务端已接受（此时才清脏标记） */
  onSave: (content: string) => Promise<boolean>;
  /**
   * 上传一张图片（选文件 / 粘贴都走它）。
   *
   * 上层负责调云端；抽屉只管把结果插进编辑器的光标处。
   */
  onUploadImage?: (file: File) => Promise<UploadedImage | null>;
}

/** 正文里的「另存为 .md」：真的下载一个文件，不是在界面上假装导出了。 */
function downloadMarkdown(title: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title.replace(/[\\/:*?"<>|]/g, "_") || "文档"}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻释放：拖到下一轮事件循环再释放，Safari 会来不及取内容
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function DocViewerDrawer({
  open,
  doc,
  detail,
  loading,
  error,
  onRetry,
  onClose,
  onRename,
  onDelete,
  canEdit,
  saving,
  onSave,
  onUploadImage,
}: DocViewerDrawerProps) {
  const editorRef = useRef<DocEditorHandle | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [wide, setWide] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  /**
   * 草稿：`null` = 还没动过（显示服务端的正文）。
   *
   * 为什么要有这一层而不是直接改 `detail.content`：`detail` 是服务端快照，
   * 拿它当编辑缓冲，保存失败后就分不清「界面上是用户的改动」还是「服务端的内容」。
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const content = detail?.content ?? "";
  const shown = draft ?? content;
  const dirty = draft !== null && draft !== content;
  const meta = doc === null ? "" : `${kindLabel(doc.kind)} · ${doc.chars} 字 · ${doc.chunkCount} 块`;
  const updated = doc === null ? "" : formatRelativeTime(docUpdatedAt(doc));

  // 换了一篇就丢掉上一篇的草稿（否则会把 A 的改动带进 B）
  useEffect(() => {
    setDraft(null);
    setConfirmLeave(false);
  }, [doc?.id]);

  // ⌘/Ctrl+S 保存：写长文的人一定会按
  useEffect(() => {
    if (!open || !canEdit) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (dirty && !saving) void save();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const save = async () => {
    if (draft === null) return;
    const ok = await onSave(draft);
    if (ok) setDraft(null);
  };

  const requestClose = () => {
    if (dirty) {
      setConfirmLeave(true);
      return;
    }
    onClose();
  };

  const copyContent = async () => {
    setMenuAnchor(null);
    if (content === "") {
      toast.error("正文还是空的，没有可复制的内容");
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      toast.success("正文已复制");
    } catch {
      // 剪贴板权限被拒（或非安全上下文）：如实说，不要假装复制成功
      toast.error("复制失败：浏览器没有授予剪贴板权限");
    }
  };

  const exportMarkdown = () => {
    setMenuAnchor(null);
    if (doc === null) return;
    downloadMarkdown(doc.title, content);
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        // 与新建文档抽屉同一套判据：`[role="dialog"]` 既能被无障碍读到，也能被用例定位
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "kb-doc-view-title",
        sx: {
          width: wide ? "100%" : { xs: "100%", sm: 860 },
          maxWidth: "100%",
          bgcolor: "background.paper",
          backgroundImage: "none",
        },
      }}
    >
      <Stack direction="column" sx={{ height: "100%", minHeight: 0 }}>
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{
            pl: 2,
            pr: 1.25,
            height: 52,
            flexShrink: 0,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <KbDocIcon kind={doc?.kind} />
          <Typography
            id="kb-doc-view-title"
            data-testid="kb-doc-view-title"
            sx={{
              fontSize: 13.5,
              fontWeight: 600,
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {doc?.title ?? "文档"}
          </Typography>
          {canEdit && (
            <Typography
              data-testid="kb-doc-view-status"
              sx={{ fontSize: 11, color: dirty ? "warning.main" : "text.secondary", mr: 0.5 }}
            >
              {saving ? "保存中…" : dirty ? "未保存" : "已保存"}
            </Typography>
          )}
          {canEdit && onUploadImage && (
            <Tooltip title="插入图片（也可以直接粘贴截图）">
              <IconButton
                size="small"
                aria-label="插入图片"
                data-testid="kb-doc-insert-image"
                onClick={() => {
                  // 先记下选区：文件对话框会让编辑器失焦，那时选区可能已经指不准了
                  editorRef.current?.captureSelection();
                  imageInputRef.current?.click();
                }}
                sx={{ mr: 0.25 }}
              >
                <ImageIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          )}
          {canEdit && (
            <Button
              size="small"
              variant="contained"
              disabled={!dirty || saving}
              data-testid="kb-doc-view-save"
              onClick={() => void save()}
              sx={{ mr: 0.5 }}
            >
              {saving ? "保存中…" : "保存"}
            </Button>
          )}
          <IconButton
            size="small"
            aria-label="更多操作"
            data-testid="kb-doc-view-menu"
            onClick={(event) => setMenuAnchor(event.currentTarget)}
          >
            <MoreHorizIcon fontSize="small" />
          </IconButton>
          <Tooltip title={wide ? "还原宽度" : "全宽"}>
            <IconButton
              size="small"
              aria-label={wide ? "还原宽度" : "全宽"}
              onClick={() => setWide((previous) => !previous)}
            >
              {wide ? <CloseFullscreenIcon fontSize="small" /> : <OpenInFullIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title="关闭">
            <IconButton
              size="small"
              aria-label="关闭"
              data-testid="kb-doc-view-close"
              onClick={requestClose}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>

        {/* 元信息：格式 / 字数 / 块数 / 更新时间。「拼回来的」这句放这里，
            让人在开始读之前就知道它不等于原文件 */}
        <Box sx={{ px: { xs: 2.5, sm: 4.5 }, pt: 2, flexShrink: 0 }}>
          <Typography sx={{ fontSize: 11.5, color: "text.secondary" }} data-testid="kb-doc-view-meta">
            {meta}
            {updated !== "" ? ` · ${updated}更新` : ""} · 正文由入库时的分块拼回，原文件的排版与分页不在其中
          </Typography>
        </Box>

        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            px: { xs: 2.5, sm: 4.5 },
            pt: 2,
            pb: 4,
          }}
        >
          {loading && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 3 }}>
              <CircularProgress size={14} />
              <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>正在读取正文…</Typography>
            </Stack>
          )}

          {!loading && error !== "" && (
            <Box sx={{ py: 3 }}>
              <Typography sx={{ fontSize: 13, color: "error.main" }} data-testid="kb-doc-view-error">
                {error}
              </Typography>
              <Typography
                component="button"
                onClick={onRetry}
                sx={{
                  mt: 1,
                  p: 0,
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  fontSize: 12.5,
                  color: "info.main",
                }}
              >
                重试
              </Typography>
            </Box>
          )}

          {!loading && error === "" && content.trim() === "" && (
            <Typography sx={{ py: 3, fontSize: 12.5, color: "text.secondary" }}>
              这篇没有可显示的正文（入库时解析出 0 字，或内容已随块一起被清掉）。
            </Typography>
          )}

          {!loading && error === "" && content.trim() !== "" && (
            <Box sx={{ maxWidth: 760 }} data-testid="kb-doc-view-body">
              {canEdit ? (
                <DocEditor
                  ref={editorRef}
                  docKey={doc?.id ?? ""}
                  markdown={shown}
                  onChange={(next) => setDraft(next)}
                  readOnly={saving}
                  onUploadImage={onUploadImage}
                />
              ) : (
                <Box
                  sx={{
                    // 只读路径沿用 `MarkdownView`，但排版必须是文档级的（见下）
                    "& .md-body": { fontSize: 14.5, lineHeight: 1.95 },
                    "& .md-body h1": { fontSize: 30, fontWeight: 700, letterSpacing: -0.2, mt: 0, mb: 2 },
                    "& .md-body h2": { fontSize: 21, fontWeight: 700, mt: 3.5, mb: 1.25 },
                    "& .md-body h3": { fontSize: 17, fontWeight: 600, mt: 2.5, mb: 1 },
                    "& .md-body p": { my: 1.25 },
                    "& .md-body ul": { listStyle: "disc", pl: 3, my: 1 },
                    "& .md-body ol": { listStyle: "decimal", pl: 3, my: 1 },
                    "& .md-body li": { display: "list-item", my: 0.5 },
                    "& .md-body li::marker": { color: "text.secondary" },
                    ...docTableSx("& .md-body"),
                    // ⚠️ 圆角写**字符串**：`sx` 里的数字会按 spacing 换算（`4` 实测变成 40px）
                    "& .md-body img": {
                      maxWidth: "100%",
                      height: "auto",
                      borderRadius: "6px",
                      my: 0.5,
                    },
                    "& .md-body blockquote": {
                      borderLeft: "3px solid",
                      borderColor: "divider",
                      pl: 2,
                      my: 2,
                      color: "text.secondary",
                    },
                  }}
                >
                  {/* 知识库的图片是 blob 地址（<img> 不能带票）→ 放行；
                      图注显示在图片下方（编辑器里那行字的同一份内容） */}
                  <MarkdownView content={content} allowBlobUrls showImageCaptions />
                </Box>
              )}
            </Box>
          )}

          {(detail?.warnings ?? []).length > 0 && (
            <Box sx={{ maxWidth: 720, mt: 3 }}>
              <Typography sx={{ fontSize: 11.5, color: "warning.main", mb: 0.5 }}>
                入库时的解析降级（这部分内容可能搜不到）：
              </Typography>
              {detail?.warnings?.map((warning) => (
                <Typography key={warning} sx={{ fontSize: 11.5, color: "text.secondary" }}>
                  · {warning}
                </Typography>
              ))}
            </Box>
          )}
        </Box>

        <Divider />
        <Box sx={{ px: { xs: 2.5, sm: 4.5 }, py: 1, flexShrink: 0 }}>
          <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
            {canEdit
              ? "⌘/Ctrl + S 保存。图片下方那行图注可以直接改 —— 它是这张图参与检索的全部内容。保存后会重新切块并重建索引。"
              : "只有团队管理员可以编辑正文（含图片下方的图注）。要改内容请联系管理员，或用「上传文件」重新入库一篇。"}
          </Typography>
        </Box>
      </Stack>

      {/* 选图上传：图片先入库拿到 id，再插进编辑器（粘贴走同一条路） */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
        hidden
        data-testid="kb-doc-image-input"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          // 允许再次选同一个文件（不清空的话第二次选不会触发 change）
          event.target.value = "";
          if (!file || !onUploadImage) return;
          void onUploadImage(file).then((uploaded) => {
            if (uploaded) editorRef.current?.insertImage(uploaded.blobUrl, uploaded.alt);
          });
        }}
      />

      {/* 有未保存改动时关抽屉要先问：这一步只花一次点击，收益是「刚才那几百字还在」 */}
      <Dialog open={confirmLeave} onClose={() => setConfirmLeave(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>还有未保存的修改</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
            关闭会丢掉这些改动，知识库里的正文仍是上一次保存的版本。
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 1.75 }}>
          <Button size="small" onClick={() => setConfirmLeave(false)}>
            继续编辑
          </Button>
          <Button
            size="small"
            color="error"
            variant="contained"
            data-testid="kb-doc-discard-edits"
            onClick={() => {
              setConfirmLeave(false);
              setDraft(null);
              onClose();
            }}
          >
            放弃修改
          </Button>
        </DialogActions>
      </Dialog>

      <Menu
        anchorEl={menuAnchor}
        open={menuAnchor !== null}
        onClose={() => setMenuAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: 208, py: 0.5 } } }}
      >
        <MenuItem
          data-testid="kb-doc-copy"
          onClick={() => void copyContent()}
          sx={{ py: 0.6 }}
        >
          <ListItemIcon sx={{ minWidth: 34, color: "text.secondary" }}>
            <ContentCopyIcon sx={{ fontSize: 18 }} />
          </ListItemIcon>
          <ListItemText primary="复制正文" primaryTypographyProps={{ fontSize: 13 }} />
        </MenuItem>
        <MenuItem data-testid="kb-doc-export" onClick={exportMarkdown} sx={{ py: 0.6 }}>
          <ListItemIcon sx={{ minWidth: 34, color: "text.secondary" }}>
            <DownloadOutlinedIcon sx={{ fontSize: 18 }} />
          </ListItemIcon>
          <ListItemText
            primary="下载为 .md"
            secondary="导出的是拼回来的正文"
            primaryTypographyProps={{ fontSize: 13 }}
            secondaryTypographyProps={{ fontSize: 10.5 }}
          />
        </MenuItem>
        <MenuItem
          data-testid="kb-doc-rename-from-view"
          onClick={() => {
            setMenuAnchor(null);
            if (doc) onRename(doc);
          }}
          sx={{ py: 0.6 }}
        >
          <ListItemIcon sx={{ minWidth: 34, color: "text.secondary" }}>
            <EditOutlinedIcon sx={{ fontSize: 18 }} />
          </ListItemIcon>
          <ListItemText primary="重命名" primaryTypographyProps={{ fontSize: 13 }} />
        </MenuItem>
        <MenuItem
          data-testid="kb-doc-delete-from-view"
          onClick={() => {
            setMenuAnchor(null);
            if (doc) onDelete(doc);
          }}
          sx={{ py: 0.6 }}
        >
          <ListItemIcon sx={{ minWidth: 34, color: "error.main" }}>
            <DeleteOutlineIcon sx={{ fontSize: 18 }} />
          </ListItemIcon>
          <ListItemText
            primary="删除（进回收站）"
            primaryTypographyProps={{ fontSize: 13, color: "error.main" }}
          />
        </MenuItem>
      </Menu>
    </Drawer>
  );
}
