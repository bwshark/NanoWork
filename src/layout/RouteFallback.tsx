import { Box, CircularProgress, Typography } from "@mui/material";

/**
 * 路由懒加载的可见 fallback（FR-13.5）。
 *
 * 存在的唯一理由是**白屏**：`Suspense` 不给 fallback 时，懒加载页在 chunk 到达前
 * 什么都不画 —— 用户看到一片空白的正文区，而「空白」与「应用卡死了」在观感上
 * 无法区分。
 *
 * 三条约束（都来自踩过的那类坑）：
 *
 * 1. **必须立刻画得出东西**，所以只依赖 MUI —— 它是 `modulepreload` 里的静态
 *    chunk，进入这个组件时**已经在内存里**。若这里去 import 任何懒加载模块，
 *    就等于「fallback 也要等 chunk」，那与没有 fallback 是同一种体验。
 * 2. **不能自己渲染成整屏**：它挂在内容区里（`AppLayout` 的 `<Outlet />` 外），
 *    所以侧栏与标题栏在切页期间**保持可见、不重建** —— 那是这个边界放在布局层
 *    而不是路由层的原因。
 * 3. **不做延迟出现**。曾经的考虑是「本地 chunk 毫秒级就绪，转圈会闪一下」，
 *    但本项目自己的纪律是**先有数据再优化**（见 B4-01 已铺好的启动剖析）：真机
 *    逐页访问的耗时由 `tasks/verify-b5-first-paint.mjs` 量，再决定要不要加
 *    「延迟 200ms 才显示」。在没有实测之前引入一个定时器，只是把需求里明确要求的
 *    「fallback 可见」变成不可见。
 */
export function RouteFallback({ label = "正在打开…" }: { label?: string }) {
  return (
    <Box
      // `role="status"` + `aria-live`：转圈是纯视觉的，读屏用户需要一句话
      role="status"
      aria-live="polite"
      sx={{
        display: "flex",
        flex: 1,
        minHeight: 200,
        alignItems: "center",
        justifyContent: "center",
        gap: 1.5,
      }}
    >
      <CircularProgress size={18} />
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}
