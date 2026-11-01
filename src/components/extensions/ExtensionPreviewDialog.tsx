import { useMemo } from "react";
import { Box, Dialog, DialogContent, DialogTitle, IconButton, Tooltip, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { ExtensionFrame } from "@/components/extensions/ExtensionFrame";
import { toExtensionUrl } from "@/lib/extension/extensionUrl";
import type { Artifact } from "@/types";
import type { ExtensionArtifactPreview, InstalledExtension } from "@/types/extension";

/** 交给扩展的正文上限：超过就截断并标记（跨进程传几 MB 文本会把两边都卡住） */
export const PREVIEW_TEXT_LIMIT = 256 * 1024;

/**
 * 扩展产物预览器（**懒加载**，只在用户点开时载入）。
 *
 * ## 为什么是弹层而不是替换产物面板
 *
 * 产物面板的默认渲染是产品内建的基线。扩展预览是"另一种看法"，两者并存才对：
 * 用户点「用 X 打开」看扩展的渲染，关掉还是原来的。替换式接管会让"装了个扩展就
 * 把产物面板改坏"变成默认行为（见 `lib/extension/artifactPreview.ts` 的说明）。
 *
 * ## 内容怎么给扩展
 *
 * iframe 是独立源、没有文件系统权限，读不到 `artifact.path`。所以宿主把**元信息 +
 * 文本快照**经 `postMessage` 递过去（`type: 'context'`）。二进制大文件只给路径与
 * 尺寸 —— 真要读字节得由扩展自己的服务去做，宿主不替它读。
 */
export function ExtensionPreviewDialog({
  open,
  artifact,
  extension,
  preview,
  matchedBizType,
  onClose,
}: {
  open: boolean;
  artifact: Artifact;
  extension: InstalledExtension;
  preview: ExtensionArtifactPreview;
  matchedBizType: string;
  onClose: () => void;
}) {
  const context = useMemo(() => {
    const text = typeof artifact.content === "string" ? artifact.content : "";
    const truncated = text.length > PREVIEW_TEXT_LIMIT;
    return {
      bizType: matchedBizType,
      artifact: {
        id: artifact.id,
        type: artifact.type,
        title: artifact.title ?? "",
        path: artifact.path ?? "",
        language: artifact.language ?? "",
        size: artifact.size ?? null,
        text: truncated ? text.slice(0, PREVIEW_TEXT_LIMIT) : text,
        truncated,
      },
    };
  }, [artifact, matchedBizType]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{ sx: { height: "82vh", bgcolor: "background.default" } }}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, py: 1.25 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600, flex: 1 }} noWrap>
          {preview.label} · {artifact.title ?? artifact.id}
        </Typography>
        <Typography sx={{ fontSize: 11.5, color: "text.disabled" }}>
          由扩展「{extension.manifest.name}」提供
        </Typography>
        <Tooltip title="关闭">
          <IconButton size="small" onClick={onClose}>
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </DialogTitle>
      <DialogContent sx={{ p: 0, display: "flex", minHeight: 0 }}>
        <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
          <ExtensionFrame
            extensionId={extension.manifest.id}
            title={preview.label}
            src={toExtensionUrl(extension.manifest.id, preview.url)}
            context={context}
          />
        </Box>
      </DialogContent>
    </Dialog>
  );
}
