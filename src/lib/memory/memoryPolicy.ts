/**
 * 策略解析：把**持久化的用户偏好**（`Settings.memoryPolicy`）翻成纯函数要的**参数**。
 *
 * ## 为什么要有这一层
 *
 * 纯函数（`distillFacts` / `buildInjectionBlock` / `runArchive`）刻意只接受显式参数，
 * 不读全局状态——那是它们能离线测、能确定性重放的前提（NFR-M1 / NFR-M12）。
 * 但用户能在设置页调这些门槛，于是必须有人把偏好翻成参数。
 *
 * 这一层就是那个「有人」：**唯一**读取 settings 的地方，且只做一次纯映射。
 * 于是：
 * - 调用方不需要各自记得「预算从哪来」（漏掉一处就会用上出厂默认值，看起来完全正常）；
 * - 纯函数仍然不知道 `Settings` 的存在；
 * - 归一化（区间、类型）只有一处，与迁移期用的是同一个函数。
 */

import type { ArchivePolicy } from '@/lib/memory/memoryArchive';
import type { DistillPolicy, MemoryPolicySettings } from '@/types';
import { DEFAULT_MEMORY_POLICY, normalizeMemoryPolicy } from '@/types';
import { DEFAULT_DISTILL_POLICY } from '@/lib/memory/memoryDistill';
import { DEFAULT_INJECTION_BUDGET, type InjectionBudget } from '@/lib/memory/memoryInjection';

/** 记忆 v2 的全部运行时参数（由一份策略推导出来） */
export interface ResolvedMemoryPolicy {
  distill: DistillPolicy;
  budget: InjectionBudget;
  archive: ArchivePolicy;
  /** 原始策略（设置页回显用） */
  settings: MemoryPolicySettings;
}

/**
 * 由策略设置推导运行时参数。
 *
 * 缺省（`undefined`）走出厂默认值：老用户升级后、以及测试夹具里都可能没有这个字段。
 * 传入非法值时先归一化——**必须**经过 `normalizeMemoryPolicy` 而不是直接用，
 * 否则一个被手工改坏的持久化文件会让门槛变成 NaN 并静默失效。
 */
export function resolveMemoryPolicy(
  policy: Partial<MemoryPolicySettings> | null | undefined,
): ResolvedMemoryPolicy {
  const normalized = normalizeMemoryPolicy(policy ?? DEFAULT_MEMORY_POLICY);
  return {
    distill: {
      ...DEFAULT_DISTILL_POLICY,
      retentionDays: normalized.retentionDays,
      minImportance: normalized.minImportance,
      repeatThreshold: normalized.repeatThreshold,
      supersessionRepeatThreshold: normalized.supersessionRepeatThreshold,
    },
    budget: {
      ...DEFAULT_INJECTION_BUDGET,
      userChars: normalized.userChars,
      workspaceChars: normalized.workspaceChars,
      recentFactLimit: normalized.recentFactLimit,
    },
    archive: {
      // `verifyFactAge` 保持默认（true）：它是正确性开关，不是用户偏好
      archiveAfterDays: normalized.archiveAfterDays,
      verifyFactAge: true,
    },
    settings: normalized,
  };
}
