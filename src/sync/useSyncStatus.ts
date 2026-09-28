/**
 * 同步状态：**vanilla store + React hook 分离**。
 *
 * ## 为什么拆开
 *
 * `SyncEngine` 是渲染层里**不 import React** 的一小块核心逻辑（只有 `setSyncStatus`
 * 被它用到）。若把状态直接做成 `zustand` 的 React store，引擎就被拖进 React 依赖；
 * 而引擎的职责是 HTTP + 落地，与渲染无关。所以：
 * - **vanilla 部分**（`getSyncStatus` / `setSyncStatus` / `resetSyncStatus` /
 *   `subscribeSyncStatus`）：零 React 依赖，引擎与单测直接用；
 * - **hook**（`useSyncStatus`）：唯一的 React 触点，经 `useSyncExternalStore` 订阅。
 *
 * ## 快照必须是稳定引用
 *
 * `useSyncExternalStore` 在快照引用变化时才重渲染。`setSyncStatus` 每次都产出一个新
 * 对象（合并补丁），因此只在**真的调用过** `setSyncStatus` 时才触发订阅者——不会被
 * 频繁的相等值刷屏。
 */

import { useSyncExternalStore } from 'react';
import type { SyncStatus } from './types';

/** 同步状态快照（Banner / 设置页「账户」分区消费）。 */
export interface SyncStatusState {
  status: SyncStatus;
  /** 最近一次成功同步的时刻（ISO）；从未成功为 `null` */
  lastSyncedAt: string | null;
  /** 待上行变更数（本批恒为 0，预留） */
  pendingCount: number;
  /** 已记录的冲突快照数（引擎内存上限 50） */
  conflictCount: number;
  /** 最近一次失败原因；无失败为 `null` */
  lastError: string | null;
}

function initialState(): SyncStatusState {
  return {
    status: 'local',
    lastSyncedAt: null,
    pendingCount: 0,
    conflictCount: 0,
    lastError: null,
  };
}

let state: SyncStatusState = initialState();

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

/** 读当前快照（引用稳定，直到下一次 `setSyncStatus` / `resetSyncStatus`）。 */
export function getSyncStatus(): SyncStatusState {
  return state;
}

/** 合并补丁并通知订阅者。 */
export function setSyncStatus(patch: Partial<SyncStatusState>): void {
  state = { ...state, ...patch };
  emit();
}

/** 回到初始态（登出 / 用例隔离）。 */
export function resetSyncStatus(): void {
  state = initialState();
  emit();
}

/** 订阅状态变化；返回取消订阅函数。 */
export function subscribeSyncStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook：订阅同步状态快照。 */
export function useSyncStatus(): SyncStatusState {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);
}
