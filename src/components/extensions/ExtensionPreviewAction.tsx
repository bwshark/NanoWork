import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import ExtensionOutlinedIcon from "@mui/icons-material/ExtensionOutlined";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import { useExtensionsStore } from "@/stores/extensionsStore";
import {
  listArtifactPreviewers,
  matchArtifactPreview,
} from "@/lib/extension/artifactPreview";
import { platform } from "@/platform";
import type { Artifact } from "@/types";
import type { ExtensionArtifactPreview, InstalledExtension } from "@/types/extension";

/**
 * 产物头部那一颗「用扩展打开」按钮。
 *
 * ## 两种形态，因为产物有两种
 *
 * - **自动命中**（`.pdf` / `.csv` / `.log` 这类有文件名的产物）：直接显示
 *   「用 X 打开」，一步到位；
 * - **手动选择**（围栏代码块产物）：模型直接吐一段日志/CSV 时，产物是
 *   `type: 'code'`、标题是「代码块 (text) 1」——**没有文件名**，任何 `ext:` 声明都
 *   匹配不上。这时给一个下拉，把已安装的预览器全列出来让用户自己挑。
 *
 * 没有第二形态的话，最常见的场景（"让 AI 输出一段日志"）就永远看不到入口——
 * 而用户会以为扩展没装上。
 *
 * ## 为什么整块另存一个懒加载组件
 *
 * `ArtifactRenderer` 在 `AppLayout` 的**静态**依赖链上。预览弹层要拉起 iframe 宿主、
 * 主题、平台桥，把这些静态挂上去会直接抬高首屏（本项目有 1.5 MB 预算门禁）。
 * 所以：按钮本身很轻（一次 store 订阅 + 一次匹配），弹层走 `lazy()`，点开才下载。
 *
 * ## 为什么非桌面端直接不渲染
 *
 * Web 端没有 `nanowork-ext://` 协议，也没有扩展目录——按钮点开只会是一个白框。
 */
const ExtensionPreviewDialog = lazy(() =>
  import("./ExtensionPreviewDialog").then((m) => ({
    default: m.ExtensionPreviewDialog,
  })),
);

/** 正在用哪个预览器打开 */
interface OpenedPreview {
  extension: InstalledExtension;
  preview: ExtensionArtifactPreview;
  matchedBizType: string;
}

export function ExtensionPreviewAction({ artifact }: { artifact: Artifact }) {
  const extensions = useExtensionsStore((s) => s.extensions);
  const ensureLoaded = useExtensionsStore((s) => s.ensureLoaded);
  const [opened, setOpened] = useState<OpenedPreview | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const isElectron = platform.env === "electron";
  // 第一次用到时才扫扩展目录（单飞，见 store 的 `ensureLoaded`）。
  useEffect(() => {
    if (!isElectron) return;
    void ensureLoaded();
  }, [ensureLoaded, isElectron]);

  const match = useMemo(
    () => matchArtifactPreview(artifact, extensions),
    [artifact, extensions],
  );
  const available = useMemo(() => listArtifactPreviewers(extensions), [extensions]);

  if (!isElectron) return null;
  if (!match && available.length === 0) return null;

  return (
    <>
      {/* 独占一行右对齐：产物面板与消息流内联两种宿主下位置一致，
          不挤在「下载」旁边（那里已经有标题与下载按钮，再塞一个会认不出谁是谁）。 */}
      <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 1 }}>
        {match ? (
          <Button
            size="small"
            variant="outlined"
            startIcon={<ExtensionOutlinedIcon sx={{ fontSize: 15 }} />}
            onClick={() =>
              setOpened({
                extension: match.extension,
                preview: match.preview,
                matchedBizType: match.matchedBizType,
              })
            }
            sx={{ textTransform: "none", fontSize: 12, py: 0.25 }}
          >
            用 {match.preview.label} 打开
          </Button>
        ) : (
          <Button
            size="small"
            variant="outlined"
            startIcon={<ExtensionOutlinedIcon sx={{ fontSize: 15 }} />}
            endIcon={<ArrowDropDownIcon sx={{ fontSize: 16 }} />}
            onClick={(e) => setMenuAnchor(e.currentTarget)}
            sx={{ textTransform: "none", fontSize: 12, py: 0.25 }}
          >
            用扩展预览
          </Button>
        )}
      </Box>

      {/* 手动选择预览器：只在自动匹配不到时出现（命中时列表里没有"更对"的选项） */}
      <Menu
        anchorEl={menuAnchor}
        open={menuAnchor !== null}
        onClose={() => setMenuAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {available.map(({ extension, preview }) => (
          <MenuItem
            key={`${extension.manifest.id}/${preview.id}`}
            onClick={() => {
              setMenuAnchor(null);
              setOpened({
                extension,
                preview,
                // 手动选择时用预览器自己声明的 bizType：页面按它分支渲染
                matchedBizType: preview.match.bizType,
              });
            }}
            sx={{ gap: 1 }}
          >
            <ListItemText primary={preview.label} />
            <Typography sx={{ fontSize: 11.5, color: "text.disabled" }}>
              {extension.manifest.name}
            </Typography>
          </MenuItem>
        ))}
      </Menu>

      {opened && (
        <Suspense fallback={<CircularProgress size={14} />}>
          <ExtensionPreviewDialog
            open={opened !== null}
            artifact={artifact}
            extension={opened.extension}
            preview={opened.preview}
            matchedBizType={opened.matchedBizType}
            onClose={() => setOpened(null)}
          />
        </Suspense>
      )}
    </>
  );
}
