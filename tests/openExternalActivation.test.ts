/**
 * 导入会话的**激活语义**（`openExternal` 的 `activate` 选项）。
 *
 * ## 这个缺陷是怎么被发现的
 *
 * 2026-10-21 做 C.5 深链真机验收（`tasks/verify-deeplink.mjs`）时，
 * 冷启动 `nanowork://open-session?id=<目标会话>`：
 *
 *   - 主进程日志：**冷启动深链已解析 → 深链已投递到渲染层 → 深链已执行 → selectSession** ✅
 *   - 但 `active-session.txt` 里落的是**另一个会话 id** ❌
 *
 * 顺时间线找到真凶：定时任务「加油提醒」在 14:42 触发 →
 * `tasksStore.fetchCronRuns`（**后台轮询**，用户没点它）→ `openExternal` →
 * `set({ activeId })` + `rememberActiveSession` → **把深链刚选中的会话顶掉**。
 *
 * ## 为什么这是产品缺陷而不只是验收问题
 *
 * 「后台自动同步」与「用户主动打开」被混成了同一个动作。后果不限于深链：
 * 用户正在看某个会话写东西，定时任务一跑完，当前会话就被切走、
 * 草稿位置也变了——而用户根本没做任何操作。
 *
 * ## 判据锁的不变量
 *
 * 1. `activate: false`（后台路径）→ 会话**进列表**、**不动 activeId**、
 *    **不写** `active-session`（"上次打开的会话"）。
 * 2. `activate: true`（用户主动打开，默认）→ 三者都要变。
 * 3. `tasksStore.fetchCronRuns` 这条后台路径必须传 `activate: false`。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useSessionsStore } from '@/stores/sessionsStore';
import { STORAGE_KEYS } from '@/lib/constants';
import type { Session } from '@/types';

const TARGET = 'deep-link-target';
const CRON = 'cron:api:cron-abc:run-1';

function session(id: string, title: string): Session {
  return {
    id,
    agentId: '',
    channel: 'cron',
    title,
    messages: [],
    permissionLog: [],
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
  };
}

/**
 * 读「上次打开的会话」持久化值。
 *
 * ⚠️ web 平台的 storage 会把值 **JSON 序列化**（`JSON.stringify`），
 * 所以落盘的是 `"abc"`（带引号）而不是 `abc`。桌面端走主进程
 * `storageRoutes` 的 text 路由，存的是裸串——两侧形态不同，这里统一解一次。
 */
