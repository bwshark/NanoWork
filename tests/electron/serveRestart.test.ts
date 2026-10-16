/**
 * serve 重启统一入口（FR-13.3）。
 *
 * **核心用例是第 2 条**：端口未释放时**绝不允许启动**。这正是原实现的 bug——
 * 三处调用点都丢弃了 `waitForPortFree` 的返回值，超时后照样 `startNanobot()`，
 * 必然 EADDRINUSE，而界面表现是「配置写了但没生效」，用户无从判断。
 *
 * 变异验证：把 `if (!portFreed) return …` 那段删掉，用例 2 的
 * `startServe` 未调用断言必须变红。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  restartServe,
  SERVE_PORT_RELEASE_TIMEOUT_MS,
  type ServeRestartDeps,
} from '../../electron/serveRestart';

function createDeps(overrides: Partial<ServeRestartDeps> = {}) {
  const calls: string[] = [];
  const deps: ServeRestartDeps = {
    stopServe: () => {
      calls.push('stop');
    },
    waitPortFree: async (timeoutMs) => {
      calls.push(`wait:${timeoutMs}`);
      return true;
    },
    startServe: async () => {
      calls.push('start');
      return true;
    },
    isServeRunning: () => true,
    ...overrides,
  };
  return { deps, calls };
}

describe('restartServe', () => {
  it('端口释放且重启成功时返回 ok 并说明 serve 已重启', async () => {
    const { deps } = createDeps();

    const result = await restartServe('MCP 配置已写入 config.json.tools.mcpServers', deps);

    expect(result.ok).toBe(true);
    expect(result.message).toBe('MCP 配置已写入 config.json.tools.mcpServers，serve 已重启生效');
  });

  it('端口未释放时绝不启动 serve，并如实说明未重启', async () => {
    const startServe = vi.fn(async () => true);
    const { deps, calls } = createDeps({ waitPortFree: async () => false, startServe });

    const result = await restartServe('模型配置已写入', deps);

    expect(result.ok).toBe(false);
    expect(startServe).not.toHaveBeenCalled();
    expect(calls).not.toContain('start');
    expect(result.message).toBe('模型配置已写入，但旧网关端口未释放，serve 未重启，请检查 nanowork 日志');
  });

  it('端口释放但重启失败时返回 ok:false', async () => {
    const { deps } = createDeps({ isServeRunning: () => false });

    const result = await restartServe('技能覆盖已写入', deps);

    expect(result.ok).toBe(false);
    expect(result.message).toBe('技能覆盖已写入，但 serve 重启失败，请检查 nanowork 日志');
  });

  it('stopServe 一定发生在等待端口释放之前', async () => {
    const { deps, calls } = createDeps();

    await restartServe('x', deps);

    expect(calls).toEqual([`stop`, `wait:${SERVE_PORT_RELEASE_TIMEOUT_MS}`, 'start']);
  });

  it('等待端口释放用固定上限（不由调用方随意改短）', async () => {
    const waitPortFree = vi.fn(async () => true);
    const { deps } = createDeps({ waitPortFree });

    await restartServe('x', deps);

    expect(waitPortFree).toHaveBeenCalledWith(SERVE_PORT_RELEASE_TIMEOUT_MS);
    expect(SERVE_PORT_RELEASE_TIMEOUT_MS).toBe(5000);
  });
});
