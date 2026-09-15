import { genId } from '@/lib/id';
import { platform } from '@/platform';
import type { UploadFile } from '@/ai/runtime/types';
import type { Attachment, AttachmentKind } from '@/types';

/**
 * 附件（Attachment）工具集：扩展名 → MIME / 大类映射、文件读取、
 * 上传载荷转换、持久化裁剪。
 *
 * 统一在此维护唯一一份映射表：nanobotClient 上传时推断 MIME、
 * Composer 预览条选择图标、`<input accept>` 生成可选类型，全部复用本模块，
 * 避免多处各写一份导致「能选但传不上去」的不一致。
 */

/** 单文件大小上限（对齐 nanobot 文件上传限制：10MB/文件） */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** 单条消息最多携带的附件数量（避免 multipart 过大被网关拒收） */
export const MAX_ATTACHMENT_COUNT = 10;

/**
 * 落库时保留 dataUrl 的体积上限：本地存储（localStorage）容量有限，
 * 大文件只保留元信息，UI 退化为图标 + 文件名展示。
 */
const PERSIST_DATAURL_LIMIT = 512 * 1024;

/** 扩展名 → MIME + 大类（唯一映射源） */
const EXT_META: Record<string, { mime: string; kind: AttachmentKind }> = {
  // —— 图片 ——
  png: { mime: 'image/png', kind: 'image' },
  jpg: { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  gif: { mime: 'image/gif', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  bmp: { mime: 'image/bmp', kind: 'image' },
  svg: { mime: 'image/svg+xml', kind: 'image' },
  ico: { mime: 'image/x-icon', kind: 'image' },
  tif: { mime: 'image/tiff', kind: 'image' },
  tiff: { mime: 'image/tiff', kind: 'image' },
  // —— 视频 ——
  mp4: { mime: 'video/mp4', kind: 'video' },
  mov: { mime: 'video/quicktime', kind: 'video' },
  webm: { mime: 'video/webm', kind: 'video' },
  avi: { mime: 'video/x-msvideo', kind: 'video' },
  mkv: { mime: 'video/x-matroska', kind: 'video' },
  m4v: { mime: 'video/x-m4v', kind: 'video' },
  // —— 音频 ——
  mp3: { mime: 'audio/mpeg', kind: 'audio' },
  wav: { mime: 'audio/wav', kind: 'audio' },
  m4a: { mime: 'audio/mp4', kind: 'audio' },
  ogg: { mime: 'audio/ogg', kind: 'audio' },
  flac: { mime: 'audio/flac', kind: 'audio' },
  aac: { mime: 'audio/aac', kind: 'audio' },
  // —— 文档（含 Office / PDF / 电子书） ——
  pdf: { mime: 'application/pdf', kind: 'document' },
  doc: { mime: 'application/msword', kind: 'document' },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
  },
  xls: { mime: 'application/vnd.ms-excel', kind: 'document' },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'document',
  },
  ppt: { mime: 'application/vnd.ms-powerpoint', kind: 'document' },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'document',
  },
  odt: { mime: 'application/vnd.oasis.opendocument.text', kind: 'document' },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', kind: 'document' },
  odp: { mime: 'application/vnd.oasis.opendocument.presentation', kind: 'document' },
  rtf: { mime: 'application/rtf', kind: 'document' },
  epub: { mime: 'application/epub+zip', kind: 'document' },
  // —— 文本 / 标记 / 配置 / 日志 ——
  txt: { mime: 'text/plain', kind: 'text' },
  md: { mime: 'text/markdown', kind: 'text' },
  markdown: { mime: 'text/markdown', kind: 'text' },
  csv: { mime: 'text/csv', kind: 'text' },
  tsv: { mime: 'text/tab-separated-values', kind: 'text' },
  json: { mime: 'application/json', kind: 'text' },
  jsonl: { mime: 'application/jsonl', kind: 'text' },
  xml: { mime: 'application/xml', kind: 'text' },
  html: { mime: 'text/html', kind: 'text' },
  htm: { mime: 'text/html', kind: 'text' },
  yaml: { mime: 'application/yaml', kind: 'text' },
  yml: { mime: 'application/yaml', kind: 'text' },
  toml: { mime: 'application/toml', kind: 'text' },
  ini: { mime: 'text/plain', kind: 'text' },
  conf: { mime: 'text/plain', kind: 'text' },
  cfg: { mime: 'text/plain', kind: 'text' },
  properties: { mime: 'text/plain', kind: 'text' },
  log: { mime: 'text/plain', kind: 'text' },
  sql: { mime: 'application/sql', kind: 'text' },
  tex: { mime: 'application/x-tex', kind: 'text' },
};

/** `<input type="file">` 的 accept 属性：直接由映射表派生，避免手工维护遗漏 */
export const ATTACHMENT_ACCEPT = Object.keys(EXT_META)
  .map((ext) => `.${ext}`)
  .join(',');

/** 取文件名的小写扩展名（无扩展名返回空串） */
export function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx === -1 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

/** 推断常见扩展名的 MIME（nanobot 按扩展名判别文件类型） */
export function inferMime(name: string): string {
  return EXT_META[extOf(name)]?.mime ?? 'application/octet-stream';
}

