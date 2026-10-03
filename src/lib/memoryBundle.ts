/**
 * 导出 / 导入：一份**自包含的 JSON bundle**（FR-M35）。
 *
 * ## 为什么要有它
 *
 * 记忆是用户的长期资产，而它现在分散在两类目录、五种文件里（`daily/*.jsonl` 证据、
 * `curated.json` 结论、`conflicts.json` 待审、两个 journal、`profile.json` 与
 * `preferences.json`）。用户换机器时**没有任何办法把它们带走**——这正是「资产」与
 * 「只存在这台设备上的缓存」的区别。
 *
 * bundle 里放的是 **canonical + 证据**，不放投影：投影随时能从 canonical 重建
 * （不变量 I6），带上它只会让文件大一倍并给「以哪份为准」留下歧义。
 *
 * ## 跨作用域导入必须拒绝
 *
 * bundle 自带 `workspaceId` / `userScope`。导入到不符的作用域时**明确报错**，而不是
 * 静默合并——把 A 项目的结论导进 B 项目是最难排查的一类污染（它看起来完全正常）。
 */

import type {
  AdjudicationEvent,
  ConflictState,
  CuratedState,
  MemoryFact,
  PreferenceState,
  ProfileState,
} from '@/types';

/** bundle 的 schema 版本（与 canonical 的 `schema: 2` 分开编号，便于将来独立演进） */
export const MEMORY_BUNDLE_SCHEMA = 1;

/** 一份自包含的记忆 bundle */
export interface MemoryExportBundle {
  schema: typeof MEMORY_BUNDLE_SCHEMA;
  exportedAt: string;
  /** 导出工具版本（排错时能对上「哪一版导出的」） */
  exportedBy: string;
  /** 归属：导入时校验 */
  workspaceId: string;
  userScope: string;
  /** 证据（daily 日志里的全部事实） */
  facts: MemoryFact[];
  /** 结论（canonical） */
  curated: CuratedState;
  conflicts: ConflictState;
  /** 人工裁决审计流（可重放） */
  adjudications: AdjudicationEvent[];
  /** 用户级两契约 */
  profile: ProfileState;
  preferences: PreferenceState;
}

/** 导入失败的原因 */
export class MemoryBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryBundleError';
  }
}

/** 组装 bundle（纯函数：调用方把已经读出来的内容传进来） */
export function buildExportBundle(input: {
  workspaceId: string;
  userScope: string;
  facts: readonly MemoryFact[];
  curated: CuratedState;
  conflicts: ConflictState;
  adjudications: readonly AdjudicationEvent[];
  profile: ProfileState;
  preferences: PreferenceState;
  now: Date;
  exportedBy?: string;
}): MemoryExportBundle {
  return {
    schema: MEMORY_BUNDLE_SCHEMA,
    exportedAt: input.now.toISOString(),
    exportedBy: input.exportedBy ?? 'nanowork-memory-v2',
    workspaceId: input.workspaceId,
    userScope: input.userScope,
    // 复制数组：bundle 一旦交出就不该再受调用方后续改动影响
    facts: [...(input.facts ?? [])],
    curated: input.curated,
    conflicts: input.conflicts,
    adjudications: [...(input.adjudications ?? [])],
    profile: input.profile,
    preferences: input.preferences,
  };
}

/** 序列化为可保存的文本（稳定缩进，便于人读与 diff） */
export function serializeExportBundle(bundle: MemoryExportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * 解析并校验一份 bundle。
 *
 * 校验五件事，每件都对应一种真实故障：
 * 1. 是 JSON 且是对象（用户可能选错文件）；
 * 2. `schema` 是认识的版本（将来升版时要显式处理，不能当成兼容）；
 * 3. `workspaceId` 与目标工作区一致（否则是跨项目污染）；
 * 4. `userScope` 与目标用户一致（否则是跨用户泄漏）；
 * 5. 必要的集合字段都在且是数组（半截写入 / 手工编辑过的文件）。
 */
export function parseExportBundle(
  text: string,
  expected: { workspaceId?: string; userScope?: string },
): MemoryExportBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MemoryBundleError('不是合法的 JSON（选错文件了？）');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MemoryBundleError('bundle 的顶层必须是一个对象');
  }
  const b = parsed as Partial<MemoryExportBundle>;

  if (b.schema !== MEMORY_BUNDLE_SCHEMA) {
    throw new MemoryBundleError(
      `bundle 的 schema 是 ${String(b.schema)}，本版本只认识 ${MEMORY_BUNDLE_SCHEMA}`,
    );
  }
  for (const field of ['facts', 'adjudications'] as const) {
    if (!Array.isArray(b[field])) throw new MemoryBundleError(`bundle 缺少数组字段 ${field}`);
  }
  if (!b.curated || typeof b.curated !== 'object') {
    throw new MemoryBundleError('bundle 缺少 curated');
  }
  if (typeof b.workspaceId !== 'string' || b.workspaceId === '') {
    throw new MemoryBundleError('bundle 缺少 workspaceId');
  }
  if (typeof b.userScope !== 'string' || b.userScope === '') {
    throw new MemoryBundleError('bundle 缺少 userScope');
  }

  if (expected.workspaceId !== undefined && b.workspaceId !== expected.workspaceId) {
    throw new MemoryBundleError(
      `bundle 属于工作区 ${b.workspaceId}，与当前工作区 ${expected.workspaceId} 不符——` +
        '拒绝导入（跨项目记忆污染比「导不进来」难查得多）',
    );
  }
  if (expected.userScope !== undefined && b.userScope !== expected.userScope) {
    throw new MemoryBundleError(
      `bundle 属于用户作用域 ${b.userScope}，与当前作用域 ${expected.userScope} 不符——拒绝导入`,
    );
  }

  return b as MemoryExportBundle;
}
