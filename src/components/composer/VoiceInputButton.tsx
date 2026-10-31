/**
 * 语音输入按钮：空闲态麦克风 / 录音态波形 + 环形流线动画。
 *
 * ## 视觉还原（对照参考截图取样）
 * - 空闲：深灰圆底 `action.hover` + 白色麦克风描边
 * - 录音：薄荷白圆底 `#dff7f2` + 薄荷绿 5 根波形条 `#7cdfcb`
 * - 录音时外圈有两层错相位的扩散环（流线感），半径随实时电平放大
 *
 * ## 为什么颜色写死在组件里，不进主题
 * 薄荷绿是**品牌化的「正在听」语义色**，它不属于 MUI 的语义色集合
 * （primary/secondary/success 都被别处占用，且深浅主题里含义不同）。
 * 硬塞进 palette 会污染全局（别的地方误用 `success` 就变成薄荷绿）。
 * 这里用常量 + 深色主题下的微调，注释说明取色来源。
 *
 * ## 动画的三条硬约束
 * 1. **必须 `prefers-reduced-motion` 降级**：前庭功能障碍用户看到
 *    持续扩散的圆环会不适；系统级开关是唯一的合法判据。
 * 2. **不能用 `box-shadow` 做扩散环**：它每帧触发重绘整层，
 *    在 4K 屏上会让输入区打字明显掉帧。用 `transform: scale()` +
 *    `opacity`（走合成层，GPU 独立），见 `@keyframes` 注释。
 * 3. **电平不能直接驱动 scale**：原始电平每帧抖动，环形会「抽搐」。
 *    已在 hook 里做 attack/release 平滑，这里只做线性映射。
 */

import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import KeyboardVoiceIcon from '@mui/icons-material/KeyboardVoice';
import { useTheme } from '@mui/material/styles';
import { alpha } from '@mui/material/styles';
import { memo } from 'react';
import { barHeight, VOICE_BAR_SHAPE } from '@/lib/voice/levels';
import { formatDuration } from '@/hooks/useVoiceInput';

/**
 * 录音态取色：对照参考截图逐像素取样（薄荷白底 `#dff7f2` / 薄荷绿条 `#7cdfcb`）。
 *
 * ⚠️ **必须按主题分两套**：参考图是深色主题。同一组取值放到浅色主题的
 * `#f5f7fa` 背景上，白底与浅绿条几乎糊成一片（实测对比度不足 2:1，
 * 波形完全看不清）。深色下用「浅底 + 浅绿条」是对的（靠底色与暗背景拉开），
 * 浅色下必须反过来用「深绿实底 + 白条」——两种主题下都是「高对比 + 薄荷感」。
 */
const RECORDING_TONE = {
  dark: {
    surface: '#dff7f2',
    accent: '#7cdfcb',
    // 「待配置」虚线圈：深色背景上浅绿可见
    setupRing: 'rgba(124, 223, 203, 0.55)',
  },
  light: {
    surface: '#0f766e',
    accent: '#d7fbf1',
    // 浅色背景上必须用**深绿**：沿用浅绿会让虚线圈在白底上彻底消失
    // （实测首版就是这样，看起来像按钮根本没有提示）
    setupRing: 'rgba(15, 118, 110, 0.5)',
  },
} as const;

/** 按钮直径（px）：与参考图的圆形直径一致 */
const BUTTON_SIZE = 34;

/** 波形条：宽度 / 静音高度 / 满电平高度 / 圆角 */
const BAR_WIDTH = 2.5;
const BAR_MIN_HEIGHT = 4;
const BAR_MAX_HEIGHT = 15;

export interface VoiceInputButtonProps {
  phase: 'idle' | 'acquiring' | 'recording' | 'transcribing';
  seconds: number;
  level: number;
  bands: number[];
  supported: boolean;
  /** 转录配置是否就绪 */
  ready: boolean;
  onToggle: () => void;
  /** 未配置时点击「去设置」 */
  onConfigure: () => void;
}

/** 录音态：5 根波形条 + 两层扩散环 */
function RecordingGlyph({ bands, level }: { bands: number[]; level: number }) {
  const theme = useTheme();
  const tone = RECORDING_TONE[theme.palette.mode];
  const spread = 2 + Math.min(1, level) * 6;

  return (
    <Box
      sx={{
        position: 'relative',
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        "@keyframes voiceRingOut": {
          // 从 0 不透明度起步：静止时环**完全不可见**，只在扩散途中出现。
          // 若初值给 0.55，截图或暂停帧里会留下一条硬描边，看起来像
          // 「按钮有边框」而不是「声音在扩散」——这是首版实测出来的偏差。
          "0%": { transform: "scale(0.8)", opacity: 0 },
          "35%": { opacity: 0.5 },
          "100%": { transform: "scale(1.6)", opacity: 0 },
        },
        "@media (prefers-reduced-motion: reduce)": {
          // 关动效时保留一圈静态柔环，否则录音态只剩白底，看不出「正在录」
          "& .voice-ring": { animation: "none !important", opacity: 0.32 },
        },
      }}
    >
      {[0, 1].map((i) => (
        <Box
          key={i}
          className="voice-ring"
          aria-hidden
          sx={{
            position: "absolute",
            // -4px：实测与参考图光晕半径最接近的落点
            inset: -4,
            borderRadius: "50%",
            border: `1px solid ${alpha(tone.accent, 0.6)}`,
            pointerEvents: "none",
            // 两环错开半个周期，视觉上是连续的「一圈接一圈」
            animation: `voiceRingOut 1.7s ease-out ${i * 0.85}s infinite`,
            // 电平参与：说话越大，环扩得越远
            transform: `scale(${1 + spread / 100})`,
            willChange: "transform, opacity",
          }}
        />
      ))}

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: `${BAR_WIDTH * 0.9}px`,
          height: "100%",
        }}
      >
        {Array.from({ length: VOICE_BAR_SHAPE.length }, (_, i) => {
          const shape = VOICE_BAR_SHAPE[i];
          const raw = bands[i] ?? 0;
          // 静音时保留形状轮廓：形状权重 × 基础高度，让人看得出「这是波形」
          const height = barHeight(raw, BAR_MIN_HEIGHT, BAR_MAX_HEIGHT) * shape;
          return (
            <Box
              key={i}
              aria-hidden
              sx={{
                width: BAR_WIDTH,
                height: Math.max(BAR_MIN_HEIGHT * 0.6, height),
                borderRadius: BAR_WIDTH,
                bgcolor: tone.accent,
                // 只过渡 height：transform 会给每根条叠一层合成层，5 根不划算
                transition: "height 80ms linear",
              }}
            />
          );
        })}
      </Box>
    </Box>
  );
}