/**
 * 判定附件大类：优先用浏览器给出的 MIME，缺失或过于笼统时按扩展名兜底。
 * 这样即时后端只认扩展名，UI 也能拿到稳定的图标分类。
 */
export function classifyKind(name: string, mime?: string): AttachmentKind {
  const ext = extOf(name);
  if (mime && mime !== 'application/octet-stream') {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    // 其余（pdf / office / 各类文本）一律按扩展名再判一次，避免被泛化 MIME 误导
    const byExt = EXT_META[ext];
    if (byExt) return byExt.kind;
    if (mime.startsWith('text/')) return 'text';
    return 'other';
  }
  return EXT_META[ext]?.kind ?? 'other';
}

/** 人类可读的体积文案（B / KB / MB / GB） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** 读取 File 为 dataUrl（`data:<mime>;base64,<payload>`） */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`读取文件「${file.name}」失败`));
    reader.readAsDataURL(file);
  });
}

/**
 * 把浏览器 File 转成附件对象。
 * 超过 nanobot 单文件上限（10MB）时抛错，由调用方 toast 提示。
 */
export async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `「${file.name}」${formatBytes(file.size)}，超出单文件 ${formatBytes(MAX_ATTACHMENT_BYTES)} 上限`,
    );
  }
  const mime = file.type || inferMime(file.name);
  const kind = classifyKind(file.name, mime);
  const dataUrl = await readAsDataUrl(file);
  // Electron 桌面端：选择/拖拽得到的 File 额外带 .path（本地真实路径），
  // 供悬停提示展示「目录 + 名称」；Web 环境无此属性，自然降级为 undefined
  const localPath = (file as File & { path?: string }).path || undefined;
  return {
    id: genId(),
    name: file.name,
    size: file.size,
    mime,
    kind,
    // 图片额外给一份 object URL：渲染大图时不必解码整段 base64，滚动更跟手
    previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
    dataUrl,
    localPath,
  };
}

/** 从 dataUrl 中取出纯 base64 载荷（非 dataUrl 原样返回，空值返回空串） */
export function dataUrlToBase64(dataUrl?: string): string {
  if (!dataUrl) return '';
  const comma = dataUrl.indexOf(',');
  // 无逗号说明调用方直接给了 base64 串（历史数据兼容）
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/** 附件 → 上传载荷（UploadFile）。内容缺失（如大文件未落库）时返回 null */
export function attachmentToUploadFile(attachment: Attachment): UploadFile | null {
  const content = dataUrlToBase64(attachment.dataUrl);
  if (content === '') return null;
  return {
    name: attachment.name,
    content,
    mimeType: attachment.mime || inferMime(attachment.name),
  };
}

/** 批量转换并过滤掉无内容的条目 */
export function attachmentsToUploadFiles(
  attachments?: Attachment[] | null,
): UploadFile[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments
    .map(attachmentToUploadFile)
    .filter((f): f is UploadFile => f !== null);
}

/**
 * 裁剪为可持久化形态：
 * - previewUrl 是本地 object URL，刷新后必然失效，一律丢弃；
 * - localPath 随消息持久化：已发送气泡悬停提示展示「目录 + 名称」；
 * - dataUrl 仅对「小图片」保留，保证刷新后气泡仍能显示缩略图；
 * - 其余只留元信息，UI 退化为图标 + 文件名。
 */
export function toPersistableAttachment(attachment: Attachment): Attachment {
  const keepData =
    attachment.kind === 'image' &&
    attachment.size <= PERSIST_DATAURL_LIMIT &&
    !!attachment.dataUrl;
  return {
    id: attachment.id,
    name: attachment.name,
    size: attachment.size,
    mime: attachment.mime,
    kind: attachment.kind,
    ...(keepData ? { dataUrl: attachment.dataUrl } : {}),
    ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
  };
}

/** 释放附件的 object URL（移除附件 / 卸载组件时调用，避免内存泄漏） */
export function revokeAttachmentPreview(attachment: Attachment): void {
  if (attachment.previewUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

/** 附件在预览条/气泡中的展示图：优先 object URL，其次小图 dataUrl */
export function attachmentPreviewSrc(attachment: Attachment): string | undefined {
  if (attachment.kind !== 'image') return undefined;
  return attachment.previewUrl ?? attachment.dataUrl;
}

/**
 * 把持久化附件恢复为可发送形态（复制消息后粘贴还原用）：
 * - dataUrl 存在（小图片）直接复用；
 * - 否则桌面端经 localPath 重读源文件补回内容；
 * - 两者皆不可得返回 null，调用方提示跳过。
 */
export async function rehydrateAttachment(
  meta: Attachment,
): Promise<Attachment | null> {
  if (meta.dataUrl) return { ...meta };
  if (meta.localPath) {
    const res = await platform.readFileAsBase64(meta.localPath);
    if (res.ok && res.base64 !== undefined) {
      return {
        ...meta,
        size: res.size ?? meta.size,
        dataUrl: `data:${meta.mime || inferMime(meta.name)};base64,${res.base64}`,
      };
    }
  }
  return null;
}
