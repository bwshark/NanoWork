/**
 * 引擎契约层入口（D1）。
 *
 * 渲染层**唯一**允许 import 的引擎模块就是这里（及其 `./types`）。
 * 任何 `runtime/nanobotHttp/` 下的模块都不得被 UI / store 直接引用——
 * 那等于绕开防腐层，把 nanobot 的 wire 格式又漏回业务代码。
 *
 * 当前只有一个实现（nanobot-http），所以工厂是单例 + 惰性构造。
 * 需要按 settings 切换实现（如未来的 `NanobotAcpRuntime`）时，
 * 收敛点就在这里：只改本文件的 `createRuntime()`，调用方不动。
 */
import { NanobotHttpRuntime } from './nanobotHttp/runtime';
import type { AgentRuntime } from './types';

let instance: AgentRuntime | null = null;

/** 取引擎实现（惰性单例） */
export function getRuntime(): AgentRuntime {
  if (!instance) instance = new NanobotHttpRuntime();
  return instance;
}

/**
 * 仅供测试：替换 / 重置实现。
 * @param next 传入新实现，或 `null` 重置为默认实现
 */
export function __setRuntimeForTest(next: AgentRuntime | null): void {
  instance = next;
}

export * from './types';
