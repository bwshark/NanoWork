import { useAgentsStore } from '@/stores/agentsStore';
import { useTasksStore } from '@/stores/tasksStore';
import { toast } from '@/components/Toast';
import { TaskFormDialog } from '@/components/tasks/TaskFormDialog';
import { buildTaskDraftFromMessage } from '@/lib/taskDraft';
import type { Message } from '@/types';
import type { TaskDraft } from '@/lib/taskDraft';

interface CreateTaskDialogProps {
  open: boolean;
  onClose: () => void;
  message: Message;
  /** 来自 session.agentId；为空时回退 agents[0]?.id */
  agentId: string;
}

/** 聊天入口封装：预填 + addTask + toast 闭环，内部挂载 TaskFormDialog */
export function CreateTaskDialog({ open, onClose, message, agentId }: CreateTaskDialogProps) {
  const agents = useAgentsStore((s) => s.agents);
  const addTask = useTasksStore((s) => s.addTask);

  const initial = buildTaskDraftFromMessage(message, agentId || agents[0]?.id || '');

  const onSubmit = (d: TaskDraft) => {
    addTask(d);
    toast.success('已创建定时任务');
    onClose();
  };

  return (
    <TaskFormDialog
      open={open}
      title="创建定时任务（来自对话）"
      submitLabel="创建任务"
      initial={initial}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