/** 转写态：三点脉冲（不引入 spinner，与产品内其他等待态一致） */
function TranscribingGlyph() {
  return (
    <Box
      sx={{
        display: "flex",
        gap: "3px",
        alignItems: "center",
        justifyContent: "center",
        "@keyframes voiceDot": {
          "0%, 100%": { opacity: 0.25, transform: "translateY(0)" },
          "50%": { opacity: 1, transform: "translateY(-2px)" },
        },
        "@media (prefers-reduced-motion: reduce)": {
          "& .voice-dot": { animation: "none !important", opacity: 0.7 },
        },
      }}
    >
      {[0, 1, 2].map((i) => (
        <Box
          key={i}
          className="voice-dot"
          aria-hidden
          sx={{
            width: 3,
            height: 3,
            borderRadius: "50%",
            bgcolor: "text.secondary",
            animation: `voiceDot 1s ease-in-out ${i * 0.18}s infinite`,
          }}
        />
      ))}
    </Box>
  );
}

function VoiceInputButtonInner({
  phase,
  seconds,
  level,
  bands,
  supported,
  ready,
  onToggle,
  onConfigure,
}: VoiceInputButtonProps) {
  const theme = useTheme();
  const tone = RECORDING_TONE[theme.palette.mode];
  const recording = phase === "recording";
  const transcribing = phase === "transcribing";
  const acquiring = phase === "acquiring";
  const needsSetup = supported && !ready;

  // 不可用：环境不支持 / 未配置。两种情况文案不同——
  // 「不支持」要解释原因（没有补救动作），「未配置」要给下一步动作。
  const title = !supported
    ? "当前环境不支持录音（需要麦克风权限）"
    : needsSetup
      ? "未配置语音输入，点击去设置"
      : recording
        ? "点击结束并转写（Ctrl+D）"
        : transcribing
          ? "正在转写…"
          : acquiring
            ? "正在申请麦克风…"
            : "语音输入（Ctrl+D，或长按 Alt）";

  const handleClick = () => {
    if (!supported) return;
    if (needsSetup) {
      onConfigure();
      return;
    }
    onToggle();
  };

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
      {/* 计时：只在录音态出现，等宽数字避免每秒跳动时布局抖动 */}
      {recording && (
        <Typography
          sx={{
            fontSize: 12,
            color: "text.secondary",
            fontVariantNumeric: "tabular-nums",
            userSelect: "none",
          }}
        >
          {formatDuration(seconds)}
        </Typography>
      )}

      <Tooltip title={title} placement="top">
        {/* disabled 按钮不派发鼠标事件，Tooltip 需要包一层 span 才能生效 */}
        <span style={{ display: "inline-flex" }}>
          <IconButton
            size="small"
            onClick={handleClick}
            disabled={transcribing || acquiring || !supported}
            aria-label={title}
            aria-pressed={recording}
            sx={{
              width: BUTTON_SIZE,
              height: BUTTON_SIZE,
              // 录音态用实底（深浅主题各一套，见 RECORDING_TONE）；空闲/转写态透明
              bgcolor: recording ? tone.surface : "transparent",
              color: recording ? tone.accent : "text.secondary",
              transition: "background-color 160ms ease, color 160ms ease",
              // 未配置：**保持可点**（点了才跳设置），但用虚线圈出「待配置」。
              // 首版这里与空闲态完全一样，实测下来「看不出需要配什么」——
              // 用户只会以为按钮坏了。虚线边框是成本最低的「这里还差点东西」。
              ...(needsSetup
                ? {
                    outline: `1px dashed ${tone.setupRing}`,
                    outlineOffset: 1,
                    borderRadius: "50%",
                  }
                : {}),
              "&:hover": {
                bgcolor: recording ? tone.surface : "action.hover",
                color: recording ? tone.accent : "text.primary",
              },
              "&.Mui-disabled": {
                color: "text.disabled",
                bgcolor: "transparent",
                outline: "none",
              },
            }}
          >
            {recording ? (
              <RecordingGlyph bands={bands} level={level} />
            ) : transcribing ? (
              <TranscribingGlyph />
            ) : (
              <KeyboardVoiceIcon sx={{ fontSize: 18 }} />
            )}
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}

/**
 * memo：录音时父组件（Composer）会因 `bands` 每秒重渲染 15 次，
 * 但工具栏里其他几十个元素与本组件无关。memo 只挡住 props 未变的场景，
 * `bands` 变化时仍会重渲染——这是必要的（波形要动）。
 */
export const VoiceInputButton = memo(VoiceInputButtonInner);
