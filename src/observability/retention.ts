/**
 * 诊断产物的保留策略（FR-11.2 / FR-11.3 共用）——**纯决策，不做 IO**。
 *
 * ## 为什么把「判据」和「删除」拆开
 *
 * 清理是这个功能里唯一**不可逆**的动作，而它恰恰又最难测：真删目录要走
 * `fs.rm`，在本机宿主的批量删除守卫下会偶发几十秒的钩子超时（`tests/electron/*`
 * 的既有 flake 就出在这个形态上）。把「该删哪些」抽成纯函数之后：
 *
 * - 决策（边界日、空目录、非本格式名字、`keepDays <= 0`）用纯单测逐条钉住；
 * - IO 只剩「照着名单删」，测试里给两三个目录就够。
 *
 * 这条是项目里反复用过的同一手法（`shouldCollectCopy` / `skillMenuOrigin`）：
 * **能变成纯函数的判据，就不要留在 IO 里**。
 */

/** 一个待清理的目录：名字 + 用于判断年龄的时间戳 */
export interface RetainedDirEntry {
  /** 目录名（日志是 `YYYY-MM-DD`，trace 是 pid） */
  name: string;
  /**
   * 年龄依据（epoch ms），**取哪种由调用方决定**：
   * 日志取目录名对应的本地零点（名字就是「属于哪一天」），trace 取目录内最新文件 mtime
   * （pid 名字里没有时间）。给 0 表示「没有年龄信息」，一律可清。
   */
  newestMs: number;
}

/**
 * 选出可清理的目录名。
 *
 * @param entries 目录清单
 * @param cutoffMs 早于该时刻的目录可清；`<= 0` 表示**不清理**（配置写坏时的安全方向：
 *   宁可占盘，也不能把用户还没导出的日志删掉）
 * @param isValidName 目录名格式校验；不匹配的**一律跳过**（比如用户自己往里放了东西）
 *
 * 空目录（`newestMs === 0`）**可清**：那是上一次清理中途崩了留下的壳子，
 * 留着只会让「打开日志目录」看起来有一堆空文件夹。
 */
export function selectPrunableDirs(
  entries: readonly RetainedDirEntry[],
  cutoffMs: number,
  isValidName: (name: string) => boolean,
): string[] {
  if (!Number.isFinite(cutoffMs) || cutoffMs <= 0) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (!isValidName(e.name)) continue;
    if (e.newestMs === 0 || e.newestMs < cutoffMs) out.push(e.name);
  }
  return out;
}

/**
 * 目录数上限的兜底裁剪：按**最新文件时间**从旧到新裁，直到剩下 `max` 个。
 *
 * 与时间清理是两道闸：时间闸管「多久以前的」，数量闸管「万一某天狂写」。
 * 只留时间闸的话，一次失控的循环能在同一天里堆出成千上万个目录，
 * 而它们全都是「今天的」，一个都不会被清掉。
 */
export function selectOverflowDirs(
  entries: readonly RetainedDirEntry[],
  max: number,
  isValidName: (name: string) => boolean,
): string[] {
  if (!Number.isFinite(max) || max <= 0) return [];
  const valid = entries.filter((e) => isValidName(e.name));
  if (valid.length <= max) return [];
  return [...valid]
    .sort((a, b) => a.newestMs - b.newestMs || a.name.localeCompare(b.name))
    .slice(0, valid.length - max)
    .map((e) => e.name);
}
