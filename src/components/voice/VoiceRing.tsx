/**
 * 语音讨论的「点阵环」：一圈细点，随说话的音量轻轻起伏。
 *
 * ## 为什么用 canvas 而不是 N 个 DOM 节点
 * 参考视频里是 ~110 颗点。用 `<span>` 画就是 110 个合成层 + 110 次
 * style 写入/帧——在 4K 屏上会明显拖慢输入区打字（首版用 box-shadow 做扩散环
 * 已经踩过一次同样的坑，见 `VoiceInputButton` 文件头）。canvas 一次
 * `clearRect` + 110 次 `arc` 是微秒级，且只占一个合成层。
 *
 * ## 为什么电平不进 React 渲染
 * 电平 15fps 变化，若作为依赖去跑 effect，会让整块面板每 66ms 重渲染。
 * 这里把 `level` 写进 ref，`requestAnimationFrame` 内部自己插值——
 * 渲染次数与音频帧率解耦（与 `levels.ts` 的平滑策略同一个思路）。
 *
 * ## 三条视觉约束
 * 1. **点的大小必须有天然差异**：等大等亮的点阵看起来像加载指示器，
 *    不像「声音的形状」。每颗点由固定随机种子给出基础半径。
 * 2. **旋转必须极慢**（~0.05 rad/s）：快了像转盘，静态看也要稳。
 * 3. **`prefers-reduced-motion` 下停转但仍随音量变化**：完全不动的环会让
 *    用户以为麦克风没在工作（这是唯一保留的动态反馈）。
 */

import { useEffect, useRef } from "react";
import { useTheme } from "@mui/material/styles";

/** 点的数量：与参考图目测一致（约 110 颗） */
const DOT_COUNT = 110;

/** 基础旋转速度（弧度/秒） */
const SPIN = 0.05;

export interface VoiceRingProps {
  /** 0~1 实时电平 */
  level: number;
  /** 是否在听（静音时环变暗，但仍显示形状） */
  active: boolean;
  /** 画布边长（px） */
  size?: number;
}

/** 固定种子的伪随机：同一颗点每帧的大小必须一致，否则整圈会「沸腾」 */
function seedAt(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function VoiceRing({ level, active, size = 260 }: VoiceRingProps) {
  const theme = useTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(level);
  levelRef.current = level;
  const activeRef = useRef(active);
  activeRef.current = active;
  const colorRef = useRef(theme.palette.mode === "dark" ? "230, 232, 235" : "31, 36, 48");
  colorRef.current = theme.palette.mode === "dark" ? "230, 232, 235" : "31, 36, 48";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const center = size / 2;
    const baseRadius = size * 0.34;
    /** 平滑后的电平：直接用电平会让整圈每帧抖动 */
    let smooth = 0;
    let raf = 0;
    const startedAt = performance.now();

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const target = activeRef.current ? Math.min(1, levelRef.current) : 0;
      // 起音快、落音慢：和波形条同一套手感
      smooth += (target - smooth) * (target > smooth ? 0.35 : 0.08);

      const t = reduceMotion ? 0 : (now - startedAt) / 1000;
      const rgb = colorRef.current;
      // 音量让整圈轻微外扩（3% 足够：再多就像呼吸灯了）
      const radius = baseRadius * (1 + smooth * 0.035);

      ctx.clearRect(0, 0, size, size);
      for (let i = 0; i < DOT_COUNT; i += 1) {
        const seed = seedAt(i);
        const angle = (i / DOT_COUNT) * Math.PI * 2 + t * SPIN;
        // 亮度沿圆周有两处「波峰」，转动时像一个缓慢扫过的光带
        const wave = Math.sin(angle * 3 - t * 1.1) * 0.5 + 0.5;
        const grain = 0.55 + seed * 0.45;
        const alpha = activeRef.current
          ? 0.1 + (0.32 + wave * 0.5) * grain * (0.55 + smooth * 0.75)
          : 0.16 * grain;
        const dot =
          (0.9 + seed * 1.1) * (1 + smooth * 0.5) * (0.85 + wave * 0.35);
        const r = radius + (seed - 0.5) * 9 * (1 + smooth * 0.4);
        const x = center + Math.cos(angle) * r;
        const y = center + Math.sin(angle) * r;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.4, dot), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb}, ${Math.min(0.95, alpha).toFixed(3)})`;
        ctx.fill();
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ width: size, height: size, display: "block" }}
    />
  );
}
