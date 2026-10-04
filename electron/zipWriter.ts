/**
 * 最小 ZIP 打包器（FR-11.3「一键打包诊断」）——**纯逻辑，只依赖 `node:zlib`**。
 *
 * ## 为什么不装 archiver / jszip
 *
 * 本项目对依赖的态度一贯是「能用几十行写清、就不引入一个包」（见手写 SHA-256、
 * 手写 RRULE 降级）。ZIP 的**写**方向格式非常小：本地文件头 + 中央目录 + EOCD
 * 三段定长结构，压缩率还能直接用 `zlib.deflateRawSync`。反过来引一个包，会在
 * Electron 打包链路里多一份要跟着升的东西，而这里只用它写一次诊断包。
 *
 * 代价是必须自己写 CRC-32 —— 这是读方（资源管理器 / `unzip` / `Expand-Archive`）
 * 校验完整性的唯一依据，**不能省**（省略 CRC 的包很多工具会直接判损坏）。
 *
 * ## 三条形态约定
 *
 * 1. **名字一律正斜杠**：ZIP 规范如此；`\` 会被读方当成文件名的一部分。
 * 2. **UTF-8 名字位开（flag bit 11）**：显式声明编码，避免中文文件名在
 *    Windows 与 Linux 上被分别按 CP437 / UTF-8 解释成两种名字。
 * 3. **压缩后更大就退回 store**：小文本文件（几十字节的 meta）deflate 后往往更大，
 *    而且读方还得解压。判断留在这里，调用方不必关心。
 *
 * 不支持 ZIP64（>4GB 或 >65535 个条目）：诊断包是「几个 MB、几十个文件」的量级，
 * 真要越界说明出了别的问题，让它抛错比悄悄写出一个坏包好。
 */

import { deflateRawSync } from 'node:zlib';

export interface ZipEntryInput {
  /** 包内路径（正斜杠）。绝对路径 / `..` / 反斜杠一律拒绝 */
  name: string;
  data: Buffer | string;
  /** 修改时间（缺省取打包时刻）；ZIP 的时间精度是 2 秒、年份起点 1980 */
  mtimeMs?: number;
}

/** 单个条目允许的最大体积（仅用于给出可读的报错，不是 ZIP 规范限制） */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** 标准 CRC-32（IEEE 802.3，ZIP 用的那份） */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 包内路径规范化；非法返回 null（调用方据此跳过该条目） */
export function normalizeZipPath(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const posix = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (posix === '' || posix.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(posix)) return null; // Windows 盘符绝对路径
  const parts = posix.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return posix;
}

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  // 1980 是 ZIP 的年份起点；更早的时间会被读方解释成 1979-11-30，故夹住
  const year = Math.max(d.getFullYear(), 1980);
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

function u16(value: number): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16LE(value & 0xffff, 0);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

/**
 * 打包成 ZIP 字节。
 *
 * 名字非法的条目会被**跳过**（而不是让整包失败）：诊断包的价值在于「尽量多地带走
 * 现场」，一行文件名的形态问题不该让用户导不出来。
 */
export function createZip(entries: readonly ZipEntryInput[], now: number = Date.now()): Buffer {
  if (entries.length > 0xffff) {
    throw new Error(`[zip] 条目数超出非 ZIP64 上限：${entries.length}`);
  }

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeZipPath(entry.name);
    if (!name) continue;
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf-8');
    if (raw.length > MAX_ENTRY_BYTES) continue;

    const nameBuf = Buffer.from(name, 'utf-8');
    const deflated = deflateRawSync(raw);
    // 压缩后反而更大就用 store（method 0）——小文本文件经常如此
    const stored = deflated.length >= raw.length;
    const payload = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);
    const { time, date } = dosDateTime(entry.mtimeMs ?? now);
    const flags = 0x0800; // UTF-8 名字

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(flags),
      u16(method),
      u16(time),
      u16(date),
      u32(crc),
      u32(payload.length),
      u32(raw.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
    ]);
    locals.push(localHeader, payload);

    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20), // version made by
        u16(20), // version needed
        u16(flags),
        u16(method),
        u16(time),
        u16(date),
        u32(crc),
        u32(payload.length),
        u32(raw.length),
        u16(nameBuf.length),
        u16(0), // extra len
        u16(0), // comment len
        u16(0), // disk number start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset),
        nameBuf,
      ]),
    );
    offset += localHeader.length + payload.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(centrals.length),
    u16(centrals.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);

  return Buffer.concat([...locals, centralDir, eocd]);
}
