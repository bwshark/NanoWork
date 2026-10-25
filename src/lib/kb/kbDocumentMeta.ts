/**
 * 知识库文档的**展示层**（图标语义 + 相对时间），与 `kbUpload.kindLabel` 分工：
 * 那里给中文名（`PDF` / `Word`），这里给「用哪个图标、什么颜色、什么时候更新的」。
 *
 * ## 为什么单独一层
 *
 * 文件列表、知识库卡片预览、检索命中三处都要画同一份文档，而它们各自渲染不出
 * 同一套图标的结果是：同一篇 PDF 在列表里是红色图标、在卡片里是蓝色——用户会
 * 以为那是两份不同的东西。所以「kind → 图标/配色」必须只有一个映射。
 */

import type { KbDocument } from '@/lib/kb/kbClient';

export type KbDocGlyph = 'text' | 'word' | 'pdf' | 'sheet' | 'slides';

export interface KbDocLook {
  glyph: KbDocGlyph;
  /** 图标主色。取的是「一类文件一个颜色」的常识配色，深浅主题下都还能分辨 */
  tint: string;
}

const LOOKS: Record<KbDocGlyph, KbDocLook> = {
  text: { glyph: 'text', tint: '#94a3b8' },
  word: { glyph: 'word', tint: '#60a5fa' },
  pdf: { glyph: 'pdf', tint: '#f87171' },
  sheet: { glyph: 'sheet', tint: '#34d399' },
  slides: { glyph: 'slides', tint: '#fbbf24' },
};

/**
 * 按来源格式取图标。未知格式退回「纯文本」而不是空白：
 * 后端将来加了新格式时，界面上显示一个通用图标也比留一个洞强。
 */
export function docLook(kind: string | undefined): KbDocLook {
  switch ((kind ?? '').toLowerCase()) {
    case 'docx':
    case 'doc':
      return LOOKS.word;
    case 'pdf':
      return LOOKS.pdf;
    case 'xlsx':
    case 'xls':
    case 'csv':
      return LOOKS.sheet;
    case 'pptx':
    case 'ppt':
      return LOOKS.slides;
    default:
      return LOOKS.text;
  }
}

/**
 * 列表里的「更新时间」该读哪个字段。
 *
 * `updatedAt` 为空串 = 这一行在服务端还没有这个字段（老库迁移前的数据），
 * 此时退回 `createdAt`。**不能直接显示空**：空白的更新时间会被读成
 * 「这篇没有时间戳」，而它明明有。
 */
export function docUpdatedAt(doc: KbDocument): string {
  const updated = (doc.updatedAt ?? '').trim();
  return updated !== '' ? updated : doc.createdAt;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 相对时间（`17 小时前` 这种）。
 *
 * 三条判定都是刻意的：
 * 1. **解析不了就给空串**，不编一个时间——脏数据（`'x'`）显示成「刚刚」是纯粹的谎；
 * 2. **未来时间说「刚刚」**：服务端与本机时钟差几秒很常见，显示「−3 分钟前」
 *    会让用户以为时区配错了；
 * 3. 超过 30 天给**绝对日期**：那时「87 天前」已经不如「2026-07-30」有信息量。
 */
export function formatRelativeTime(iso: string | undefined, now: number = Date.now()): string {
  const text = (iso ?? '').trim();
  if (text === '') return '';
  const stamp = Date.parse(text);
  if (!Number.isFinite(stamp)) return '';
  const diff = now - stamp;
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const date = new Date(stamp);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 「这篇有没有建索引」只在**缺**的时候说。
 *
 * 没索引的文档搜不到，而它在列表里和正常文档长得一样 —— 那正是
 * 「我明明传了，它就是搜不到」最常见的来源。反过来，正常文档不必挂个「已索引」，
 * 那只是噪音。
 */
export function docIndexHint(doc: KbDocument, embedderOff: boolean): string {
  if (embedderOff) return '';
  const indexed = doc.embedded ?? 0;
  if (doc.chunkCount === 0 || indexed >= doc.chunkCount) return '';
  return indexed === 0 ? '未建索引' : `索引 ${indexed}/${doc.chunkCount}`;
}
