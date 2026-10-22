/**
 * 引擎数据目录体量快照（V1.7 B5-02）。
 *
 * 钉三件事：
 * 1. **只读**：只 stat，不动数据库（B5-02 已否决跨进程 checkpoint —— 会与
 *    Python 引擎这个真正的写入者争锁；WAL 高水位本身是正常行为）。
 * 2. **不写 0**：文件不存在 / 读不到时 `bytes` 是 `null`（未知），
 *    而不是 0 —— 0 会被读成「文件是空的」，那是假信息。
 * 3. **只报已知文件**：不扫目录（引擎目录里有巨大的 `sessions/`，全扫会拖慢导出）。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENGINE_DATA_FILES,
  collectEngineDataStats,
  totalKnownBytes,
} from '../../electron/engineDataFiles';

describe('引擎数据目录体量快照（B5-02）', () => {
  it('只报已知文件，不扫目录', async () => {
    const dir = await fs.mkdtemp(join(process.env.TEMP ?? '.', 'engine-data-'));
    await fs.writeFile(join(dir, 'llm_usage.sqlite3'), 'x'.repeat(100));
    // 一个不在白名单里的文件：不该被报出来。
    await fs.writeFile(join(dir, 'unrelated.bin'), 'y'.repeat(9999));

    const snap = await collectEngineDataStats(dir);

    expect(snap.dataDir).toBe(dir);
    expect(snap.files.map((f) => f.file)).toEqual([...ENGINE_DATA_FILES]);
    expect(snap.files.some((f) => f.file.includes('unrelated'))).toBe(false);
  });

  it('读到真实字节数与修改时间', async () => {
    const dir = await fs.mkdtemp(join(process.env.TEMP ?? '.', 'engine-data-'));
    const target = join(dir, 'llm_usage.sqlite3');
    await fs.writeFile(target, 'x'.repeat(2048));

    const snap = await collectEngineDataStats(dir);
    const main = snap.files.find((f) => f.file === 'llm_usage.sqlite3');

    expect(main?.bytes).toBe(2048);
    expect(main?.modifiedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(main?.modifiedAt ?? ''))).toBe(false);
  });

  it('文件不存在时 bytes 是 null 而不是 0', async () => {
    const dir = await fs.mkdtemp(join(process.env.TEMP ?? '.', 'engine-data-'));
    // 空目录：主库与 -wal 都不存在。
    const snap = await collectEngineDataStats(dir);

    expect(snap.files.length).toBe(ENGINE_DATA_FILES.length);
    for (const f of snap.files) {
      expect(f.bytes).toBeNull();
      expect(f.modifiedAt).toBeNull();
    }
  });

  it('未知 dataDir 时返回空快照，不猜', async () => {
    const snap = await collectEngineDataStats(null);
    expect(snap.dataDir).toBeNull();
    expect(snap.files).toEqual([]);
  });

  it('WAL 旁文件单独列出（只看主库会低估占用）', async () => {
    const dir = await fs.mkdtemp(join(process.env.TEMP ?? '.', 'engine-data-'));
    await fs.writeFile(join(dir, 'llm_usage.sqlite3'), 'x'.repeat(10));
    await fs.writeFile(join(dir, 'llm_usage.sqlite3-wal'), 'x'.repeat(500));

    const snap = await collectEngineDataStats(dir);
    const wal = snap.files.find((f) => f.file === 'llm_usage.sqlite3-wal');
    const main = snap.files.find((f) => f.file === 'llm_usage.sqlite3');

    expect(wal?.bytes).toBe(500);
    expect(main?.bytes).toBe(10);
    // 合计必须把 WAL 算进去。
    expect(totalKnownBytes(snap).bytes).toBe(510);
  });

  it('目录同名时当作读不到（不是文件，尺寸无意义）', async () => {
    const dir = await fs.mkdtemp(join(process.env.TEMP ?? '.', 'engine-data-'));
    await fs.mkdir(join(dir, 'llm_usage.sqlite3'));

    const snap = await collectEngineDataStats(dir);
    const main = snap.files.find((f) => f.file === 'llm_usage.sqlite3');
    expect(main?.bytes).toBeNull();
  });

  it('totalKnownBytes 把未知文件单独计数', async () => {
    const dir = await fs.mkdtemp(join(process.env.TEMP ?? '.', 'engine-data-'));
    await fs.writeFile(join(dir, 'llm_usage.sqlite3'), 'x'.repeat(64));

    const snap = await collectEngineDataStats(dir);
    const total = totalKnownBytes(snap);

    expect(total.bytes).toBe(64);
    expect(total.knownFiles).toBe(1);
    // -wal 不存在 → 算未知，不是 0 字节的已知文件。
    expect(total.unknownFiles).toBe(1);
  });
});
