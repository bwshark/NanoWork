/**
 * 个人知识库的头像（参考界面里那只熊猫）。
 *
 * 为什么是手写的 SVG 而不是一张图片：它出现在标题栏这一处，尺寸只有 40 出头，
 * 引入一个 png 会让「深色主题下要换一张」「高分屏要一张 2x」都变成资源问题；
 * SVG 只跟 `currentColor` 和一个背景色有关，两套主题共用一份。
 *
 * 画法上刻意只用**圆形与椭圆**：熊猫的可辨识度几乎全在「黑耳 + 黑眼圈 + 白脸」
 * 这三块面积比上，加鼻子下面的复杂线条在 40px 上只会糊成一团。
 */
import { Box } from "@mui/material";

export function PersonalKbAvatar({ size = 40 }: { size?: number }) {
  return (
    <Box
      aria-hidden
      data-testid="kb-personal-avatar"
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: `${Math.round(size * 0.28)}px`,
        // 粉底是头像的一部分（熊猫的白色在深色主题下会和背景糊在一起）
        background: "linear-gradient(160deg, #ffdbe4 0%, #ffc4d6 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <svg viewBox="0 0 48 48" width={size} height={size} role="presentation">
        {/* 耳朵：先画，让它被脸盖住一部分才有"长在头上"的感觉 */}
        <circle cx="13.5" cy="14" r="7.2" fill="#2b2b33" />
        <circle cx="34.5" cy="14" r="7.2" fill="#2b2b33" />
        {/* 脸 */}
        <ellipse cx="24" cy="26.5" rx="15" ry="13.5" fill="#ffffff" />
        {/* 黑眼圈（外圈）与眼白高光 */}
        <ellipse cx="18.2" cy="25.2" rx="4.3" ry="5" fill="#2b2b33" transform="rotate(-12 18.2 25.2)" />
        <ellipse cx="29.8" cy="25.2" rx="4.3" ry="5" fill="#2b2b33" transform="rotate(12 29.8 25.2)" />
        <circle cx="19.6" cy="23.6" r="1.5" fill="#ffffff" />
        <circle cx="31.2" cy="23.6" r="1.5" fill="#ffffff" />
        {/* 腮红：两团淡粉，给这张脸一点温度 */}
        <ellipse cx="12.6" cy="31" rx="3.1" ry="2.1" fill="#ff9db4" opacity="0.75" />
        <ellipse cx="35.4" cy="31" rx="3.1" ry="2.1" fill="#ff9db4" opacity="0.75" />
        {/* 鼻子 + 嘴 */}
        <ellipse cx="24" cy="31.4" rx="2.1" ry="1.5" fill="#2b2b33" />
        <path
          d="M24 33.2c0 1.5-1.5 2.6-3 2.6M24 33.2c0 1.5 1.5 2.6 3 2.6"
          stroke="#2b2b33"
          strokeWidth="1.2"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </Box>
  );
}
