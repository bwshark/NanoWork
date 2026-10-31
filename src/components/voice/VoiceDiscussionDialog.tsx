/**
 * 语音讨论面板（对应参考视频：居中大圆角浮层 + 点阵环 + 计时 / 字幕 / 结束）。
 *
 * ## 为什么是 Dialog 而不是内联展开
 * 讨论期间麦克风全程开着、还会外放合成语音。把它做成页内一块区域时，
 * 用户很容易「一边看对话一边以为已经退出了」——浮层 + 背景压暗是唯一的
 * 「现在在录音」的强提示。`Modal`/`Dialog` 还免费给了焦点陷阱与 Esc 关闭。
 *
 * ## 字幕默认关
 * 与视频一致：默认只有点阵环（极简、专注听），点右上角才展开逐句文本。
 * 默认开会让面板看起来像聊天窗口，失去「语音」的形态。
 *
 * ## 三个按钮的顺序为什么是「静音 / 结束」
 * 参考视频是「麦克风 / 结束 / 图片」。图片（发截图给 AI）不在本功能的
 * 能力范围内，摆一个点了没用的按钮比不摆更糟；其余两个位置逐一对应。
 */

import { useEffect, useRef } from "react";
import { Box, Dialog, IconButton, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import CloseIcon from "@mui/icons-material/Close";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import MicIcon from "@mui/icons-material/Mic";
import MicOffIcon from "@mui/icons-material/MicOff";
import SubtitlesIcon from "@mui/icons-material/Subtitles";
import { formatDuration } from "@/hooks/useVoiceInput";
import type { DiscussionTurn, VoiceDiscussionPhase } from "@/hooks/useVoiceDiscussion";
import { VoiceRing } from "./VoiceRing";

export interface VoiceDiscussionDialogProps {
  open: boolean;
  phase: VoiceDiscussionPhase;
  seconds: number;
  level: number;
  turns: DiscussionTurn[];
  liveText: string;
  muted: boolean;
  subtitles: boolean;
  notice: string | null;
  onToggleMute: () => void;
  onToggleSubtitles: () => void;
  /** 结束并生成纪要 */
  onFinish: () => void;
  /** 直接关闭（不生成纪要） */
  onCancel: () => void;
}

/** 面板状态文案（`说点什么` / `可以继续说话来打断` 与参考视频一字不差） */
function statusText(phase: VoiceDiscussionPhase, muted: boolean, hasLive: boolean): string {
  switch (phase) {
    case "starting":
      return "正在打开麦克风…";
    case "listening":
      if (muted) return "已静音，点击麦克风继续";
      return hasLive ? "正在听…" : "说点什么";
    case "thinking":
      return "正在想…";
    case "speaking":
      return "可以继续说话来打断";
    case "ending":
      return "正在整理讨论纪要…";
    default:
      return "";
  }
}

export function VoiceDiscussionDialog({
  open,
  phase,
  seconds,
  level,
  turns,
  liveText,
  muted,
  subtitles,
  notice,
  onToggleMute,
  onToggleSubtitles,
  onFinish,
  onCancel,
}: VoiceDiscussionDialogProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 字幕模式：新内容进来滚到底（不滚动的话用户看到的是第一句，以为卡住了）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns, liveText, subtitles]);

  const busy = phase === "ending";
  const showRing = !subtitles || turns.length === 0;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      maxWidth={false}
      PaperProps={{
        sx: {
          // 尺寸按参考视频的比例：宽度约 60%、高度固定，避免内容多少导致面板跳动
          width: "min(620px, 92vw)",
          height: "min(540px, 76vh)",
          borderRadius: "22px",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          bgcolor: (t) =>
            t.palette.mode === "dark" ? "#16181d" : t.palette.background.paper,
          backgroundImage: "none",
        },
      }}
    >
      {/* 顶栏：计时居中，右侧字幕开关 + 关闭 */}
      <Box
        sx={{
          position: "relative",
          height: 56,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          px: 1.5,
        }}
      >
        <Typography
          sx={{
            fontSize: 13,
            color: "text.secondary",
            fontVariantNumeric: "tabular-nums",
            userSelect: "none",
          }}
        >
          {formatDuration(seconds)}
        </Typography>
        <Box sx={{ position: "absolute", right: 8, display: "flex", alignItems: "center", gap: 0.5 }}>
          <Tooltip title={subtitles ? "关闭字幕" : "开启字幕"}>
            <IconButton
              size="small"
              onClick={onToggleSubtitles}
              aria-label={subtitles ? "关闭字幕" : "开启字幕"}
              aria-pressed={subtitles}
              sx={{ color: subtitles ? "text.primary" : "text.secondary" }}
            >
              <SubtitlesIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="关闭">
            <IconButton size="small" onClick={onCancel} aria-label="关闭语音讨论" sx={{ color: "text.secondary" }}>
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* 主体：点阵环 或 字幕 */}
      <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
        {showRing && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <VoiceRing level={level} active={phase === "listening" || phase === "speaking"} />
          </Box>
        )}

        {subtitles && (
          <Box
            ref={scrollRef}
            sx={{
              position: "absolute",
              inset: 0,
              overflowY: "auto",
              px: 3,
              py: 1,
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
          >
            {turns.length === 0 && liveText === "" && (
              <Typography sx={{ fontSize: 13, color: "text.disabled", mt: 2, textAlign: "center" }}>
                还没有对话，直接说话就行
              </Typography>
            )}
            {turns.map((turn) => (
              <Box
                key={turn.id}
                sx={{
                  alignSelf: turn.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "82%",
                  px: 1.5,
                  py: 1,
                  borderRadius: "14px",
                  bgcolor: (t) =>
                    turn.role === "user"
                      ? alpha(t.palette.primary.main, t.palette.mode === "dark" ? 0.14 : 0.08)
                      : alpha(t.palette.text.primary, t.palette.mode === "dark" ? 0.06 : 0.05),
                  fontSize: 13.5,
                  lineHeight: 1.6,
                  color: "text.primary",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {turn.text}
                {turn.streaming && (
                  <Box
                    component="span"
                    sx={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      ml: 0.5,
                      borderRadius: "50%",
                      bgcolor: "text.disabled",
                      "@keyframes voiceCaret": { "0%,100%": { opacity: 0.2 }, "50%": { opacity: 1 } },
                      animation: "voiceCaret 1s ease-in-out infinite",
                    }}
                  />
                )}
              </Box>
            ))}
            {liveText !== "" && (
              <Box
                sx={{
                  alignSelf: "flex-end",
                  maxWidth: "82%",
                  px: 1.5,
                  py: 1,
                  borderRadius: "14px",
                  border: "1px dashed",
                  borderColor: "divider",
                  fontSize: 13.5,
                  lineHeight: 1.6,
                  color: "text.secondary",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {liveText}
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* 状态行 + 按钮组 */}
      <Box sx={{ flex: "0 0 auto", pb: 3, pt: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1 }}>
          <GraphicEqIcon sx={{ fontSize: 16, color: "text.disabled" }} />
          <Typography sx={{ fontSize: 12.5, color: "text.secondary", userSelect: "none" }}>
            {statusText(phase, muted, liveText !== "")}
          </Typography>
        </Box>
        {notice && (
          <Typography
            sx={{
              mt: 0.75,
              px: 3,
              fontSize: 11.5,
              color: "text.disabled",
              textAlign: "center",
              userSelect: "none",
            }}
          >
            {notice}
          </Typography>
        )}

        <Box
          sx={{
            mt: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 2.5,
          }}
        >
          <Tooltip title={muted ? "取消静音" : "静音"}>
            <span>
              <IconButton
                onClick={onToggleMute}
                disabled={busy}
                aria-label={muted ? "取消静音" : "静音"}
                aria-pressed={muted}
                sx={(t) => ({
                  width: 46,
                  height: 46,
                  bgcolor: muted
                    ? alpha(t.palette.error.main, 0.16)
                    : "action.hover",
                  color: muted ? "error.main" : "text.primary",
                  "&:hover": {
                    bgcolor: muted
                      ? alpha(t.palette.error.main, 0.24)
                      : "action.selected",
                  },
                })}
              >
                {muted ? <MicOffIcon sx={{ fontSize: 20 }} /> : <MicIcon sx={{ fontSize: 20 }} />}
              </IconButton>
            </span>
          </Tooltip>

          <Box
            role="button"
            tabIndex={0}
            aria-label="结束语音讨论"
            onClick={busy ? undefined : onFinish}
            onKeyDown={(e) => {
              if (busy) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onFinish();
              }
            }}
            sx={(t) => ({
              minWidth: 78,
              height: 46,
              px: 2.5,
              borderRadius: 23,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: busy ? "default" : "pointer",
              bgcolor: t.palette.mode === "dark" ? "#e9eaec" : t.palette.primary.main,
              color: t.palette.mode === "dark" ? "#0f1115" : t.palette.primary.contrastText,
              fontSize: 14,
              fontWeight: 600,
              userSelect: "none",
              opacity: busy ? 0.6 : 1,
              "&:hover": { filter: busy ? "none" : "brightness(0.94)" },
            })}
          >
            {busy ? "整理中" : "结束"}
          </Box>
        </Box>
      </Box>
    </Dialog>
  );
}
