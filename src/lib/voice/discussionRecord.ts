/**
 * 语音讨论纪要的文本形态（纯函数，便于单测与「视图 ≡ 落盘」的一致性）。
 *
 * ## 为什么落成一条普通助手消息而不是新消息类型
 * 新增 `Message.voiceSummary` 要同时改：类型、事件投影（`events/project.ts`）、
 * 渲染（`AssistantMessage`）、以及等价性测试的「实时视图 ≡ 重放投影」判据。
 * 代价是四处同步，收益只是一张更好看的卡片——而纪要本身就是**文字**，
 * Markdown 已经能表达（标题 / 粗体 / 列表），渲染器不用为它加分支。
 *
 * ## 为什么截断
 * 一场 30 分钟的讨论能到几万字。整段塞进消息会让会话列表、搜索、上下文
 * 组装全部变慢；纪要的价值在结论，记录留最近若干轮足够回溯。
 */

/** 纪要里保留的最大轮数（取最近的，早期的结论已经进了摘要） */
const MAX_RECORDED_TURNS = 16;

/** 单条发言保留的最大字符数 */
const MAX_UTTERANCE_CHARS = 180;

/** 时长格式化 mm:ss（与面板计时同口径） */
export function formatRecordDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export interface DiscussionRecordInput {
  durationMs: number;
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** 模型摘要；空串时用本地兜底 */
  summary: string;
}

/**
 * 生成纪要正文。
 *
 * 摘要为空（模型调用失败 / 超时）时用「轮次 + 第一句用户发言」兜底：
 * 宁可给一句朴素的话，也不要落一条只有标题的空消息。
 */
export function buildDiscussionRecord(input: DiscussionRecordInput): string {
  const { durationMs, turns } = input;
  const spoken = turns.filter((t) => t.text.trim() !== '');
  const rounds = spoken.filter((t) => t.role === 'user').length;
  const summary =
    input.summary.trim() ||
    (spoken.length > 0
      ? `本次共 ${rounds} 轮发言，内容见下方记录。`
      : '本次讨论没有产生内容。');

  const lines: string[] = [];
  lines.push(`**语音讨论纪要** · ${formatRecordDuration(durationMs)} · ${rounds} 轮`);
  lines.push('');
  lines.push('**讨论内容**');
  lines.push(summary);
  lines.push('');

  const kept = spoken.slice(-MAX_RECORDED_TURNS);
  if (kept.length > 0) {
    const omitted = spoken.length - kept.length;
    lines.push('**讨论记录**');
    if (omitted > 0) lines.push(`（更早的 ${omitted} 条已省略）`);
    for (const turn of kept) {
      const who = turn.role === 'user' ? '你' : '助手';
      lines.push(`- **${who}**：${clip(turn.text, MAX_UTTERANCE_CHARS)}`);
    }
  }

  return lines.join('\n');
}
