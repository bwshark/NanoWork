/**
 * 回退链的纯逻辑（FR-9.4 的「回退链」那一半）。
 *
 * ## 为什么「链」是**有序**的、并且整链替换
 *
 * 引擎侧 `agents.defaults.fallbackModels` 是一个**列表**：主模型失败后按顺序
 * 依次尝试，第一个成功就停（`nanobot/providers/factory.py::make_provider` 把
 * 主 provider 包进 `FallbackProvider`）。所以顺序本身就是语义——「把 A 提到 B
 * 前面」是一次有意义的编辑，而不是排版。这也是主进程那条变更指令用
 * **整链替换**而不是逐条增删的原因：逐条会让「上移一格」变成两次写盘，中间态
 * 还可能短暂出现自引用。
 *
 * ## 一条必须挡住的硬约束
 *
 * 引擎在**配置加载时**校验回退链的每一项都指向存在的预设
 * （`nanobot/config/schema.py::Config._validate_model_preset`），不满足就抛
 * `ValueError` —— 那不是「这一条回退失效」，而是**整份配置加载失败、网关起不来**。
 * 所以链里存在「引用了已删除预设」的项时，界面必须**拦住保存**（`blocking`），
 * 而不是提示一下了事。主进程侧的删除 / 改名分支也会同步维护这些引用
 * （`mergeModelMutationIntoConfig`），两处是同一约束的两道闸。
 */

import { modelProviderLabel } from '@/lib/modelProviders';
import type { NanobotFallbackCandidate, ProviderRetryMode } from '@/platform/types';

/** 描述回退链所需的最小预设信息（`ManagedModel` 结构上满足它，此处刻意不 import store） */
export interface FallbackPresetInfo {
  name: string;
  model: string;
  providerLabel: string;
}

export interface ProviderRetryModeOption {
  value: ProviderRetryMode;
  label: string;
  /** 文案对着引擎实际行为写，不是概括：见 `providers/base.py` 的重试循环 */
  description: string;
}

/**
 * 重试模式的两个档位。
 *
 * 描述逐条对着引擎实现写下来，避免「持久听起来更好所以默认选它」——
 * 两档的真实差别是**放弃时机**，而它对无人值守的任务很关键：
 * - `standard`：`_CHAT_RETRY_DELAYS = (1, 2, 4)`，`attempt > len(delays)` 即放弃，
 *   交给回退链；
 * - `persistent`：延迟上限 `_PERSISTENT_MAX_DELAY = 60`，只在连续
 *   `_PERSISTENT_IDENTICAL_ERROR_LIMIT = 10` 次**完全相同**的瞬时错误后停止。
 */
export const PROVIDER_RETRY_MODE_OPTIONS: readonly ProviderRetryModeOption[] = [
  {
    value: 'standard',
    label: '标准',
    description: '瞬时错误按 1s / 2s / 4s 退避重试，4 次仍失败即交给回退链。日常交互用这一档。',
  },
  {
    value: 'persistent',
    label: '持久',
    description:
      '一直重试（单次等待上限 60s），只有连续 10 次完全相同的瞬时错误才放弃。适合无人值守的长任务：服务端抖动不该让任务当场失败。',
  },
];

/** 引擎缺省（`provider_retry_mode: Literal["standard","persistent"] = "standard"`） */
export const DEFAULT_PROVIDER_RETRY_MODE: ProviderRetryMode = 'standard';

export function providerRetryModeOption(mode: ProviderRetryMode): ProviderRetryModeOption {
  return (
    PROVIDER_RETRY_MODE_OPTIONS.find((o) => o.value === mode) ?? PROVIDER_RETRY_MODE_OPTIONS[0]!
  );
}

/** 链上某一环的展示形态 */
export interface FallbackView {
  /** 链上位置，1 起（直接渲染，别在组件里再算一遍） */
  position: number;
  candidate: NanobotFallbackCandidate;
  /** 主文案 */
  label: string;
  /** 副文案：预设解析出来的模型与供应商，或内联项自己的供应商 */
  hint: string;
  /**
   * 引用的预设仍在预设表里 → true。
   *
   * 内联项**恒为 true**：它自带 `model` + `provider`，不依赖预设表，
   * 所以「内联一条」永远不会因为别人删预设而失效。
   */
  resolved: boolean;
}

/** 内联项在副文案里的标记（与「引用了预设」区分开，否则两种来源长得一样） */
const INLINE_MARK = '内联配置';

/**
 * 回退链 → 展示形态。
 *
 * `presets` 传预设表的**全量**（不是只传链里出现过的）：链里可能引用了一个
 * 已经不存在的预设，那种情况必须能被看见（`resolved: false`），而不是显示成空白。
 */
export function describeFallbacks(
  list: readonly NanobotFallbackCandidate[],
  presets: readonly FallbackPresetInfo[],
): FallbackView[] {
  const byName = new Map(presets.map((p) => [p.name, p]));
  return list.map((candidate, index) => {
    const position = index + 1;
    if (candidate.kind === 'inline') {
      return {
        position,
        candidate,
        label: candidate.model,
        hint: `${modelProviderLabel(candidate.provider)} · ${INLINE_MARK}`,
        resolved: true,
      };
    }
    const info = byName.get(candidate.preset);
    return {
      position,
      candidate,
      label: candidate.preset,
      hint: info ? `${info.model} · ${info.providerLabel}` : '该预设已不存在',
      resolved: Boolean(info),
    };
  });
}

