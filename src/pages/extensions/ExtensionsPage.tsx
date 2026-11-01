import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import AddIcon from "@mui/icons-material/Add";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import ExtensionOutlinedIcon from "@mui/icons-material/ExtensionOutlined";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CloseIcon from "@mui/icons-material/Close";
import DownloadIcon from "@mui/icons-material/Download";
import { useExtensionsStore } from "@/stores/extensionsStore";
import { toast } from "@/components/Toast";
import { ExtensionFrame } from "@/components/extensions/ExtensionFrame";
import { toExtensionUrl } from "@/lib/extension/extensionUrl";
import { platform } from "@/platform";
import {
  cardChipOutlinedSx,
  cardStatusChipSx,
  clampLines,
  hoverCardSx,
  iconTileSx,
} from "@/lib/ui/cardSx";
import type { ExtensionServiceState, InstalledExtension } from "@/types/extension";

/**
 * 扩展页（对齐 WorkBuddy `resources/extensions/` 的宿主资产）。
 *
 * ## 这一页要回答的三个问题
 *
 * 1. **我装了什么**：卡片列出界面入口、后台服务、预览器与设置挂载点；
 * 2. **它现在在跑什么**：服务三态（停 / 运行 / 崩溃）+ 最近日志，崩溃必须显眼；
 * 3. **出问题去哪儿看**：目录路径常驻，坏掉的清单单独列在页头下方（`skipped`），
 *    而不是让它"什么都不显示"。
 *
 * ## 为什么服务不自动启动
 *
 * 原版 WorkBuddy 随宿主 `fork` 扩展服务。这里要求用户显式点「启动」：
 * 第三方 node 代码常驻不是默认该发生的事，尤其是用户只想看看这个扩展长什么样时。
 */

const SERVICE_LABEL: Record<ExtensionServiceState, string> = {
  stopped: "未运行",
  starting: "启动中",
  running: "运行中",
  crashed: "已崩溃",
};

const SERVICE_TONE: Record<ExtensionServiceState, "default" | "success" | "warning" | "error"> = {
  stopped: "default",
  starting: "warning",
  running: "success",
  crashed: "error",
};

