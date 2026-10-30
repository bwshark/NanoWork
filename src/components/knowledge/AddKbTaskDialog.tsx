/**
 * 知识库页右上角的「添加任务」：给这个库挂一条定时任务。
 *
 * ## 为什么复用 `TaskFormDialog` 而不是自建一个小表单
 *
 * 定时任务的表单有 4 类互相独立的校验（名称 / 间隔 / 日期 / cron / 生效区间）和一套
 * 「UI 频率 ↔ 引擎调度」的双向转换。第二份实现必然从某一侧先腐坏，然后同一个用户
 * 在两个入口看到不兼容的选项（比如这里能选「工作日」、任务页不能）。所以这里只做
 * **预填与落库**，不碰表单本身。
 *
 * ## 预填的边界
 *
 * 只预填「名字 + 提示词 + 执行者」三样，**不预填调度**：从库里点「添加任务」这件事
 * 本身不含任何时间信息，猜一个「每天 09:00」会让用户以为是他自己定的。
 */
import { useAgentsStore } from "@/stores/agentsStore";
import { useTasksStore } from "@/stores/tasksStore";
import { toast } from "@/components/Toast";
import { TaskFormDialog } from "@/components/tasks/TaskFormDialog";
import type { TaskDraft } from "@/lib/task/taskDraft";
import type { TaskConfig } from "@/types";

/**
 * 由库名生成预填草稿。
 *
 * 提示词写成「整理」而不是「总结」：定时任务的价值在于**周期性维护**（发现重复、
 * 过期、互相矛盾），而总结一次只需要点开文档看。
 */
export function buildKbTaskDraft(kbName: string, agentId: string): Partial<TaskConfig> {
  const name = `整理「${kbName}」`;
  return {
    name: name.length > 20 ? `${name.slice(0, 20)}…` : name,
    prompt: [
      `请整理我的知识库「${kbName}」：`,
      '1. 找出重复、过期或互相矛盾的资料，列出建议合并与删除的篇目；',
      '2. 指出库里明显缺失的部分；',
      '3. 给出接下来最值得补充的 3 个方向。',
    ].join('\n'),
    agentId,
  };
}

export interface AddKbTaskDialogProps {
  open: boolean;
  /** 任务挂在哪本库上（只用于预填文案） */
  kbName: string;
  onClose: () => void;
}

export function AddKbTaskDialog({ open, kbName, onClose }: AddKbTaskDialogProps) {
  const agents = useAgentsStore((s) => s.agents);
  const addTask = useTasksStore((s) => s.addTask);

  const initial = buildKbTaskDraft(kbName, agents[0]?.id ?? '');

  const onSubmit = (draft: TaskDraft) => {
    addTask(draft);
    toast.success('已创建定时任务');
    onClose();
  };

  return (
    <TaskFormDialog
      open={open}
      title={`添加任务 · ${kbName}`}
      submitLabel="创建任务"
      initial={initial}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
