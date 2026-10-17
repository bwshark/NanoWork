/**
 * 门禁②（事件流，批次 5 §2.5 / Q5）：双实例会话事件流一致性。
 *
 * ## 夹具
 * 真起 uvicorn（`cloud/.venv`，临时 sqlite，**端口 8912**——与
 * `integration.twoDevice.test.ts` 的 8910 错开，避免两个用例文件并发抢端口）。
 * 两台「设备」= 两份 `SyncEngine`（各自独立内存 cursor）+ 两套 store 快照 +
 * **各自一份内存 `EventStore`**（`makeDevice` / `activateDevice` / `captureDevice`）。
 * 引擎注入 `createSessionEventStreamAdapter()`，交替换装后调 `engine.syncNow()`。
 *
 * ## 断言落在**原始事件列表**（规格 §3.2 勘误）
 * `project.ts::activePath` 只沿**单一** max-`seq` 尖端回溯 → 两端并发追加时，
 * 并集**在事件层完整保留**，但**投影层只显示一条链**。故这里一律断言
 * `getEventStore().readEvents(sid, shard)` 的 **id 集合 / 条数 / 顺序**，**不**断言
 * `messages` 投影。「同一会话不建议两端同时继续」为已知限制。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getEventStore } from '@/events';
import { createMemorySyncAccount } from '@/sync/syncAccount';
import { SyncClient } from '@/sync/SyncClient';
import { SyncEngine } from '@/sync/SyncEngine';
import { createSessionEventStreamAdapter } from '@/sync/eventStream';
import { createDefaultRegistry } from '@/sync/syncRegistry';
import { getSyncStatus, resetSyncStatus } from '@/sync/useSyncStatus';
import { useSessionsStore } from '@/stores/sessionsStore';
import {
  activateDevice,
  captureDevice,
  makeDevice,
  makeSession,
  type Device,
} from '../helpers/deviceSnapshot';
import type { SyncAccount } from '@/sync';
import type { SessionEvent } from '@/types/event';

// ─────────────────────────── 夹具：真起服务端 ───────────────────────────

const REPO_ROOT = path.resolve(__dirname, '../..');
const CLOUD_DIR = path.join(REPO_ROOT, 'cloud');
const PY = path.join(
  CLOUD_DIR,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const hasVenv = fs.existsSync(PY);
// 与 integration.twoDevice.test.ts（8910）错开：两文件可能被 vitest 并发调度
const BASE = 'http://127.0.0.1:8912';

const DEV_A_WS = '/devA/ws';
const DEV_B_WS = '/devB/ws';

let server: ChildProcess | null = null;
let dbDir = '';

function waitHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async (): Promise<void> => {
      if (Date.now() > deadline) {
        reject(new Error(`服务端 ${url} 在 ${timeoutMs}ms 内未就绪`));
        return;
      }
      try {
        const res = await fetch(url);
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        /* 还没起来，重试 */
      }
      setTimeout(() => void tick(), 250);
    };
    void tick();
  });
}

/** 真实等待若干毫秒（teardown 删除退避用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等子进程**真正退出**（最多 `timeoutMs`）。
 *
 * 不能只 `kill()` 就删库：Windows 上被 kill 的 uvicorn 仍可能短暂持有 SQLite 文件句柄，
 * `fs.rmSync` 随即抛 `EBUSY: resource busy or locked` → **用例全过、suite 级红**（约 1/4–1/6）。
 * 先等 `exit` 事件（或进程已退出）再删，即可消除该竞态。
 */
function waitChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      child.off('exit', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
  });
}

/** 带退避的目录删除：仍偶发占用则重试；最后一次仍失败则静默放弃（临时目录交 OS 回收）。 */
async function rmWithRetry(target: string, attempts = 30, delayMs = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      // 仍被占用：退避后重试（吞掉异常——teardown 抛错会把整 suite 拖红）
      if (attempt < attempts - 1) await sleep(delayMs);
    }
  }
}

beforeAll(async () => {
  if (!hasVenv) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-ev-'));
  const dbFile = path.join(dbDir, 'ev.db').replace(/\\/g, '/');
  server = spawn(PY, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8912'], {
    cwd: CLOUD_DIR,
    env: { ...process.env, NANOWORK_CLOUD_DB_URL: `sqlite:///${dbFile}` },
    stdio: 'ignore',
  });
  // 90s 而不是 20s：全量 229 个文件并发时，uvicorn 的 spawn + 首次 import 可以被拖到
  // 20s 以上（实测该文件在全量里报「服务端 20s 未就绪」，单跑只需 2.9s）。放宽的是
  // **余量**而不是等一个慢启动——真正的失败仍会在这里以超时报出来。
  await waitHealth(`${BASE}/health`, 90000);
}, 120000);

