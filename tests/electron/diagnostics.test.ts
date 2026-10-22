/**
 * 诊断包（B4-04）。
 *
 * 钉三件事：
 * 1. **额外产物真的进包**：启动剖析与首字延迟摘要缺席时不能报错，存在时必须进包；
 * 2. **延迟摘要的统计口径**：坏行（进程被杀时的半条 JSON）不能让整份摘要消失；
 * 3. **脱敏命中数透出**：界面要能说「这包被改过多少处」，而不是把清单藏进 zip。
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  SESSION_LATENCY_FILE,
  STARTUP_PROFILE_FILE,
  buildDiagnosticsBundle,
  summarizeLatencySamples,
} from '../../electron/diagnostics';

/**
 * 从 zip 字节里取出某个条目的文本内容。
 *
 * 诊断包用 `createZip` 生成（store / deflate 两种方法都可能用），所以这里
 * 按 local header 逐条走：读到 `PK\x03\x04` → 解析压缩方法与长度 → 解压。
 * 够用即可：只解析我们自己生成、名字已知的条目。
 */
function readZipEntry(zip: Buffer, entryName: string): string | null {
  const nameBuf = Buffer.from(entryName, 'utf-8');
  let offset = 0;
  while (offset + 30 <= zip.length) {
    if (zip.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString('utf-8');
    const dataStart = nameStart + nameLength + extraLength;
    if (name === entryName) {
      const payload = zip.subarray(dataStart, dataStart + compressedSize);
      return method === 0 ? payload.toString('utf-8') : inflateRawSync(payload).toString('utf-8');
    }
    offset = dataStart + compressedSize;
  }
  return null;
}

async function writeFile(root: string, relative: string, content: string): Promise<void> {
  const target = join(root, ...relative.split('/'));
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
}

function latencyRecords(...ttft: number[]): string {
  return ttft
    .map((value, index) =>
      JSON.stringify({
        at: 1_700_000_000_000 + index,
        startedAtMs: 0,
        firstByteAtMs: value,
        firstTokenAtMs: value + 10,
        ttftMs: value,
        firstTokenLatencyMs: value + 20,
      }),
    )
    .join('\n');
}

describe('summarizeLatencySamples', () => {
  it('空文本 / 全是坏行时返回 null', () => {
    expect(summarizeLatencySamples('')).toBeNull();
    expect(summarizeLatencySamples('not json\n{"ttftMs": "fast"}\n')).toBeNull();
  });

  it('计算 min / p50 / p95 / max（最近秩法）', () => {
    const summary = summarizeLatencySamples(latencyRecords(100, 300, 500));

    expect(summary).not.toBeNull();
    expect(summary?.count).toBe(3);
    expect(summary?.ttftMs).toEqual({ min: 100, p50: 300, p95: 500, max: 500 });
    expect(summary?.firstTokenLatencyMs).toEqual({
      min: 120,
      p50: 320,
      p95: 520,
      max: 520,
    });
  });

  it('半条 JSON（进程被杀）只丢那一行，不影响其余样本', () => {
    const text = `${latencyRecords(100, 200)}\n{"at":1699999999999,"ttftMs":30`;
    const summary = summarizeLatencySamples(text);

    expect(summary?.count).toBe(3);
    expect(summary?.ttftMs?.max).toBe(200);
  });

  it('recent 只保留最近 N 条', () => {
    const summary = summarizeLatencySamples(latencyRecords(10, 20, 30, 40), {
      recentLimit: 2,
    });
    expect(summary?.recent.map((r) => r.ttftMs)).toEqual([30, 40]);
  });
});

describe('buildDiagnosticsBundle', () => {
  it('把启动剖析与延迟摘要一起打包，并回传脱敏命中数', async () => {
    const root = await fs.mkdtemp(join(process.env.TEMP ?? '/tmp', 'nw-diag-'));
    await writeFile(
      root,
      'logs/2026-10-18/main.log',
      '[2026-10-18T00:00:00Z] [app] info 调用失败 api_key: supersecretvalue123\n',
    );
    await writeFile(root, SESSION_LATENCY_FILE, latencyRecords(120, 240, 360));
    await writeFile(
      root,
      STARTUP_PROFILE_FILE,
      `${JSON.stringify({ durationMs: 1234, token: 'startupsecret123456' })}\n`,
    );

    const bundle = await buildDiagnosticsBundle({
      userData: root,
      appInfo: { version: '0.1.0' },
      now: 1_700_000_000_000,
    });

    expect(bundle.entries).toContain('README.txt');
    expect(bundle.entries).toContain('meta.json');
    expect(bundle.entries).toContain(STARTUP_PROFILE_FILE);
    expect(bundle.entries).toContain('session-latency.summary.json');
    expect(bundle.entries).toContain('logs/2026-10-18/main.log');
    expect(bundle.entryCount).toBe(bundle.entries.length);
    expect(bundle.skipped).toBe(0);
    // 日志里的 api_key + 启动剖析里的 token：至少两处被脱敏。
    expect(bundle.redactionHits).toBeGreaterThanOrEqual(2);
  });

  it('没有剖析 / 延迟样本时不生成空文件，也不报错', async () => {
    const root = await fs.mkdtemp(join(process.env.TEMP ?? '/tmp', 'nw-diag-empty-'));
    await writeFile(root, 'logs/2026-10-18/main.log', 'hello\n');

    const bundle = await buildDiagnosticsBundle({ userData: root, now: 1_700_000_000_000 });

    expect(bundle.entries).not.toContain(STARTUP_PROFILE_FILE);
    expect(bundle.entries).not.toContain('session-latency.summary.json');
    expect(bundle.redactionHits).toBe(0);
  });

  it('userData 为空目录时也能产出一个最小包（README + meta）', async () => {
    const root = await fs.mkdtemp(join(process.env.TEMP ?? '/tmp', 'nw-diag-bare-'));

    const bundle = await buildDiagnosticsBundle({ userData: root, now: 1_700_000_000_000 });

    expect(bundle.entries).toEqual(['README.txt', 'meta.json']);
    expect(bundle.redactionHits).toBe(0);
    expect(bundle.bytes.length).toBeGreaterThan(0);
  });
});

describe('诊断包里的引擎数据目录体量（V1.7 B5-02）', () => {
  it('meta.json 带 engineData 段：逐文件字节数 + 合计', async () => {
    const root = await fs.mkdtemp(join(process.env.TEMP ?? '/tmp', 'nw-diag-engdata-'));
    const engineDir = await fs.mkdtemp(join(process.env.TEMP ?? '/tmp', 'nw-engine-'));
    await fs.writeFile(join(engineDir, 'llm_usage.sqlite3'), 'x'.repeat(4096));
    await fs.writeFile(join(engineDir, 'llm_usage.sqlite3-wal'), 'x'.repeat(1024));

    const bundle = await buildDiagnosticsBundle({
      userData: root,
      now: 1_700_000_000_000,
      engineData: {
        dataDir: engineDir,
        files: [
          { file: 'llm_usage.sqlite3', bytes: 4096, modifiedAt: '2026-10-21T00:00:00.000Z' },
          { file: 'llm_usage.sqlite3-wal', bytes: 1024, modifiedAt: '2026-10-21T00:00:00.000Z' },
        ],
      },
    });

    const metaText = readZipEntry(bundle.bytes, 'meta.json');
    expect(metaText).not.toBeNull();
    const meta = JSON.parse(metaText as string) as {
      engineData: {
        included: boolean;
        totalKnownBytes: number;
        files: Array<{ file: string; bytes: number | null }>;
      };
    };

    expect(meta.engineData.included).toBe(true);
    expect(meta.engineData.totalKnownBytes).toBe(5120);
    expect(meta.engineData.files.map((f) => f.file)).toEqual([
      'llm_usage.sqlite3',
      'llm_usage.sqlite3-wal',
    ]);
  });

  it('meta.json 不带引擎数据的绝对路径（只给目录名）', async () => {
    const root = await fs.mkdtemp(join(process.env.TEMP ?? '/tmp', 'nw-diag-engdata2-'));

    const bundle = await buildDiagnosticsBundle({
      userData: root,
      now: 1_700_000_000_000,
      engineData: {
        dataDir: '/home/someuser/.nanobot/instance-abc',
        files: [{ file: 'llm_usage.sqlite3', bytes: 10, modifiedAt: null }],
      },
    });

    const metaText = readZipEntry(bundle.bytes, 'meta.json') as string;
    // ⚠️ 诊断包是要发出去的：绝对路径含用户名，不能出现在 meta.json 里。
    expect(metaText).not.toContain('someuser');
    expect(metaText).not.toContain('/home/');
    // 但要知道是哪个实例目录。
    expect(metaText).toContain('instance-abc');
  });

  it('没给 engineData 时明确标 included=false（不留空段让人猜）', async () => {
    const root = await fs.mkdtemp(join(process.env.TEMP ?? '/tmp', 'nw-diag-engdata3-'));

    const bundle = await buildDiagnosticsBundle({ userData: root, now: 1_700_000_000_000 });

    const meta = JSON.parse(readZipEntry(bundle.bytes, 'meta.json') as string) as {
      engineData: { included: boolean };
    };
    expect(meta.engineData.included).toBe(false);
  });

  it('README 说明这一段是只读 stat，且提示 WAL 会被低估', async () => {
    const root = await fs.mkdtemp(join(process.env.TEMP ?? '/tmp', 'nw-diag-engdata4-'));

    const bundle = await buildDiagnosticsBundle({
      userData: root,
      now: 1_700_000_000_000,
      engineData: {
        dataDir: '/tmp/instance-x',
        files: [{ file: 'llm_usage.sqlite3', bytes: 10, modifiedAt: null }],
      },
    });

    const readme = readZipEntry(bundle.bytes, 'README.txt') as string;
    expect(readme).toContain('engineData');
    // 关键提醒：不能让人以为高水位 = 泄漏，更不能让人以为这里会做 checkpoint。
    expect(readme).toContain('WAL');
    expect(readme).toContain('只读');
  });
});
