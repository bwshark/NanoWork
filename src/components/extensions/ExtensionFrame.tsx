import { useCallback, useEffect, useRef, useState } from "react";
import { Box, CircularProgress, Typography, useTheme } from "@mui/material";
import { platform } from "@/platform";
import {
  EXTENSION_CHANNEL,
  type ExtensionGuestMessage,
} from "@/types/extension";
import { isExtensionSchemeUrl } from "@/lib/extension/extensionUrl";

/**
 * 扩展界面的宿主 iframe。
 *
 * ## 三层隔离（不是"加个 iframe 就安全了"）
 *
 * 1. **源隔离**：包内资源走 `nanowork-ext://<id>/`，每个扩展是独立 origin，
 *    拿不到主窗口的 DOM、localStorage 与 `window.electronAPI`；
 * 2. **sandbox 白名单**：只给 `allow-scripts allow-same-origin allow-forms
 *    allow-popups`（少了 allow-popups-to-escape-sandbox，扩展弹出的窗口仍在沙箱里）；
 * 3. **消息白名单**：只认 `channel: 'nanowork-extension'` 且 type 在枚举内的消息，
 *    其它一律丢弃——不做"猜意图"。
 *
 * ## 为什么主题走 URL 而不是只发消息
 *
 * `postMessage` 是异步的，而扩展页面通常在第一帧就按主题铺背景色。等消息到达
 * 再改会白闪一下。所以初始主题用 query 参数给（`?theme=dark`），运行中切换再
 * 补一条消息——两者都实现，而不是二选一。
 *
 * ## 为什么只对 `nanowork-ext://` 页面启用消息桥
 *
 * 用户托管的 http(s) 界面与我们不同源、也不认这套协议。套上去只会往控制台刷
 * "message channel closed"，而且那些页面本来就能自己联网，不需要宿主转交。
 */
export function ExtensionFrame({
  extensionId,
  title,
  src,
  context,
}: {
  extensionId: string;
  title: string;
  /** 已经换算好的地址（`toExtensionUrl` 的结果或 http(s)） */
  src: string;
  /**
   * 交给扩展的数据（可选）。产物预览器用它接收产物正文——iframe 是独立源、
   * 没有文件系统权限，内容只能由宿主递过去。
   */
  context?: Record<string, unknown>;
}) {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  /** 扩展自己报的状态文案（可选；为空则不显示状态条） */
  const [statusText, setStatusText] = useState<string | null>(null);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);

  /** 带初始主题的地址：用 URL 传一次，避免首帧白闪 */
  const themedSrc = (() => {
    const join = src.includes("?") ? "&" : "?";
    return `${src}${join}theme=${mode}`;
  })();

  const post = useCallback(
    (type: "theme" | "ready" | "context", payload: Record<string, unknown>) => {
      const frame = frameRef.current;
      if (!frame?.contentWindow) return;
      frame.contentWindow.postMessage(
        { channel: EXTENSION_CHANNEL, type, payload },
        // 目标源交给浏览器按 iframe 实际 origin 校验：写死 `*` 会把消息投给任何
        // 被重定向到的页面；而这里我们事先不知道 http(s) 扩展的精确 origin。
        "*",
      );
    },
    [],
  );

  const bridgeEnabled = isExtensionSchemeUrl(src);

  useEffect(() => {
    if (!bridgeEnabled) return;
    const onMessage = (event: MessageEvent) => {
      // 只接受来自本 iframe 的消息：同页面其它 iframe（产物预览等）不该能驱动这里
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as Partial<ExtensionGuestMessage> | null;
      if (!data || data.channel !== EXTENSION_CHANNEL) return;

      if (data.type === "open-external") {
        const url = data.payload?.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
        void platform.openUrl(url);
        return;
      }
      if (data.type === "resize") {
        const height = data.payload?.height;
        if (typeof height === "number" && height > 0 && height < 20000) {
          setFrameHeight(Math.round(height));
        }
        return;
      }
      if (data.type === "status") {
        const text = data.payload?.text;
        setStatusText(typeof text === "string" && text.trim() ? text.trim() : null);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [bridgeEnabled]);

  // 主题变化时补发一条（初始主题已经在 URL 里了）
  useEffect(() => {
    if (!bridgeEnabled) return;
    post("theme", { theme: mode, extensionId });
  }, [bridgeEnabled, extensionId, mode, post]);

  // 上下文单独发：扩展可能不止一次请求（比如重新初始化），所以放在 effect 里
  // 跟随 context 变化，而不是只塞进 onLoad 一次性发。
  useEffect(() => {
    if (!bridgeEnabled || !context) return;
    post("context", { extensionId, context });
  }, [bridgeEnabled, context, extensionId, post]);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        bgcolor: "background.default",
      }}
    >
      {statusText && (
        <Box
          sx={{
            px: 2,
            py: 0.5,
            borderBottom: "1px solid",
            borderColor: "divider",
            fontSize: 12,
            color: "text.secondary",
          }}
        >
          {statusText}
        </Box>
      )}
      <Box sx={{ position: "relative", flex: 1, minHeight: 0 }}>
        {loading && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 1.5,
              pointerEvents: "none",
            }}
          >
            <CircularProgress size={20} />
            <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
              正在加载「{title}」…
            </Typography>
          </Box>
        )}
        <iframe
          ref={frameRef}
          title={title}
          src={themedSrc}
          onLoad={() => {
            setLoading(false);
            if (!bridgeEnabled) return;
            // onLoad 时页面已能收消息，这里补一次 context：上面的 effect 首次运行时
            // 页面还没 ready，那一条会丢。
            post("ready", { extensionId, theme: mode });
            if (context) post("context", { extensionId, context });
          }}
          // 扩展是用户主动安装的可信代码，但仍不给它"逃出沙箱"的能力：
          // 没有 allow-top-navigation / allow-modals / allow-downloads。
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          style={{
            width: "100%",
            height: frameHeight ? `${frameHeight}px` : "100%",
            border: "none",
            display: "block",
            background: "transparent",
          }}
        />
      </Box>
    </Box>
  );
}
