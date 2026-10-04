import { describe, expect, it } from 'vitest';
import { createZip, crc32, normalizeZipPath } from '../../electron/zipWriter';
import { readZip } from '../helpers/zip';

describe('crc32', () => {
  it('与标准测试向量一致（CRC 写错 = 读方判包损坏）', () => {
    expect(crc32(Buffer.from(''))).toBe(0);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from('a'))).toBe(0xe8b7be43);
    expect(crc32(Buffer.from('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

describe('normalizeZipPath', () => {
  it('只接受相对的正斜杠路径', () => {
    expect(normalizeZipPath('logs/2026-10-04/chat.log')).toBe('logs/2026-10-04/chat.log');
    expect(normalizeZipPath('meta.json')).toBe('meta.json');
    // 反斜杠归一成正斜杠（Windows 侧拼出来的路径）
    expect(normalizeZipPath('logs\\2026-10-04\\chat.log')).toBe('logs/2026-10-04/chat.log');
    expect(normalizeZipPath('./a.txt')).toBe('a.txt');
  });

  it('挡掉绝对路径与上跳', () => {
    for (const bad of ['/etc/passwd', 'C:/x', '../x', 'a/../../b', 'a//b', '', 'a/./b', 1, null])
      expect(normalizeZipPath(bad)).toBeNull();
  });
});

describe('createZip', () => {
  // DOS 时间按**本地**时间写入（ZIP 规范如此），所以这里也用本地构造，
  // 用例才不会随 CI 时区漂移
  const t = new Date(2026, 9, 4, 6, 20, 31).getTime();

  it('条目可被独立解析回来，CRC 与长度都对得上', () => {
    const entries = [
      { name: 'meta.json', data: '{"a":1}\n' },
      { name: 'logs/2026-10-04/chat.log', data: 'hello\n' },
    ];
    const parsed = readZip(createZip(entries, t));
    expect(parsed.map((e) => e.name)).toEqual(['meta.json', 'logs/2026-10-04/chat.log']);
    expect(parsed[0]!.data.toString('utf-8')).toBe('{"a":1}\n');
    expect(parsed[1]!.data.toString('utf-8')).toBe('hello\n');
    for (const [i, e] of parsed.entries()) {
      expect(e.crc).toBe(crc32(Buffer.from(entries[i]!.data)));
      expect(e.uncompSize).toBe(Buffer.byteLength(entries[i]!.data));
      // UTF-8 名字位必须开，否则中文名会被读方按 CP437 解释
      expect(e.flags & 0x0800).toBe(0x0800);
    }
  });

  it('能压缩的走 deflate、压不动的退回 store（小文件 deflate 往往更大）', () => {
    const parsed = readZip(
      createZip(
        [
          { name: 'tiny.txt', data: 'x' },
          { name: 'big.txt', data: 'abcd'.repeat(2000) },
        ],
        t,
      ),
    );
    expect(parsed[0]!.method).toBe(0);
    expect(parsed[1]!.method).toBe(8);
    expect(parsed[1]!.data.toString('utf-8')).toBe('abcd'.repeat(2000));
  });

  it('中文路径与内容走 UTF-8 往返', () => {
    const parsed = readZip(createZip([{ name: '日志/中文.log', data: '你好，世界\n' }], t));
    expect(parsed[0]!.name).toBe('日志/中文.log');
    expect(parsed[0]!.data.toString('utf-8')).toBe('你好，世界\n');
  });

  it('非法名字的条目被跳过，不拖垮整包', () => {
    const parsed = readZip(
      createZip([{ name: '../evil', data: 'x' }, { name: 'ok.txt', data: 'y' }], t),
    );
    expect(parsed.map((e) => e.name)).toEqual(['ok.txt']);
  });

  it('空包也是合法 ZIP（只有 EOCD）', () => {
    const buf = createZip([], t);
    expect(buf.length).toBe(22);
    expect(buf.readUInt32LE(0)).toBe(0x06054b50);
    expect(readZip(buf)).toEqual([]);
  });

  it('DOS 时间落在 1980 起点之后（更早的时间会被读方解释成 1979）', () => {
    const parsed = readZip(createZip([{ name: 'a', data: '1', mtimeMs: Date.UTC(1970, 0, 1) }], t));
    const year = 1980 + (parsed[0]!.mdate >> 9);
    expect(year).toBe(1980);
  });

  it('记录真实修改时间（诊断包里靠它判断「哪条更新」）', () => {
    const parsed = readZip(createZip([{ name: 'a', data: '1', mtimeMs: t }], t));
    expect(parsed[0]!.mdate >> 9).toBe(2026 - 1980);
    expect((parsed[0]!.mdate >> 5) & 0x0f).toBe(10);
    expect(parsed[0]!.mdate & 0x1f).toBe(4);
    expect(parsed[0]!.mtime >> 11).toBe(6);
  });

  it('条目数超上限时抛错（不悄悄写出一个坏包）', () => {
    const many = Array.from({ length: 0x10000 }, (_, i) => ({ name: `f${i}`, data: '' }));
    expect(() => createZip(many, t)).toThrow(/ZIP64/);
  });
});
