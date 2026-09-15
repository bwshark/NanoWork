import { Box, Paper, Typography } from '@mui/material';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { ArtifactRenderer } from '@/components/ArtifactRenderer';

/**
 * 产物库页（P2 占位/基础）。
 * 从 artifactsStore 按 session 归档读取富产物并渲染；
 * 真实跨会话检索/归档为 P2（FR-014）后续增强。
 */
export function ArtifactsPage() {
  const bySession = useArtifactsStore((s) => s.bySession);
  const sessions = useSessionsStore((s) => s.sessions);
  const sessionTitle = (id: string) => sessions.find((s) => s.id === id)?.title ?? '未知会话';

  const entries = Object.entries(bySession);

  return (
    <Box sx={{ p: 3, maxWidth: 1000, margin: '0 auto' }}>
      <Typography variant="h5" fontWeight={700} gutterBottom>
        产物库（P2）
      </Typography>
      {entries.length === 0 && (
        <Typography color="text.secondary">
          暂无富产物。在会话中触发工具（搜索 / 抓取 / 画图 / 文件 / 命令）即可生成产物。
        </Typography>
      )}
      {entries.map(([sid, arts]) => (
        <Box key={sid} sx={{ mb: 3 }}>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>
            {sessionTitle(sid)} · {arts.length} 项
          </Typography>
          <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.paper' }}>
            {arts.map((a) => (
              <ArtifactRenderer key={a.id} artifact={a} />
            ))}
          </Paper>
        </Box>
      ))}
    </Box>
  );
}
