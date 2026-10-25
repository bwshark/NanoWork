import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import type { KbSummary } from "@/lib/kb/kbClient";
import { KbEmpty } from "@/components/knowledge/kbAtoms";

/**
 * 团队视图：这个团队下的知识库，卡片网格 + 一张「新建知识库」虚线卡片。
 *
 * ## 为什么卡片上不放文档预览
 *
 * 参考界面在卡片里列了几篇文档名，但那要求「每个库都拉一次文档列表」——
 * 一进团队就发 N 个请求，而卡片上多出来的那几行标题对「我要进哪个库」几乎
 * 没有帮助（真正的线索是库名和范围）。所以这里放的是**元信息**：
 * 多少篇、谁可见、有没有按部门收窄。
 */
export interface KnowledgeTeamPanelProps {
  kbs: readonly KbSummary[];
  loading: boolean;
  error: string;
  /** 库的可见范围人话（`N 篇 · 成员可见 · 仅 技术部`），由页面统一算 */
  describe: (kb: KbSummary) => string;
  onOpenKb: (kbId: string) => void;
  onCreateKb: () => void;
}

export function KnowledgeTeamPanel({
  kbs,
  loading,
  error,
  describe,
  onOpenKb,
  onCreateKb,
}: KnowledgeTeamPanelProps) {
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2.5, py: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>团队知识库</Typography>
        <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{kbs.length} 个</Typography>
      </Stack>

      {error !== "" && (
        <Typography sx={{ fontSize: 12.5, color: "error.main", mb: 1.5 }}>{error}</Typography>
      )}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(248px, 1fr))",
          gap: 1.5,
        }}
      >
        {kbs.map((kb) => (
          <Paper
            key={kb.id}
            variant="outlined"
            data-testid={`kb-card-${kb.id}`}
            onClick={() => onOpenKb(kb.id)}
            sx={{
              p: 1.75,
              borderRadius: 2,
              cursor: "pointer",
              transition: "border-color .12s, background-color .12s",
              "&:hover": { borderColor: "text.secondary", bgcolor: "action.hover" },
            }}
          >
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
              <MenuBookOutlinedIcon sx={{ fontSize: 18, color: "info.main" }} />
              <Typography
                sx={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {kb.name}
              </Typography>
            </Stack>
            <Typography sx={{ fontSize: 11.5, color: "text.secondary", lineHeight: 1.7 }}>
              {describe(kb)}
            </Typography>
            {kb.description.trim() !== "" && (
              <Typography
                sx={{
                  mt: 0.75,
                  fontSize: 11.5,
                  color: "text.secondary",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {kb.description}
              </Typography>
            )}
          </Paper>
        ))}

        <Button
          variant="outlined"
          data-testid="kb-card-create"
          onClick={onCreateKb}
          startIcon={<AddIcon />}
          sx={{
            borderRadius: 2,
            minHeight: 92,
            borderStyle: "dashed",
            color: "text.secondary",
            borderColor: "divider",
            "&:hover": { borderColor: "text.secondary", color: "text.primary" },
          }}
        >
          新建知识库
        </Button>
      </Box>

      {!loading && kbs.length === 0 && error === "" && (
        <KbEmpty>这个团队下还没有你能看到的知识库。点「新建知识库」建一个。</KbEmpty>
      )}
    </Box>
  );
}
