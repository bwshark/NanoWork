import { RICH_CLIP_MIME } from './editableText';

/**
 * 应用内富剪贴板降级缓存：
 *
 * 写入剪贴板时若 ClipboardItem 受限（自定义 MIME 在某些 Electron / 浏览器
 * 组合下被拒绝），回退为 `navigator.clipboard.writeText(text)` 写入纯文本
 * —— 外部应用只能看到纯文本，但本应用内粘贴时按文本键在此取出原 payload，
 * 仍然能还原内联附件布局。
 *
 * 不引入持久化：缓存仅活在前端进程内存中，刷新页面即清空。设计成同步 API
 * + 即取即删，调用方无需关心 TTL / LRU 细节。
 */

/** 单条缓存条目 */
interface Entry {
  /** 富 payload JSON：`{ rich, attachments }` */
  payload: string;
  /** 对应纯文本（用作缓存键） */
  text: string;
  /** 写入时间戳（毫秒） */
  ts: number;
}

/** 缓存存活时间：5 分钟——一次复制到粘贴几乎不可能超过这个量级 */
const TTL_MS = 5 * 60_000;

/** 同文本上限：超过按 LRU 淘汰；一般场景 8 条足够覆盖连续「复制 A→复制 B→粘贴 A」 */
const MAX_ENTRIES = 16;

/** 主存储：token → 缓存条目；token 仅作内部 key，不暴露给调用方 */
const cache = new Map<string, Entry>();

/** 全局定时器：每分钟清理一次过期条目，避免长期运行的 Web/Electron 实例内存膨胀 */
let gcTimer: ReturnType<typeof setInterval> | null = null;

function ensureGc(): void {
  if (gcTimer !== null) return;
  gcTimer = setInterval(() => gc(), 60_000);
}

/** 清理过期条目 + LRU 裁剪：调用后保证 cache.size ≤ MAX_ENTRIES */
function gc(): void {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.ts > TTL_MS) cache.delete(k);
  }
  if (cache.size > MAX_ENTRIES) {
    const sorted = Array.from(cache.entries()).sort((a, b) => a[1].ts - b[1].ts);
    const overflow = cache.size - MAX_ENTRIES;
    for (let i = 0; i < overflow; i += 1) cache.delete(sorted[i][0]);
  }
}

/** 生成内部缓存 token；时间戳+随机后缀，避免短时间内两条 text 完全相同导致相互覆盖 */
function makeToken(): string {
  return `rc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把富 payload 与对应纯文本一起缓存起来，供后续粘贴按文本键还原。
 *
 * 同一文本重复调用会覆盖前一条并刷新时间戳——保证最近一次复制对应最新 payload。
 * 调用方**不需要**持有返回值（token 仅内部使用）；成功的复制即可触发。
 */
export function stashRichPayload(text: string, payload: string): void {
  ensureGc();
  gc();
  // 同文本覆写：先清掉旧条目
  for (const [k, v] of cache) {
    if (v.text === text) cache.delete(k);
  }
  cache.set(makeToken(), { payload, text, ts: Date.now() });
  // set 之后 size 短暂 +1，再裁剪一次保证立刻收敛到 ≤ MAX_ENTRIES
  gc();
}

/**
 * 按粘贴拿到的纯文本查询最近一次缓存的富 payload。
 *
 * 非消费型（命中不移除）：同一份复制内容允许反复粘贴还原附件 ——
 * 剪贴板本身可重复粘贴，应用层缓存语义与之对齐；条目生命周期由
 * TTL（5 分钟）/ LRU（16 条）/ 同文本覆写管理。
 *
 * @returns 命中时返回 payload 字符串，未命中返回 null
 */
export function peekRichPayload(text: string): string | null {
  gc();
  // 取最近一条 text 完全匹配的
  let best: Entry | null = null;
  for (const entry of cache.values()) {
    if (entry.text !== text) continue;
    if (!best || entry.ts > best.ts) best = entry;
  }
  return best ? best.payload : null;
}

/**
 * 富复制：三段降级写入剪贴板 —— 消息气泡复制与输入框复制共用同一条链路。
 *
 * ① `ClipboardItem(text/plain + RICH_CLIP_MIME)` —— 首选。
 *    外部应用只看到纯文本；本应用粘贴时 RICH_CLIP_MIME 直命中，可还原附件。
 * ② `navigator.clipboard.writeText(text)` + 应用层缓存 —— 降级。
 *    ClipboardItem 被拒（Electron / 部分浏览器不接受自定义 MIME）时走这里，
 *    本应用粘贴时按纯文本键在缓存中命中，仍可还原附件。
 * ③ `textarea + execCommand('copy')` + 应用层缓存 —— 兜底。
 *    navigator.clipboard 完全不可用时退化。
 *
 * 任一阶段成功即返回 true；全部失败返回 false，由调用方提示用户。
 *
 * @param text 纯文本（外部应用可见的那份）
 * @param payload 富 payload JSON：`{ rich, attachments }`
 * @param hasAttachment 是否含附件 —— 仅含附件时才写应用层缓存（纯文本无需缓存）
 */
export async function writeRichClipboard(
  text: string,
  payload: string,
  hasAttachment: boolean,
): Promise<boolean> {
  /** 降级路径共享：把 payload 缓存起来供本应用粘贴时按纯文本键命中 */
  const stashOnFallback = (): void => {
    if (hasAttachment) stashRichPayload(text, payload);
  };

  // ① ClipboardItem 富复制
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          [RICH_CLIP_MIME]: new Blob([payload], { type: RICH_CLIP_MIME }),
        }),
      ]);
      // 即使富复制成功，也写一份到应用层缓存：某些环境下自定义 MIME 在多次
      // 粘贴间会被丢弃（Electron / 浏览器剪贴板策略），后续若退化为纯文本粘贴，
      // 可以从缓存按文本键命中富 payload，还原内联附件。
      stashOnFallback();
      return true;
    } catch (err) {
      console.warn('[richClipboard] ClipboardItem 写入失败，降级:', err);
    }
  }

  // ② writeText 降级
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      stashOnFallback();
      return true;
    } catch (err) {
      console.warn('[richClipboard] writeText 失败，降级:', err);
    }
  }

  // ③ execCommand 兜底
  const ta = document.createElement('textarea');
  ta.value = text;
  // 离屏但仍可被 focus + select
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  try {
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    if (ok) stashOnFallback();
    return ok;
  } catch (err) {
    console.warn('[richClipboard] execCommand 复制失败:', err);
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

/** 当前缓存条目数（仅供调试 / 单测；生产代码不要依赖此值） */
export function _sizeForTest(): number {
  return cache.size;
}

/** 清空全部缓存（仅供单测；生产代码用不到） */
export function _clearForTest(): void {
  cache.clear();
  if (gcTimer !== null) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
}