afterAll(async () => {
  if (server) {
    const child = server;
    server = null;
    child.kill();
    // 先等服务进程真正退出，再删临时库（否则 EBUSY）——再重试删除兜底
    await waitChildExit(child, 5000);
  }
  if (dbDir) await rmWithRetry(dbDir);
}, 20000);

// ─────────────────────────── 工具 ───────────────────────────

async function registerUser(): Promise<SyncAccount> {
  const account = createMemorySyncAccount({ baseUrl: BASE });
  const email = `ev-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await account.register(email, 'password123');
  return account;
}

/** 带事件流通道的引擎：适配器在调用时读「当前换装的设备」的 store + 会话表。 */
function buildEngine(account: SyncAccount, fetchImpl?: typeof fetch): SyncEngine {
  const client = new SyncClient({
    baseUrl: BASE,
    fetchImpl,
    getAccessToken: () => account.getAccessToken(),
    refreshAccessToken: () => account.refresh(),
  });
  return new SyncEngine({
    client,
    account,
    registry: createDefaultRegistry(),
    now: () => Date.now(),
    eventStream: createSessionEventStreamAdapter(),
  });
}

function evt(id: string, seq: number, sessionId = 's1'): SessionEvent {
  return { id, sessionId, parentId: null, seq, type: 'ai-title', timestamp: 1000 + seq, title: id };
}

/**
 * 统计每个 id 在原数组中的出现次数。
 *
 * 用例 2 的判据**必须**看原始出现次数、而非 `new Set(...).size`：Set 天然折叠重复，
 * 把 `appendRemoteEvents` 的按 id 去重删掉后 `size` 仍为 6，断言会**假绿**（本项即
 * 为加固此处而引入——原断言即因此无鉴别力）。
 */
function countById(ids: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
}

/** 可切换断网的 fetch 包装。 */
function toggleFetch(isOnline: () => boolean): typeof fetch {
  const realFetch = globalThis.fetch;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isOnline()) throw new TypeError('network down (simulated)');
    return realFetch(input, init);
  }) as unknown as typeof fetch;
}

/** 基线：A 建会话 s1 并同步；B 空装拉取 s1（streamWorkdir 重定向为 B 本机）。 */
async function seedBaseline(engineA: SyncEngine, engineB: SyncEngine): Promise<void> {
  activateDevice(devA);
  useSessionsStore.setState({
    sessions: [makeSession('s1', { workdir: '/remote/path', streamWorkdir: DEV_A_WS })],
    activeId: null,
    sessionTombstones: {},
  });
  await engineA.syncNow();
  expect(getSyncStatus().status, 'A 基线同步应 synced').toBe('synced');
  captureDevice(devA);

  activateDevice(devB);
  await engineB.syncNow();
  expect(
    useSessionsStore.getState().sessions.find((s) => s.id === 's1')?.streamWorkdir,
    'B 侧 s1 分片应为 B 本机默认',
  ).toBe(DEV_B_WS);
  captureDevice(devB);
}

let devA: Device;
let devB: Device;

beforeEach(() => {
  resetSyncStatus();
  devA = makeDevice(DEV_A_WS);
  devB = makeDevice(DEV_B_WS);
  activateDevice(devA);
});

// ─────────────────────────── 门禁② · 用例 1 ───────────────────────────

describe.skipIf(!hasVenv)('门禁②（事件流）：断网追加 N 条 → 联网 → 对端拿全且有序', () => {
  it('A 离线追加 N 条 → A 联网推送 → B 拉取拿到全部 N 条且 (seq,id) 顺序正确', async () => {
    const account = await registerUser();
    let aOnline = true;
    const engineA = buildEngine(account, toggleFetch(() => aOnline));
    const engineB = buildEngine(account);

    await seedBaseline(engineA, engineB);

    const eventsA = [evt('a1', 1), evt('a2', 2), evt('a3', 3)];
    const idsA = eventsA.map((e) => e.id);

    // —— A 断网：追加 N 条（本机保留） ——
    activateDevice(devA);
    aOnline = false;
    await getEventStore().append({ sessionId: 's1', workdir: DEV_A_WS, events: eventsA });
    await engineA.syncNow();
    expect(getSyncStatus().status, 'A 断网同步应 offline').toBe('offline');
    expect(await getEventStore().readEvents('s1', DEV_A_WS), 'A 本机应有 3 条').toHaveLength(3);
    captureDevice(devA);

    // —— A 联网：推送 ——
    activateDevice(devA);
    aOnline = true;
    const resultA = await engineA.syncNow();
    expect(getSyncStatus().status, 'A 联网同步应 synced').toBe('synced');
    expect(resultA.pushedEvents, 'A 应上行 3 条').toBe(3);
    captureDevice(devA);

    // —— B 拉取：拿到全部 N 条且顺序正确 ——
    activateDevice(devB);
    await engineB.syncNow();
    const storedB = await getEventStore().readEvents('s1', DEV_B_WS);
    const idsB = storedB.filter((e) => idsA.includes(e.id)).map((e) => e.id);

    // 删掉 collectEventChanges 里的事件收集 → idsB 为空 → 红
    expect(idsB, 'B 应拿到 A 的全部 N 条').toEqual(idsA);
    // (seq,id) 顺序：a1 < a2 < a3
    expect(idsB).toEqual([...idsB].sort());
  }, 60000);
});

// ─────────────────────────── 门禁② · 用例 2 ───────────────────────────

describe.skipIf(!hasVenv)('门禁②（事件流）：两端并发追加并集不丢', () => {
  it('A、B 各自离线追加 3 条 → 双向同步后两端 id 集合均为 6 条并集且稳定', async () => {
    const account = await registerUser();
    let aOnline = true;
    let bOnline = true;
    const engineA = buildEngine(account, toggleFetch(() => aOnline));
    const engineB = buildEngine(account, toggleFetch(() => bOnline));

    await seedBaseline(engineA, engineB);

    // —— A、B 各自离线追加 3 条不同 id ——
    activateDevice(devA);
    aOnline = false;
    await getEventStore().append({
      sessionId: 's1',
      workdir: DEV_A_WS,
      events: [evt('a1', 1), evt('a2', 2), evt('a3', 3)],
    });
    captureDevice(devA);

    activateDevice(devB);
    bOnline = false;
    await getEventStore().append({
      sessionId: 's1',
      workdir: DEV_B_WS,
      events: [evt('b1', 1), evt('b2', 2), evt('b3', 3)],
    });
    captureDevice(devB);

    // —— A 先同步 ——
    activateDevice(devA);
    aOnline = true;
    await engineA.syncNow();
    expect(getSyncStatus().status, 'A 同步应 synced').toBe('synced');
    captureDevice(devA);

    // —— B 同步（拉 A 的 + 推 B 的）——
    activateDevice(devB);
    bOnline = true;
    await engineB.syncNow();
    expect(getSyncStatus().status, 'B 同步应 synced').toBe('synced');
    captureDevice(devB);

    // —— A 再同步（拉 B 的）——
    activateDevice(devA);
    await engineA.syncNow();

    // —— 取**原始**事件 id 列表（不去重）——
    const rawA = (await getEventStore().readEvents('s1', DEV_A_WS)).map((e) => e.id);
    activateDevice(devB);
    const rawB = (await getEventStore().readEvents('s1', DEV_B_WS)).map((e) => e.id);

    // 把 appendRemoteEvents 的按 id 去重删掉（改无条件追加）→ 原始条数翻倍 → 红。
    // ⚠️ 判据**不得**用 `new Set(ids).size === 6`：Set 折叠重复，去重被删掉后 size 仍是 6
    // → 断言假绿。故这里断言**原始数组长度** + **每个 id 恰好出现 1 次**（见 countById）。
    expect(rawA.length, 'A 侧原始条数应恰为 6（含重复则 >6 → 红）').toBe(6);
    expect(rawB.length, 'B 侧原始条数应恰为 6（含重复则 >6 → 红）').toBe(6);
    expect(
      Object.values(countById(rawA)).every((c) => c === 1),
      'A 侧每个 id 必须恰好出现 1 次（有重复 → 红）',
    ).toBe(true);
    expect(
      Object.values(countById(rawB)).every((c) => c === 1),
      'B 侧每个 id 必须恰好出现 1 次（有重复 → 红）',
    ).toBe(true);

    expect([...new Set(rawA)].sort()).toEqual([...new Set(rawB)].sort());
    expect([...new Set(rawA)].sort()).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);

    // —— 并集稳定：再来一轮双向同步，两端仍是同一 6 条并集（幂等）——
    activateDevice(devA);
    await engineA.syncNow();
    activateDevice(devB);
    await engineB.syncNow();
    activateDevice(devA);
    await engineA.syncNow();

    const rawA2 = (await getEventStore().readEvents('s1', DEV_A_WS)).map((e) => e.id);
    activateDevice(devB);
    const rawB2 = (await getEventStore().readEvents('s1', DEV_B_WS)).map((e) => e.id);
    expect(rawA2.length, '第二轮后 A 侧原始条数仍应恰为 6').toBe(6);
    expect(rawB2.length, '第二轮后 B 侧原始条数仍应恰为 6').toBe(6);
    expect(
      Object.values(countById(rawA2)).every((c) => c === 1),
      '第二轮后 A 侧无重复',
    ).toBe(true);
    expect(
      Object.values(countById(rawB2)).every((c) => c === 1),
      '第二轮后 B 侧无重复',
    ).toBe(true);
    expect([...rawA2].sort()).toEqual([...rawA].sort());
    expect([...rawB2].sort()).toEqual([...rawB].sort());
  }, 90000);
});