export function ExtensionsPage() {
  const extensions = useExtensionsStore((s) => s.extensions);
  const skipped = useExtensionsStore((s) => s.skipped);
  const root = useExtensionsStore((s) => s.extensionsRoot);
  const error = useExtensionsStore((s) => s.error);
  const hint = useExtensionsStore((s) => s.hint);
  const loaded = useExtensionsStore((s) => s.loaded);
  const refreshing = useExtensionsStore((s) => s.refreshing);
  const services = useExtensionsStore((s) => s.services);
  const refresh = useExtensionsStore((s) => s.refresh);
  const startService = useExtensionsStore((s) => s.startService);
  const stopService = useExtensionsStore((s) => s.stopService);
  const refreshServices = useExtensionsStore((s) => s.refreshServices);
  const installSample = useExtensionsStore((s) => s.installSample);
  const [installing, setInstalling] = useState(false);

  /** 当前打开的扩展界面（非空即打开全屏弹层） */
  const [opened, setOpened] = useState<InstalledExtension | null>(null);
  /** 展开日志的扩展 id */
  const [logOpen, setLogOpen] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 有服务在跑时才轮询：静止页面不该每 3 秒发一次 IPC
  const hasRunning = useMemo(
    () => Object.values(services).some((s) => s.state === "running" || s.state === "starting"),
    [services],
  );
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => void refreshServices(), 3000);
    return () => clearInterval(timer);
  }, [hasRunning, refreshServices]);

  const openUi = (ext: InstalledExtension) => {
    const entry = ext.manifest.ui?.entry;
    if (!entry) return;
    setOpened(ext);
  };

  /**
   * 安装扩展：选一个目录，整体复制成 `extensions/<清单 id>`。
   *
   * 一定要有这颗按钮。没有它，用户只能手工复制——而"复制成什么样"几乎必然出错
   * （`cp -r pkg/* dest/` 与 `cp -r pkg dest/` 差别就一个星号，结果天壤之别）。
   * 这正是本项目里「装了一个扩展但页面上什么都看不到」的头号原因。
   *
   * `overwrite = true`：安装语义就是"把这个版本装上"，覆盖旧版是升级的常态。
   */
  const handleInstall = async () => {
    const dir = await platform.pickDirectory();
    if (!dir) return;
    setInstalling(true);
    try {
      const result = await platform.installExtension(dir, true);
      if (!result.ok) {
        toast.error(result.error ?? '安装失败');
        return;
      }
      toast.success(`已安装扩展「${result.id}」`);
      await refresh();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Box sx={{ p: 3, maxWidth: "100%", margin: "0 auto" }}>
      <Box sx={{ display: "flex", alignItems: "flex-end", gap: 1.5, mb: 2 }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>
            能力扩展
          </Typography>
          <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: 0.25 }}>
            扩展给应用加"界面"与"后台服务"；插件改的是 AI 的技能与工具。
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          variant="contained"
          startIcon={
            installing ? (
              <CircularProgress size={14} />
            ) : (
              <AddIcon sx={{ fontSize: 18 }} />
            )
          }
          disabled={installing || platform.env !== "electron"}
          onClick={() => void handleInstall()}
          sx={{ textTransform: "none" }}
        >
          安装扩展
        </Button>
        {/* 示例扩展：免去找目录。「安装扩展」要用户自己挑一个目录，而"该挑哪个目录"
            这件事本身就是劝退点——装不上的人不是不想装，是不知道装哪儿。 */}
        <Button
          size="small"
          variant="outlined"
          startIcon={<DownloadIcon sx={{ fontSize: 18 }} />}
          disabled={installing || platform.env !== "electron"}
          onClick={() => void installSample()}
          sx={{ textTransform: "none" }}
        >
          安装示例扩展
        </Button>
        {root && (
          <Button
            size="small"
            startIcon={<FolderOpenIcon sx={{ fontSize: 18 }} />}
            onClick={() => void platform.openPath(root)}
            sx={{ textTransform: "none", color: "text.secondary" }}
          >
            打开目录
          </Button>
        )}
        <Button
          size="small"
          variant="outlined"
          startIcon={
            refreshing ? (
              <CircularProgress size={14} />
            ) : (
              <RefreshIcon sx={{ fontSize: 18 }} />
            )
          }
          disabled={refreshing}
          onClick={() => void refresh()}
          sx={{ textTransform: "none" }}
        >
          重新扫描
        </Button>
      </Box>

      {error && (
        <Alert severity="info" sx={{ mb: 2, fontSize: 12.5 }}>
          {error}
        </Alert>
      )}

      {/* 装错结构的提示：扫描器只遍历子目录，文件直接躺在根目录时"一个扩展都看不见"。
          不说清楚的话，用户只会以为功能没做——这是本项目里最高频的误判。 */}
      {hint && (
        <Alert severity="warning" sx={{ mb: 2, fontSize: 12.5 }}>
          {hint}
        </Alert>
      )}

      {skipped.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2, fontSize: 12.5 }}>
          以下目录没有可用的 <code>extension.json</code>，已跳过：{skipped.join("、")}
        </Alert>
      )}

      {!loaded ? (
        <Box sx={{ py: 8, textAlign: "center" }}>
          <CircularProgress size={22} />
        </Box>
      ) : extensions.length === 0 ? (
        <EmptyGuide root={root} />
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
            gap: 2,
          }}
        >
          {extensions.map((ext) => {
            const status = services[ext.manifest.id];
            const state = status?.state ?? "stopped";
            const hasUi = !!ext.manifest.ui?.entry;
            const hasService = !!ext.manifest.service;
            const previews = ext.manifest.ui?.artifactPreviews?.length ?? 0;
            const settings = ext.manifest.ui?.settings?.length ?? 0;

            return (
              <Box
                key={ext.manifest.id}
                sx={{
                  ...hoverCardSx,
                  p: 2,
                  display: "flex",
                  flexDirection: "column",
                  gap: 1.25,
                }}
              >
                <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.25 }}>
                  <Box sx={iconTileSx(ext.manifest.id)}>
                    <ExtensionOutlinedIcon sx={{ fontSize: 20 }} />
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography fontWeight={600} sx={{ ...clampLines(1) }}>
                      {ext.manifest.name}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ ...clampLines(1), wordBreak: "break-all" }}
                    >
                      {ext.manifest.id} · v{ext.manifest.version}
                    </Typography>
                  </Box>
                  {hasService && (
                    <Chip
                      size="small"
                      color={SERVICE_TONE[state]}
                      variant={state === "running" ? "filled" : "outlined"}
                      label={SERVICE_LABEL[state]}
                      sx={cardStatusChipSx}
                    />
                  )}
                </Box>

                {ext.manifest.description && (
                  <Typography variant="body2" color="text.secondary" sx={clampLines(2)}>
                    {ext.manifest.description}
                  </Typography>
                )}

                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                  {hasUi && (
                    <Chip size="small" variant="outlined" label="界面" sx={cardChipOutlinedSx} />
                  )}
                  {hasService && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label="后台服务"
                      sx={cardChipOutlinedSx}
                    />
                  )}
                  {previews > 0 && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`${previews} 个预览器`}
                      sx={cardChipOutlinedSx}
                    />
                  )}
                  {settings > 0 && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`${settings} 个设置项`}
                      sx={cardChipOutlinedSx}
                    />
                  )}
                  {ext.issues.length > 0 && (
                    <Tooltip title={ext.issues.join("；")}>
                      <Chip
                        size="small"
                        color="warning"
                        variant="outlined"
                        label={`${ext.issues.length} 条清单提示`}
                        sx={cardStatusChipSx}
                      />
                    </Tooltip>
                  )}
                </Stack>

                {status?.error && (
                  <Typography sx={{ fontSize: 12, color: "warning.main", lineHeight: 1.6 }}>
                    {status.error}
                  </Typography>
                )}

                <Box sx={{ flex: 1 }} />
                <Divider flexItem />

                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                  <Tooltip title={hasUi ? "打开扩展界面" : "该扩展没有声明界面"}>
                    <span>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={!hasUi}
                        startIcon={<OpenInNewIcon sx={{ fontSize: 16 }} />}
                        onClick={() => openUi(ext)}
                        sx={{ textTransform: "none" }}
                      >
                        打开
                      </Button>
                    </span>
                  </Tooltip>
                  {hasService && (
                    <>
                      <Button
                        size="small"
                        variant="text"
                        startIcon={
                          state === "running" ? (
                            <StopIcon sx={{ fontSize: 16 }} />
                          ) : (
                            <PlayArrowIcon sx={{ fontSize: 16 }} />
                          )
                        }
                        onClick={() =>
                          void (state === "running"
                            ? stopService(ext.manifest.id)
                            : startService(ext.manifest.id))
                        }
                        sx={{ textTransform: "none" }}
                      >
                        {state === "running" ? "停止服务" : "启动服务"}
                      </Button>
                      <IconButton
                        size="small"
                        aria-label="查看服务日志"
                        onClick={() =>
                          setLogOpen((v) => (v === ext.manifest.id ? null : ext.manifest.id))
                        }
                      >
                        <ExpandMoreIcon
                          sx={{
                            fontSize: 18,
                            transform: logOpen === ext.manifest.id ? "rotate(180deg)" : "none",
                            transition: "transform .15s",
                          }}
                        />
                      </IconButton>
                    </>
                  )}
                  <Box sx={{ flex: 1 }} />
                  <Tooltip title="在文件管理器中打开">
                    <IconButton
                      size="small"
                      aria-label={`打开 ${ext.manifest.name} 目录`}
                      onClick={() => void platform.openPath(ext.root)}
                    >
                      <FolderOpenIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </Box>

                {hasService && (
                  <Collapse in={logOpen === ext.manifest.id} unmountOnExit>
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        p: 1,
                        maxHeight: 160,
                        overflow: "auto",
                        bgcolor: "action.hover",
                        borderRadius: 1,
                        fontSize: 11.5,
                        lineHeight: 1.6,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                        color: "text.secondary",
                      }}
                    >
                      {(status?.log?.length ?? 0) === 0
                        ? "（还没有输出）"
                        : status!.log.slice(-20).join("\n")}
                    </Box>
                  </Collapse>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* 扩展界面：全屏弹层而不是新窗口。
          理由：扩展要跟宿主共享主题与"打开外部链接"的转交，新窗口就得再建一套
          窗口权限档位；而它本质上是"一个页面"，弹层足够。 */}
      <Dialog
        open={opened !== null}
        onClose={() => setOpened(null)}
        fullScreen
        PaperProps={{ sx: { bgcolor: "background.default" } }}
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, py: 1.5 }}>
          <Typography sx={{ fontSize: 15, fontWeight: 600, flex: 1 }} noWrap>
            {opened?.manifest.name ?? ""}
          </Typography>
          <Tooltip title="关闭">
            <IconButton size="small" onClick={() => setOpened(null)}>
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </DialogTitle>
        <DialogContent sx={{ p: 0, display: "flex", minHeight: 0 }}>
          {opened?.manifest.ui?.entry && (
            <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
              <ExtensionFrame
                extensionId={opened.manifest.id}
                title={opened.manifest.ui.entry.title}
                src={toExtensionUrl(opened.manifest.id, opened.manifest.ui.entry.url)}
              />
            </Box>
          )}
        </DialogContent>
      </Dialog>
    </Box>
  );
}

