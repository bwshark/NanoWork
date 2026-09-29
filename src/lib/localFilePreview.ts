/**
 * 桌面端按需回读本地文件正文（文件产物预览用）。
 *
 * ## 为什么需要它
 *
 * 文件产物的正文快照只在 `write_file` 时可得到；`edit` / `apply_patch` 只给出
 * 改动片段，拿不到改写后的全文。而「点产物卡片看内容」是主路径——若不给改写类
 * 产物一条回读通道，用户点开「变更」卡片只会看到一片空白。
 *
 * ## 边界
 *
 * - **只读**：复用主进程已有的 `fs:readFileAsBase64`（无写入能力）；
 * - **Web 端自动降级**：该接口在 Web 端返回 `ok=false`，本模块统一返回 `null`，
 *   调用方据此显示「仅桌面端可预览」而不是报错；
 * - **体积上限**：超过 `MAX_PREVIEW_BYTES` 直接放弃（不把大文件灌进渲染层）；
 * - **永不抛错**：读不到 / 解码失败一律 `null`，预览失败不该让面板崩掉。
 */

import { platform } from '@/platform';

/** 预览回读的体积上限（1 MiB）：超过则视为「不预览」，避免大文件拖垮渲染 */
const MAX_PREVIEW_BYTES = 1024 * 1024;

/** 本地文件预览结果 */
export interface LocalFilePreview {
  /** 解码后的正文（已剥离 UTF-8 BOM） */
  content: string;
  /** 文件真实字节数（比正文快照的体积更准确） */
  size: number;
}

/**
 * 读取本地文本文件用于预览。
 *
 * @param path 文件绝对路径（来自文件产物的 `path`）
 * @returns 预览结果；不可读 / 非文本 / 超限 / Web 端一律 `null`
 */
export async function readLocalTextFile(path: string): Promise<LocalFilePreview | null> {
  if (!path.trim()) return null;
  try {
    const result = await platform.readFileAsBase64(path);
    if (!result.ok || typeof result.base64 !== 'string' || result.base64 === '') return null;
    const size = result.size ?? 0;
    if (size > MAX_PREVIEW_BYTES) return null;
    const content = decodeBase64Utf8(result.base64);
    return content === null ? null : { content, size };
  } catch {
    return null;
  }
}

/**
 * base64 → UTF-8 文本。
 *
 * 非 fatal 解码：二进制文件不会抛错，只会得到替换字符（调用方按扩展名决定要不要
 * 走预览，这里不做嗅探）。
 */
function decodeBase64Utf8(base64: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}