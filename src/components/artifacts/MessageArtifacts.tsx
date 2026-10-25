import { useMemo } from 'react';
import { Box, Button } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { FileArtifactCard } from './FileArtifactCard';
import { useArtifactActions } from './useArtifactActions';
import { changeCountOf, isFileArtifact, summarizeFiles, toFileViews } from '@/lib/artifact/fileArtifact';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import type { Artifact, Message } from '@/types';

interface MessageArtifactsProps {
  sessionId: string;
  /** 承载产物的那条助手消息 */
  message: Message;
}

/** 同一产物在一条消息里可能被写多次（同 id 多事件）→ 只留最后一次，避免重复卡片 */
function dedupeById(artifacts: Artifact[]): Artifact[] {
  const seen = new Map<string, Artifact>();
  for (const artifact of artifacts) seen.set(artifact.id, artifact);
  return [...seen.values()];
}

/**
 * 消息底部的**文件产物区**（对齐参考稿：两列卡片 + 「查看所有产物 / 变更」入口）。
 *
 * ## 为什么只放文件产物
 *
 * 围栏提取的富产物（代码 / Mermaid / HTML）是「回复内容的一部分」，本来就以内联
 * 形式排在正文之后——再收进卡片反而要多点一次才看得到。而工具写出的**文件**
 * 在正文里只是一句「已写入 D:\aa\tetris.html」，用户需要的是可点的产物入口。
 *
 * ## 计数的口径
 *
 * 卡片只列**本条消息**产出的文件；两个入口的计数是**会话级**总数（「查看所有」
 * 的语义就是跳出去看全部），因此面板打开后看到的一定不少于卡片里这几张。
 */
export function MessageArtifacts({ sessionId, message }: MessageArtifactsProps) {
  const index = useArtifactsStore((s) => s.index);
  const sessionArtifacts = useArtifactsStore((s) => s.bySession[sessionId]);
  const panelOpen = useSessionUiStore((s) => s.artifactPanelOpen);
  const panelSessionId = useSessionUiStore((s) => s.artifactPanelSessionId);
  // 卡片高亮跟随**当前激活的标签**：打开多个产物时，只有正被查看的那张卡片点亮
  const activeTabId = useSessionUiStore((s) => s.artifactPanelActiveTabId);
  const actions = useArtifactActions(sessionId);

  const files = useMemo(
    () => dedupeById((message.artifacts ?? []).filter(isFileArtifact)),
    [message.artifacts],
  );
  const summary = useMemo(
    () => summarizeFiles(toFileViews(sessionArtifacts ?? [], index)),
    [sessionArtifacts, index],
  );

  if (files.length === 0) return null;

  const previewing = panelOpen && panelSessionId === sessionId;
  const openPanel = (view: 'all' | 'changes') =>
    useSessionUiStore.getState().openArtifactPanel(sessionId, { view });

  return (
    <Box sx={{ width: '100%', mt: 0.5 }}>
      <Box
        sx={{
          display: 'grid',
          // 窄窗口单列、常规两列（参考稿是两列；极窄时挤成两列会截断文件名）
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 1,
        }}
      >
        {files.map((artifact) => (
          <FileArtifactCard
            key={artifact.id}
            artifact={artifact}
            changes={changeCountOf(index[artifact.id])}
            actions={actions}
            selected={previewing && activeTabId === artifact.id}
          />
        ))}
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 0.75 }}>
        <FooterEntry
          label={`查看所有产物 (${summary.fileCount})`}
          onClick={() => openPanel('all')}
        />
        {summary.changedFileCount > 0 && (
          <FooterEntry
            label={`查看所有变更 (${summary.changedFileCount})`}
            onClick={() => openPanel('changes')}
          />
        )}
      </Box>
    </Box>
  );
}

/** 底部入口：小字 + 右箭头（对齐参考稿的「查看所有产物 (9) ›」） */
function FooterEntry({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      size="small"
      onClick={onClick}
      endIcon={<ChevronRightIcon sx={{ fontSize: 14 }} />}
      sx={{
        textTransform: 'none',
        fontSize: 12.5,
        color: 'text.secondary',
        px: 0.5,
        minWidth: 0,
        '& .MuiButton-endIcon': { ml: 0.25 },
        '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
      }}
    >
      {label}
    </Button>
  );
}