function readRemembered(): string | null {
  const raw = localStorage.getItem(STORAGE_KEYS.activeSession);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

describe('openExternal 的激活语义', () => {
  beforeEach(() => {
    localStorage.clear();
    // 复位 store 的内存态（zustand 单例在用例间共享）
    useSessionsStore.setState({ sessions: [], activeId: null });
  });

  it('默认（用户主动打开）→ 切为激活态并记住', () => {
    useSessionsStore.getState().selectSession(TARGET);
    expect(useSessionsStore.getState().activeId).toBe(TARGET);

    useSessionsStore.getState().openExternal(session(CRON, '定时任务执行'));
    expect(useSessionsStore.getState().activeId).toBe(CRON);
    expect(readRemembered()).toBe(CRON);
  });

  it('activate: false（后台同步）→ 进列表但**不抢**激活态，也不改「上次打开」', () => {
    // 先选中用户正在看的会话
    useSessionsStore.getState().selectSession(TARGET);
    expect(useSessionsStore.getState().activeId).toBe(TARGET);

    useSessionsStore.getState().openExternal(session(CRON, '定时任务执行'), {
      activate: false,
    });

    // ① 会话确实进了列表（后台同步的产物要能被用户看到）
    const ids = useSessionsStore.getState().sessions.map((s) => s.id);
    expect(ids).toContain(CRON);
    // ② 但激活态没被抢走
    expect(useSessionsStore.getState().activeId).toBe(TARGET);
    // ③ 「上次打开的会话」也没被改写
    expect(readRemembered()).toBe(TARGET);
  });

  it('activate: false 且当前无激活会话 → 仍然不激活', () => {
    useSessionsStore.setState({ sessions: [], activeId: null });
    useSessionsStore.getState().openExternal(session(CRON, '定时任务执行'), {
      activate: false,
    });
    expect(useSessionsStore.getState().activeId).toBeNull();
    expect(readRemembered()).toBeNull();
  });

  it('activate: false 时同 id 已有会话 → 仍然整体替换（刷新语义不变）', () => {
    useSessionsStore.getState().openExternal(session(CRON, '旧标题'), {
      activate: false,
    });
    useSessionsStore.getState().openExternal(session(CRON, '新标题'), {
      activate: false,
    });
    const found = useSessionsStore.getState().sessions.filter((s) => s.id === CRON);
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe('新标题');
  });
});

/**
 * 静态判据：`tasksStore.fetchCronRuns` 里的 `openExternal` 调用必须带
 * `activate: false`。
 *
 * ## 为什么用静态判据而不是行为判据
 *
 * `fetchCronRuns` 的两个 `openExternal` 调用都在 `await platform.getCronSession()`
 * 之后，要用行为判据就得把引擎侧会话拉取整个 mock 出来（detail.key / messages /
 * createdAt / updatedAt 五个字段）—— mock 成本高，且**改个字段名就会让用例失效**，
 * 判据会随重构漂移。
 *
 * 静态判据直接读源码，钉的是「这条路径不许激活」这个**意图**本身。
 * 代价是它只覆盖文本形态：若将来把 `{ activate: false }` 换成一个变量
 * （`const NO_ACTIVATE = { activate: false }`），判据会红——那是**故意的**：
 * 宁可让用例提醒人回来看一眼，也别让后台抢占悄悄回来。
 */
describe('tasksStore.fetchCronRuns：后台同步不许抢激活态（静态判据）', () => {
  // ⚠️ 不能用 `new URL('../src/...', import.meta.url)`：jsdom 环境下
  // `import.meta.url` 是 http(s) 协议，`fileURLToPath` 直接抛
  // 「The URL must be of scheme file」。改用 cwd 拼绝对路径。
  const repoRoot = process.cwd();
  const tasksStorePath = join(repoRoot, 'src', 'stores', 'tasksStore.ts');
  const source = readFileSync(tasksStorePath, 'utf-8');

  /**
   * 取出 `openExternal(` 每次调用的**实参块**。
   *
   * ⚠️ 不能用正则：`openExternal(cronRecordsToSession(...), { activate: false })`
   * 里嵌套了多层括号，正则的「非贪婪匹配到第一个 `),\n`」会停在
   * `cronRecordsToSession(...)` 的内层括号上，判据就成了假的。
   * 这里做**括号配对扫描**：从 `(` 起，逐字符数括号深度，到深度归零处截断。
   */
  function extractCallArgs(text: string): string[] {
    const marker = 'openExternal(';
    const out: string[] = [];
    let idx = text.indexOf(marker);
    while (idx !== -1) {
      const open = idx + marker.length - 1; // 指向 '('
      let depth = 0;
      let end = open;
      for (let i = open; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      out.push(text.slice(open + 1, end));
      idx = text.indexOf(marker, end);
    }
    return out;
  }

  it('fetchCronRuns 函数体里的每个 openExternal 都带 activate: false', () => {
    // 只取 fetchCronRuns 的函数体（到下一个同缩进的方法定义为止）
    const start = source.indexOf('fetchCronRuns: async () => {');
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const nextMethod = rest.search(/\n {6}[a-zA-Z]+:/);
    const body = nextMethod === -1 ? rest : rest.slice(0, nextMethod);

    const argsList = extractCallArgs(body);
    expect(argsList.length).toBeGreaterThan(0);

    const withoutFlag = argsList.filter((args) => !args.includes('activate: false'));
    expect(
      withoutFlag,
      `fetchCronRuns 里还有 ${withoutFlag.length} 处 openExternal 没带 activate: false：\n${withoutFlag.join('\n---\n')}`,
    ).toHaveLength(0);
  });

  it('全局 cron 轮询器确实会自动调 fetchCronRuns（说明这是后台路径）', () => {
    const pollerPath = join(repoRoot, 'src', 'ai', 'cronRunsPoller.ts');
    const poller = readFileSync(pollerPath, 'utf-8');
    expect(poller).toContain('fetchCronRuns');
    // 应用级 15s 定时器 —— 没有任何用户交互参与
    expect(poller).toContain('setInterval');
  });
});