/** 空态：告诉用户扩展放哪儿、长什么样（光说"没有扩展"没用） */
function EmptyGuide({ root }: { root: string }) {
  const sample = `{
  "id": "hello",
  "name": "Hello 扩展",
  "version": "0.0.1",
  "description": "最小示例",
  "ui": { "entry": { "title": "Hello", "url": "./ui/index.html" } }
}`;

  // Web 端没有本地目录：说"放在 ~/.nanowork/extensions"会让人以为浏览器里也能放。
  // 桌面端才给真实路径（扫描结果里的 root，用户自定义过 NANOWORK_HOME 时更准）。
  const where =
    platform.env === "electron"
      ? root || "~/.nanowork/extensions"
      : "桌面端的 ~/.nanowork/extensions";

  return (
    <Box sx={{ py: 6, maxWidth: 720, mx: "auto" }}>
      <Typography sx={{ fontSize: 14, mb: 1 }}>
        还没有安装扩展。扩展放在 {where} 下，一个目录一个扩展：
      </Typography>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 1.5,
          bgcolor: "action.hover",
          borderRadius: 1,
          fontSize: 12,
          lineHeight: 1.7,
          overflow: "auto",
        }}
      >
        {`extensions/
└── hello/
    ├── extension.json   ← 清单（下面的内容）
    └── ui/index.html    ← 界面入口（自己写 HTML，随便用什么框架）`}
      </Box>
      <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: 1.5, mb: 0.75 }}>
        extension.json 最小内容：
      </Typography>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 1.5,
          bgcolor: "action.hover",
          borderRadius: 1,
          fontSize: 12,
          lineHeight: 1.7,
          overflow: "auto",
        }}
      >
        {sample}
      </Box>
      <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: 1.5 }}>
        一个可直接跑起来的完整样例在仓库的{" "}
        <Box component="code" sx={{ fontSize: 12 }}>
          examples/extensions/hello-world
        </Box>
        （含后台服务与消息桥）。
      </Typography>
    </Box>
  );
}
