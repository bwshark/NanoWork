import { Box, Typography } from "@mui/material";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { summarizeInjectionHits, type InjectionHit } from "@/lib/promptInjection";

/**
 * 提示词注入提示（FR-8.6 ③）——**只提示，不拦发送**。
 *
 * 刻意不做成 Dialog / 不弹 toast：
 * - 弹窗会打断输入，而这类提示的正确时机是「用户正在看这句话」；
 * - toast 会消失，用户切回来时不知道该防什么。
 *
 * 所以做成输入框上方的一行常驻提示：文本一变就重算，命中消失即自动消失。
 */
export function InjectionNotice({ hits }: { hits: readonly InjectionHit[] }) {
  if (hits.length === 0) return null;
  const first = hits[0];
  return (
    <Box
      data-testid="injection-notice"
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: 0.75,
        px: 1.75,
        pt: 1,
        color: "warning.main",
      }}
    >
      <WarningAmberIcon sx={{ fontSize: 16, mt: "1px", flexShrink: 0 }} />
      <Typography
        variant="caption"
        sx={{ color: "warning.main", lineHeight: 1.45 }}
      >
        {summarizeInjectionHits(hits)}
        {first?.excerpt ? `（${first.excerpt}）` : ""}
      </Typography>
    </Box>
  );
}
