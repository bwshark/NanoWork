/**
 * 项目共享记忆（FR-12.7 ③）的客户端纯逻辑：归一 / 校验 / 拼提示词段。
 *
 * ## 它和「记忆」不是一层东西
 *
 * 个人记忆（`MemoryService`）在**本机**，跟着人走；项目共享记忆在**云端**，跟着项目走。
 * 所以这里没有存储、没有缓存、没有同步：读一次、注入一次，云端就是唯一真相。
 * 也**不要**往 `syncRegistry` 里塞一个副本 —— 两份真相迟早对不上，而这份记忆的全部
 * 价值恰恰是「所有人看到的是同一份」。
 *
 * ## 三条刻意的不做
 *
 * 1. **不改写正文**：不清缩进、不改列表符号、不逐行 trim。用户写的是 Markdown，
 *    缩进在代码块里是语义（`selectionRewrite` 那一轮踩过 `trim()` 抹平缩进的坑）。
 *    这里只做两件无损的事：CRLF → LF、去 BOM。
 * 2. **不在客户端定字符上限**：上限由服务端下发（`maxChars`，见 `cloud/app/projects/routes.py`
 *    的 `PROJECT_MEMORY_MAX_CHARS`）。两处各写一个常量，迟早出现「前端说能存、服务端 400」。
 * 3. **空正文不注入任何段**：不塞「本项目暂无共享记忆」这种占位句。那会让模型以为
 *    「查过了，确实没有」，于是该追问时也不追问（与 `knowledge` 段同一条纪律）。
 */

import {
  PROJECT_MEMORY_TAG_CLOSE,
  PROJECT_MEMORY_TAG_OPEN,
} from '@/lib/core/constants';

/** CRLF → LF、去 BOM。**只做无损变换**，正文一个字符都不改（见文件头第 1 条）。 */
export function normalizeProjectMemoryText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

export interface ProjectMemoryValidation {
  ok: boolean;
  /** 不通过时给用户看的一句话；通过时为空串 */
  message: string;
}

/**
 * 保存前校验。**空正文是合法的**（清空共享记忆是一个真实动作），只有超长才拦。
 *
 * 超长必须报错而不是截断：截断是静默丢内容，用户看到的是「保存成功」，
 * 下次打开才发现少了一段。服务端也是同一条口径（400，不是切一刀）。
 */
export function validateProjectMemoryText(
  text: string,
  maxChars: number,
): ProjectMemoryValidation {
  if (maxChars > 0 && text.length > maxChars) {
    return {
      ok: false,
      message: `共享记忆不能超过 ${maxChars.toLocaleString('zh-CN')} 字符（当前 ${text.length.toLocaleString('zh-CN')}）`,
    };
  }
  return { ok: true, message: '' };
}

/**
 * 把共享记忆渲染成提示词段（含 `<project_memory>` 标签）。
 *
 * 正文为空返回空串 —— 装配器会整段跳过（见文件头第 3 条）。
 *
 * 段里的两行边界指令各管一件事：
 * - **团队约定优先于模型自己的假设**，否则模型会顺手用「通常的做法」压掉团队已经
 *   定过的事（例如「本项目一律用 pnpm」）。
 * - **用户本轮最新说法优先于本段**，并要提醒更新。共享记忆是快照，不会自动跟着
 *   对话演进；不写这一条，模型会把三个月前那段当成不可推翻的宪法。
 */
export function buildProjectMemorySection(input: {
  text: string;
  /** 项目名，仅用于让模型知道「这是哪个项目的约定」 */
  projectName?: string;
}): string {
  const body = input.text.trim();
  if (body === '') return '';

  const name = (input.projectName ?? '').trim();
  const header =
    name === ''
      ? '以下是本项目（团队共享）的记忆，由项目负责人维护：'
      : `以下是「${name}」项目的共享记忆，由项目负责人维护：`;

  return [
    PROJECT_MEMORY_TAG_OPEN,
    header,
    '- 它是团队已经认可的背景与约定，与模型自己的通常假设冲突时以它为准。',
    '- 它是快照，可能过时：与用户在本轮的说法冲突时，以用户最新说法为准，并提醒他更新共享记忆。',
    '',
    body,
    PROJECT_MEMORY_TAG_CLOSE,
  ].join('\n');
}

/**
 * 「最后更新」一行的文案。空串 = 从未写过（与「写过但清空了」是两句话，界面文案不同）。
 *
 * 时间解析失败时原样回 ISO 串，不吞成「—」：吞掉会让「云端时间格式变了」这件事
 * 完全看不出来（界面上一片正常，只是永远显示「尚未填写」）。
 */
export function formatProjectMemoryUpdated(updatedAt: string, updatedBy: string): string {
  const iso = updatedAt.trim();
  if (iso === '') return '尚未填写';
  const at = new Date(iso);
  const when = Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString('zh-CN', { hour12: false });
  const who = updatedBy.trim();
  return who === '' ? `${when} 更新` : `${when} · ${who} 更新`;
}
