import type { Message, TaskConfig } from '@/types';
import { inferScheduleFromText } from '@/lib/scheduleFromText';

/** 表单提交数据：去掉 store 自管的 id / createdAt */
export type TaskDraft = Omit<TaskConfig, 'id' | 'createdAt'>;

/**
 * 由消息内容生成任务名：取首行 trim，超 20 字截断并补 '…'。
 * 空串回退 '新任务'（PRD Q5）。
 */
export function makeTaskName(content: string): string {
  const firstLine = (content.split('\n')[0] ?? '').trim();
  if (!firstLine) return '新任务';
  if (firstLine.length > 20) return firstLine.slice(0, 20) + '…';
  return firstLine;
}

/** 由一条消息预填任务草稿；agentId 优先用 session.agentId */
export function buildTaskDraftFromMessage(
  message: Message,
  agentId: string,
): Partial<TaskConfig> {
  // 执行频率从正文里推断（FR-5.5 补）。识别不出来就**不填** `schedule`，让表单用它
  // 自己的默认值 —— 「不猜」的纪律见 `scheduleFromText.ts` 的文件头。
  const hint = inferScheduleFromText(message.content);
  return {
    name: makeTaskName(message.content),
    prompt: message.content,
    agentId,
    ...(hint ? { schedule: hint.schedule } : {}),
  };
}
