import { useAgentsStore } from '@/stores/agentsStore';
import { useTasksStore } from '@/stores/tasksStore';
import { toast } from '@/components/Toast';
import { TaskFormDialog } from '@/components/tasks/TaskFormDialog';
import { buildTaskDraftFromMessage } from '@/lib/task/taskDraft';
import { inferScheduleFromText } from '@/lib/task/scheduleFromText';
import type { Message } from '@/types';
import type { TaskDraft } from '@/lib/task/taskDraft';

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

  /*
   * 把「执行频率是从正文里认出来的」这件事说出来（FR-5.5 补）。
   *
   * 与 `initial.schedule` 出自**同一个纯函数**：同输入必同输出，所以不存在
   * 「提示说每周一、实际填的是每天」这种不一致。显示它的意义是让用户知道
   * 那几个控件为什么**已经**填好了 —— 不然「打开就是填好的」会像是上次的残留。
   */
  const scheduleHint = inferScheduleFromText(message.content)?.description ?? null;

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
      scheduleHint={scheduleHint}
      initial={initial}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
