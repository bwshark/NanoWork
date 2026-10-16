/**
 * serve 重启的统一入口（FR-13.3）。
 *
 * **修的是一个真 bug**：`main.ts` 里「改配置 → 重启 serve」的三处（MCP / 模型+工具策略 /
 * 技能覆盖）都是同一段复制粘贴——
 *
 * ```ts
 * stopNanobot();
 * await waitForPortFree(host, port, 5000);   // ← 返回值被丢弃
 * await startNanobot();                       // ← 超时了也照样启动
 * ```
 *
 * `waitForPortFree` 的返回值没人看，于是端口没释放时仍然启动，必然 `EADDRINUSE`
 * （winerror 10048）。现象极具迷惑性：配置明明写进磁盘了，界面却没有任何反应，
 * 用户会以为「开关没生效」，实际是引擎根本没起来。
 *
 * **为什么抽成模块**：三处复制粘贴意味着修 bug 要改三遍、漏一遍就复发；
 * 而「端口没释放时不许启动」这条规则必须可测——它正是那个 bug 的判据。
 */

import type { ModelsSyncResult } from '../src/platform/types';

/** 等待旧 serve 释放端口的上限（毫秒）。与原三处硬编码的 5000 一致 */
export const SERVE_PORT_RELEASE_TIMEOUT_MS = 5000;

/** serve 重启所需的全部外部能力，由 `main.ts` 注入（这里不碰 Electron / 全局态） */
export interface ServeRestartDeps {
  /** 停止本进程托管的 serve */
  stopServe: () => void;
  /** 等待端口释放；超时返回 false */
  waitPortFree: (timeoutMs: number) => Promise<boolean>;
  /** 重新拉起 serve */
  startServe: () => Promise<boolean>;
  /** serve 重启后是否仍在本进程托管（由 startServe 置位） */
  isServeRunning: () => boolean;
}

/**
 * 重启 serve，并把结果收敛成对用户可读的一句话。
 *
 * @param doneMessage 「已经写进磁盘」的那句主文案，由调用方按自己动了哪一段给
 *   （如「MCP 配置已写入 config.json.tools.mcpServers」），收尾只负责补上
 *   「serve 已重启 / 未重启 / 重启失败」这半句。
 */
export async function restartServe(
  doneMessage: string,
  deps: ServeRestartDeps,
): Promise<ModelsSyncResult> {
  deps.stopServe();

  // 端口仍未释放：**绝不盲启动**。旧进程还占着端口，此刻 startServe() 只会撞
  // EADDRINUSE，而且会把「重启失败」伪装成「配置没生效」——用户无从判断。
  const portFreed = await deps.waitPortFree(SERVE_PORT_RELEASE_TIMEOUT_MS);
  if (!portFreed) {
    return {
      ok: false,
      message: `${doneMessage}，但旧网关端口未释放，serve 未重启，请检查 nanowork 日志`,
    };
  }

  await deps.startServe();
  if (deps.isServeRunning()) {
    return { ok: true, message: `${doneMessage}，serve 已重启生效` };
  }
  return {
    ok: false,
    message: `${doneMessage}，但 serve 重启失败，请检查 nanowork 日志`,
  };
}
