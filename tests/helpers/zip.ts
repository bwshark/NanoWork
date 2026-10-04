/**
 * 测试用的最小 ZIP 读取器。
 *
 * **不复用 `electron/zipWriter` 的任何判断**：打包器写错时，用它自己的读法读回来
 * 是恒真的假绿（CRC 算错、中央目录偏移算错都看不出来）。这里按 ZIP 规范逐字段读
 * 中央目录，解压走 node 内置的 `zlib.inflateRawSync` —— 共享物只有平台模块。
 */

import { inflateRawSync } from 'node:zlib';

export interface ParsedZipEntry {
  name: string;
  data: Buffer;
  crc: number;
  uncompSize: number;
  /** 0 = store，8 = deflate */
  method: number;
  /** 通用位标记（bit 11 = UTF-8 名字） */
  flags: number;
  /** DOS 时间（本地） */
  mtime: number;
  /** DOS 日期（本地） */
  mdate: number;
}

export function readZip(buf: Buffer): ParsedZipEntry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('EOCD 不存在：不是合法 ZIP');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize !== eocd) throw new Error('中央目录偏移与 EOCD 不自洽');

  const out: ParsedZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`第 ${i} 条中央目录签名不对`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const mtime = buf.readUInt16LE(p + 12);
    const mdate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`${name} 的本地文件头签名不对`);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    if (buf.toString('utf-8', lho + 30, lho + 30 + lNameLen) !== name)
      throw new Error(`${name} 的本地 / 中央目录名不一致`);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const stored = buf.subarray(dataStart, dataStart + compSize);

    out.push({
      name,
      data: method === 8 ? inflateRawSync(stored) : Buffer.from(stored),
      crc,
      uncompSize,
      method,
      flags,
      mtime,
      mdate,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 解包成 `路径 → 文本` 便于断言 */
export function readZipText(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readZip(buf)) out[e.name] = e.data.toString('utf-8');
  return out;
}
