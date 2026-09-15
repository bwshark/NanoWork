import { useState } from 'react';
import { Box, Button, IconButton, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';
import { ConfirmDialog } from '@/components/ConfirmDialog';

/** 左侧多 Agent 会话列表面板 */
export function SessionListPanel() {
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const createSession = useSessionsStore((s) => s.createSession);
  const selectSession = useSessionsStore((s) => s.selectSession);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const agents = useAgentsStore((s) => s.agents);
  const groups = useExpertGroupsStore((s) => s.groups);

  const [toDelete, setToDelete] = useState<string | null>(null);

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? '未知 Agent';

  /** 会话副标题：绑定专家团时显示团名，否则回退执行 Agent 名 */
  const boundName = (s: (typeof sessions)[number]) =>
    (s.groupId && groups.find((g) => g.id === s.groupId)?.name) ||
    agentName(s.agentId);

  return (
    <Box
      sx={{
        width: 264,
        flexShrink: 0,
        borderRight: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      <Box sx={{ p: 1.5 }}>
        <Button fullWidth variant="contained" startIcon={<AddIcon />} onClick={() => createSession()}>
          新会话
        </Button>
      </Box>
      <Box sx={{ flex: 1, overflow: 'auto' }}>
        {sessions.length === 0 && (
          <Box sx={{ p: 2, color: 'text.secondary', fontSize: 13 }}>
            还没有会话，点击「新会话」开始。
          </Box>
        )}
        {sessions.map((s) => (
          <Box
            key={s.id}
            onClick={() => selectSession(s.id)}
            sx={{
              px: 1.5,
              py: 1,
              cursor: 'pointer',
              borderLeft: activeId === s.id ? '3px solid' : '3px solid transparent',
              borderColor: 'primary.main',
              bgcolor: activeId === s.id ? 'action.selected' : 'transparent',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography noWrap sx={{ fontSize: 14, fontWeight: 500, flex: 1 }}>
                {s.title}
              </Typography>
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  setToDelete(s.id);
                }}
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Box>
            <Typography noWrap sx={{ fontSize: 12, color: 'text.secondary' }}>
              {boundName(s)} · {s.messages.length} 条
            </Typography>
          </Box>
        ))}
      </Box>

      <ConfirmDialog
        open={!!toDelete}
        title="删除会话"
        message="确认删除该会话？此操作不可撤销。"
        danger
        confirmText="删除"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) deleteSession(toDelete);
          setToDelete(null);
        }}
      />
    </Box>
  );
}