export type FallbackIssueKind = 'unresolved' | 'duplicate' | 'primary';

export interface FallbackIssue {
  kind: FallbackIssueKind;
  /** 链上位置（1 起）。`duplicate` 指向**后出现的那一项** */
  position: number;
  message: string;
  /**
   * `true` = 保存会写出一个**引擎拒绝加载**的配置，必须挡住保存；
   * `false` = 写得出来但没意义（重复项 / 回退到主模型本身），提示即可。
   */
  blocking: boolean;
}

/** 链上某一环的判重键：预设引用与内联配置各自成域，互不冲突 */
function dedupeKey(candidate: NanobotFallbackCandidate): string {
  return candidate.kind === 'preset'
    ? `preset:${candidate.preset}`
    : `inline:${candidate.model}\u0000${candidate.provider}`;
}

/**
 * 链上的问题清单（**只报问题，不改数据**）。
 *
 * 三类的差别是刻意的，别把它们统一成同一档：
 * - `unresolved` → **blocking**：引擎配置加载会失败，网关起不来；
 * - `duplicate` → 提示：多一条重复的回退，只是白等一次；
 * - `primary` → 提示：回退到主模型本身没有意义，但它**不是**错误——
 *   会话级模型覆盖（FR-9.2）意味着「主模型」会随会话变，今天没意义的项
 *   在另一个会话里可能就有意义。所以只按**默认预设**给一句提醒。
 *
 * @param presetNames 预设表里的全部名字
 * @param primaryPreset 默认预设名；`null` 表示走隐式 default 预设，此时不判断 primary
 */
export function fallbackIssues(args: {
  list: readonly NanobotFallbackCandidate[];
  presetNames: readonly string[];
  primaryPreset: string | null;
}): FallbackIssue[] {
  const { list, presetNames, primaryPreset } = args;
  const known = new Set(presetNames);
  const seenAt = new Map<string, number>();
  const issues: FallbackIssue[] = [];

  list.forEach((candidate, index) => {
    const position = index + 1;

    if (candidate.kind === 'preset' && !known.has(candidate.preset)) {
      issues.push({
        kind: 'unresolved',
        position,
        blocking: true,
        message: `第 ${position} 项引用的预设「${candidate.preset}」已不存在。引擎在配置加载时会因此拒绝整份配置（网关起不来），请先移除或换成别的预设。`,
      });
    }

    const key = dedupeKey(candidate);
    const first = seenAt.get(key);
    if (first === undefined) {
      seenAt.set(key, position);
    } else {
      issues.push({
        kind: 'duplicate',
        position,
        blocking: false,
        message: `第 ${position} 项与第 ${first} 项重复，主模型失败后不会因为多列一次就更容易成功。`,
      });
    }

    if (
      candidate.kind === 'preset' &&
      primaryPreset !== null &&
      candidate.preset === primaryPreset
    ) {
      issues.push({
        kind: 'primary',
        position,
        blocking: false,
        message: `第 ${position} 项就是默认模型「${primaryPreset}」本身——它已经失败过一次了，回退到它没有意义。`,
      });
    }
  });

  return issues;
}

/** 有没有必须挡住保存的问题（引用了不存在的预设） */
export function hasBlockingIssues(issues: readonly FallbackIssue[]): boolean {
  return issues.some((issue) => issue.blocking);
}

/** 链里已经引用到的预设名（「添加」下拉据此去重，从源头不产生 duplicate） */
export function chainedPresetNames(list: readonly NanobotFallbackCandidate[]): string[] {
  return list.flatMap((c) => (c.kind === 'preset' ? [c.preset] : []));
}

/** 追加一环；`preset` 已在链上或为空则**原样返回**（不制造重复项） */
export function addFallbackPreset(
  list: readonly NanobotFallbackCandidate[],
  preset: string,
): NanobotFallbackCandidate[] {
  const name = preset.trim();
  if (!name || chainedPresetNames(list).includes(name)) return [...list];
  return [...list, { kind: 'preset', preset: name }];
}

/** 摘掉第 `index` 环（越界则原样返回） */
export function removeFallbackAt(
  list: readonly NanobotFallbackCandidate[],
  index: number,
): NanobotFallbackCandidate[] {
  if (index < 0 || index >= list.length) return [...list];
  return [...list.slice(0, index), ...list.slice(index + 1)];
}

/**
 * 把第 `index` 环上移 / 下移一格（`delta` 取 -1 / +1）。
 *
 * 到头了就**原样返回**，不做环绕：环绕会让「再点一次上移」把第一项甩到最后，
 * 而用户点它是想把它往上顶到头。返回新数组（调用方按引用变化决定要不要落盘）。
 */
export function moveFallback(
  list: readonly NanobotFallbackCandidate[],
  index: number,
  delta: -1 | 1,
): NanobotFallbackCandidate[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}
