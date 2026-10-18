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
import { describe, expect, it } from 'vitest';
import {
  SESSION_LATENCY_FILE,
  STARTUP_PROFILE_FILE,
  buildDiagnosticsBundle,
  summarizeLatencySamples,
} from '../../electron/diagnostics';

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
