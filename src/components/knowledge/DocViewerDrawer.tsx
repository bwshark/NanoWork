import { useState } from "react";
import {
  Box,
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
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { toast } from "@/components/Toast";
import { MarkdownView } from "@/components/MarkdownView";
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
}: DocViewerDrawerProps) {
  const [wide, setWide] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const content = detail?.content ?? "";
  const meta = doc === null ? "" : `${kindLabel(doc.kind)} · ${doc.chars} 字 · ${doc.chunkCount} 块`;
  const updated = doc === null ? "" : formatRelativeTime(docUpdatedAt(doc));

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
            <IconButton size="small" aria-label="关闭" data-testid="kb-doc-view-close" onClick={onClose}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>

        {/* 元信息：格式 / 字数 / 块数 / 更新时间。「拼回来的」这句放这里，
            让人在开始读之前就知道它不等于原文件 */}
        <Box sx={{ px: { xs: 2.5, sm: 4.5 }, pt: 2, flexShrink: 0 }}>
          <Typography sx={{ fontSize: 11.5, color: "text.secondary" }} data-testid="kb-doc-view-meta">
            {meta}
            {updated !== "" ? ` · ${updated}更新` : ""} · 正文由入库时的分块拼回，原排版与图片不在其中
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
            <Box
              sx={{
                maxWidth: 720,
                // 覆盖 `.md-body` 的「对话排版」：那套是给消息气泡用的（14px / 行距 1.7 /
                // 标题只比正文大一点）。同一份内容放在阅读抽屉里必须像一份文档 ——
                // 大标题、宽行距、列表有符号（全局 reset 把 ul 的项目符号去掉了）
                "& .md-body": { fontSize: 14.5, lineHeight: 1.95 },
                "& .md-body h1": {
                  fontSize: 30,
                  fontWeight: 700,
                  letterSpacing: -0.2,
                  mt: 0,
                  mb: 2,
                },
                "& .md-body h2": { fontSize: 21, fontWeight: 700, mt: 3.5, mb: 1.25 },
                "& .md-body h3": { fontSize: 17, fontWeight: 600, mt: 2.5, mb: 1 },
                "& .md-body p": { my: 1.25 },
                "& .md-body ul": { listStyle: "disc", pl: 3, my: 1 },
                "& .md-body ol": { listStyle: "decimal", pl: 3, my: 1 },
                "& .md-body li": { display: "list-item", my: 0.5 },
                "& .md-body li::marker": { color: "text.secondary" },
                "& .md-body table": { fontSize: 13, my: 2 },
                "& .md-body blockquote": {
                  borderLeft: "3px solid",
                  borderColor: "divider",
                  pl: 2,
                  my: 2,
                  color: "text.secondary",
                },
              }}
              data-testid="kb-doc-view-body"
            >
              {/* 用 MarkdownView 而不是自己按 \n 切段：.md 上传的文档带标题/列表/表格，
                  按纯文本渲染会把它们全变成一行行字；它也自带懒加载边界的纯文本兜底 */}
              <MarkdownView content={content} />
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
            正文不可在客户端编辑；要改内容请重新上传（同名内容会被判重拦下，先删掉再传）。
          </Typography>
        </Box>
      </Stack>

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
