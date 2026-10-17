/**
 * 门禁①②（规格 §I.1 / §I.2）：两端登录同账户后的双向一致 + 离线改合并无丢失。
 *
 * ## 夹具
 * 真的起一个 uvicorn（`cloud/.venv`，临时 sqlite），两台「设备」= 两份
 * `SyncEngine`（各自独立内存 cursor）+ 两套 store 快照 + **各自一份内存
 * `EventStore`**（`tests/helpers/deviceSnapshot` 的 `makeDevice` / `activateDevice`
 * / `captureDevice`），交替换装后调 `engine.syncNow()`。`cloud/.venv` 不存在 →
 * `describe.skipIf` 跳过。
 *
 * 事件存储**每设备一份**（批次 5 §2.5）：现夹具早先是一套共享 store，无法表达
 * 「A 追加的事件 B 看不见」。两个门禁用例都不触碰事件流，但夹具统一到设备对象后，
 * 事件流的隔离对后续用例（`sessionEventsSync.test.ts`）自然成立。
 *
 * ## 与规格的偏差（按文首「决策勘误」横幅）
 * G1 走 **C2**（服务端落库前归一 `updatedAt` + 完全同版幂等跳过），**不是** C1。
 * §0.1-C1 的自冲突过滤**未实现**，因此本文件的「空闲同步后 `status === 'synced'`」
 * 正是验证 **C2 生效**（无自冲突）的关键；把服务端归一那行去掉 → 该断言变红。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SyncClient } from '@/sync/SyncClient';
import { SyncEngine } from '@/sync/SyncEngine';
import { createDefaultRegistry } from '@/sync/syncRegistry';
import { getSyncStatus, resetSyncStatus } from '@/sync/useSyncStatus';
import { createMemorySyncAccount } from '@/sync/syncAccount';
import { useAgentsStore } from '@/stores/agentsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { __setEventStoreForTest } from '@/events';
import {
  activateDevice,
  captureDevice,
  makeAgent,
  makeDevice,
  makeSession,
  type Device,
} from '../helpers/deviceSnapshot';
import type { SyncAccount } from '@/sync';
import type { Agent, Session } from '@/types';

// ─────────────────────────── 夹具：真起服务端 ───────────────────────────

const REPO_ROOT = path.resolve(__dirname, '../..');
const CLOUD_DIR = path.join(REPO_ROOT, 'cloud');
const PY = path.join(
  CLOUD_DIR,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const hasVenv = fs.existsSync(PY);
const BASE = 'http://127.0.0.1:8910';

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

/**
 * 等子进程**真正退出**（最多 `timeoutMs`）。
 *
 * 不能只 `kill()` 就删库：Windows 上被 kill 的 uvicorn 仍可能短暂持有 SQLite 文件句柄，
 * `fs.rmSync` 随即抛 `EBUSY: resource busy or locked` → **用例全过、suite 级红**。先等
 * `exit` 事件（或进程已退出）再删，即可消除该竞态（与 `sessionEventsSync.test.ts` 同款硬化）。
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
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-it-'));
  // Windows 路径统一成正斜杠，拼出 `sqlite:///<abs>/it.db`
  const dbFile = path.join(dbDir, 'it.db').replace(/\\/g, '/');
  server = spawn(PY, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8910'], {
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

/** 注册一个新用户并返回（两台「设备」共用同一账户 = 同 user）。 */
async function registerUser(): Promise<SyncAccount> {
  const account = createMemorySyncAccount({ baseUrl: BASE });
  const email = `it-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await account.register(email, 'password123');
  return account;
}

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
  });
}

/** 当前 ISO 时间（客户端上报值）；服务端落库时会归一为接收时刻（C2）。 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 真实等待若干毫秒，保证两次 push 的「服务端接收时刻」严格递增。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keyedAgents(list: readonly Agent[]): Array<{ id: string; name: string; enabled: boolean }> {
  return [...list]
    .map((a) => ({ id: a.id, name: a.name, enabled: a.enabled }))
    .sort((x, y) => x.id.localeCompare(y.id));
}

function sessionById(id: string): Session | undefined {
  return useSessionsStore.getState().sessions.find((s) => s.id === id);
}

// 每台设备一份独立的内存事件存储（批次 5 §2.5）；每个用例重建，互不串扰。
let devA: Device;
let devB: Device;

beforeEach(() => {
  resetSyncStatus();
  devA = makeDevice(DEV_A_WS);
  devB = makeDevice(DEV_B_WS);
  activateDevice(devA);
});

afterAll(() => {
  __setEventStoreForTest(null);
});

// ─────────────────────────── 门禁① ───────────────────────────

describe.skipIf(!hasVenv)('门禁①：两端登录同账户后 Agent / 会话双向一致', () => {
  it('A 置数据 → B 空装拉取一致 → B 改 → A 换回拿到 B 改动；全程 synced', async () => {
    const account = await registerUser();
    const engineA = buildEngine(account);
    const engineB = buildEngine(account);

    // —— 设备 A：置入 agents + 两个会话 ——
    activateDevice(devA);
    useAgentsStore.setState({
      agents: [makeAgent('a1', { name: 'A1' }), makeAgent('a2', { name: 'A2', enabled: false })],
      tombstones: {},
    });
    useSessionsStore.setState({
      sessions: [
        makeSession('s1', { title: '会话一', pinned: true }),
        makeSession('s2', { title: '会话二', pinned: false }),
      ],
      activeId: null,
      sessionTombstones: {},
    });
    const aAgentsBefore = keyedAgents(useAgentsStore.getState().agents);

    await engineA.syncNow();
    expect(getSyncStatus().status, 'A 首同步应 synced').toBe('synced');
    captureDevice(devA);

    // —— 设备 B：空装 → 拉取 ——
    activateDevice(devB);
    await engineB.syncNow();
    expect(getSyncStatus().status, 'B 首同步应 synced').toBe('synced');

    // B 的 agents 与 A 键控一致
    expect(keyedAgents(useAgentsStore.getState().agents)).toEqual(aAgentsBefore);

    // B 含 A 的会话，title / pinned 一致
    const bS1 = sessionById('s1');
    const bS2 = sessionById('s2');
    expect(bS1?.title).toBe('会话一');
    expect(bS1?.pinned).toBe(true);
    expect(bS2?.title).toBe('会话二');
    expect(bS2?.pinned).toBe(false);
    // streamWorkdir 已重定向为【本机(B)】默认；workdir（语义）保留对端值
    expect(bS1?.streamWorkdir, 'B 侧 streamWorkdir 应为 B 本机默认').toBe(DEV_B_WS);
    expect(bS1?.workdir, 'workdir 语义值应保留').toBe('/remote/path');

    // —— 设备 B 改：建 a3 + 重命名会话 ——
    useAgentsStore.setState((s) => ({
      agents: [...s.agents, makeAgent('a3', { name: 'A3', updatedAt: nowIso() })],
      tombstones: s.tombstones,
    }));
    useSessionsStore.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === 's1'
          ? { ...x, title: '重命名', rev: (x.rev ?? 1) + 1, updatedAt: nowIso() }
          : x,
      ),
      activeId: s.activeId,
      sessionTombstones: s.sessionTombstones,
    }));
    await engineB.syncNow();
    expect(getSyncStatus().status, 'B 改动同步应 synced').toBe('synced');

    // —— 设备 A：换回快照 → 拉取 B 的改动 ——
    activateDevice(devA);
    await engineA.syncNow();
    expect(getSyncStatus().status, 'A 回同步应 synced').toBe('synced');

    expect(
      useAgentsStore.getState().agents.find((a) => a.id === 'a3')?.name,
      'A 应拿到 B 新建的 a3',
    ).toBe('A3');
    expect(sessionById('s1')?.title, 'A 应拿到 B 的重命名').toBe('重命名');

    // —— C2 关键断言：空闲同步（源集合未变）后仍 synced，无自冲突 ——
    const idle = await engineA.syncNow();
    expect(getSyncStatus().status, 'C2：空闲同步必须仍 synced（无自冲突）').toBe('synced');
    expect(idle.conflicts, '空闲同步不得产生冲突').toBe(0);
    expect(getSyncStatus().conflictCount, '冲突计数应保持 0').toBe(0);
  }, 40000);
});

// ─────────────────────────── 门禁② ───────────────────────────

describe.skipIf(!hasVenv)('门禁②：离线改 → 联网 → 合并无丢失', () => {
  it('A 离线新增 aX、B 在线新增 aY → 联网后两端并集都在；并发改 LWW 收敛且不消失', async () => {
    const account = await registerUser();

    // A 的 fetch 可切换断网；B 恒在线
    let aOnline = true;
    const realFetch = globalThis.fetch;
    const fetchA: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!aOnline) throw new TypeError('network down (simulated)');
      return realFetch(input, init);
    }) as unknown as typeof fetch;
    const engineA = buildEngine(account, fetchA);
    const engineB = buildEngine(account);

    // —— 基线：A 有一条 a1，同步；B 空装同步拿到 a1 ——
    activateDevice(devA);
    useAgentsStore.setState({ agents: [makeAgent('a1', { name: 'A1' })], tombstones: {} });
    await engineA.syncNow();
    expect(getSyncStatus().status).toBe('synced');
    captureDevice(devA);

    activateDevice(devB);
    await engineB.syncNow();
    expect(useAgentsStore.getState().agents.find((a) => a.id === 'a1')).toBeTruthy();
    captureDevice(devB);

    // —— A 离线：新增 aX（同步失败，本地保留） ——
    activateDevice(devA);
    aOnline = false;
    useAgentsStore.setState((s) => ({
      agents: [...s.agents, makeAgent('aX', { name: 'AX', updatedAt: nowIso() })],
      tombstones: s.tombstones,
    }));
    await engineA.syncNow();
    expect(getSyncStatus().status, 'A 离线同步应 offline').toBe('offline');
    expect(useAgentsStore.getState().agents.find((a) => a.id === 'aX')).toBeTruthy();
    captureDevice(devA);

    // —— B 在线：新增 aY 并推上 ——
    activateDevice(devB);
    useAgentsStore.setState((s) => ({
      agents: [...s.agents, makeAgent('aY', { name: 'AY', updatedAt: nowIso() })],
      tombstones: s.tombstones,
    }));
    await engineB.syncNow();
    expect(getSyncStatus().status, 'B 同步应 synced').toBe('synced');
    captureDevice(devB);

    // —— A 联网：拉 aY + 推 aX ——
    activateDevice(devA);
    aOnline = true;
    await engineA.syncNow();
    expect(getSyncStatus().status, 'A 恢复联网同步应 synced').toBe('synced');
    const aIds = useAgentsStore.getState().agents.map((a) => a.id).sort();
    expect(aIds, 'A 联网后应同时有 aX 与 aY（并集不丢）').toEqual(['a1', 'aX', 'aY']);
    captureDevice(devA);

    // —— B 同步：也应同时有 aX 与 aY ——
    activateDevice(devB);
    await engineB.syncNow();
    const bIds = useAgentsStore.getState().agents.map((a) => a.id).sort();
    expect(bIds, 'B 同步后应同时有 aX 与 aY').toEqual(['a1', 'aX', 'aY']);
    captureDevice(devB);

    // —— 并发改同一实体 a1：B 的 updatedAt 更新 → 两端收敛到 B，且 a1 不消失 ——
    // A 基于合并态改成 A-edit（较早）
    activateDevice(devA);
    useAgentsStore.setState((s) => ({
      agents: s.agents.map((a) =>
        a.id === 'a1' ? { ...a, name: 'A-edit', rev: (a.rev ?? 1) + 1, updatedAt: nowIso() } : a,
      ),
      tombstones: s.tombstones,
    }));
    await engineA.syncNow();
    captureDevice(devA);

    // B 基于同一合并态改成 B-edit（更晚 → LWW 应胜）；先等一会，确保服务端接收时刻严格递增
    activateDevice(devB);
    await sleep(20);
    useAgentsStore.setState((s) => ({
      agents: s.agents.map((a) =>
        a.id === 'a1' ? { ...a, name: 'B-edit', rev: (a.rev ?? 1) + 1, updatedAt: nowIso() } : a,
      ),
      tombstones: s.tombstones,
    }));
    await engineB.syncNow();
    captureDevice(devB);

    // A 拉 B 的更新 → 收敛到 B-edit，a1 仍在
    activateDevice(devA);
    await engineA.syncNow();
    const a1 = useAgentsStore.getState().agents.find((a) => a.id === 'a1');
    expect(a1, 'a1 不应消失').toBeTruthy();
    expect(a1?.name, 'LWW 应收敛到更新的 B 版本').toBe('B-edit');

    activateDevice(devB);
    await engineB.syncNow();
    expect(useAgentsStore.getState().agents.find((a) => a.id === 'a1')?.name).toBe('B-edit');
  }, 60000);
});
