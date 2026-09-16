/**
 * 极简语义化版本解析与区间判定（**纯模块**，无 node 依赖）。
 *
 * ## 为什么单独成一个模块
 *
 * 同一套版本规则有**两个产地**：主进程的插件包校验
 * （`electron/pluginPackage.ts` 读 `engines.nanowork`）与渲染层的插件卡片
 * （判断「这个包能不能用」）。写两份必然漂移——症状是「装的时候说可以，
 * 界面上说不兼容」。所以实现放这里，主进程只做再导出。
 *
 * ## 刻意不引 semver 依赖
 *
 * 这里的目标是**拒绝明显不兼容的包**，不是做完整语义实现。支持
 * `*` / 精确 / `>=` `>` `<=` `<` / `^` / `~` / 空格分隔的「与」，
 * 覆盖真实清单里的写法就够。边界写清楚，免得以后有人以为它完备。
 */

/** 解析 `x.y.z`（允许 `v` 前缀与缺省段），非法返回 `null` */
export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** 语义化比较：`a < b` → 负；`a === b` → 0；`a > b` → 正。非法版本按 `0.0.0` 处理。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a) ?? [0, 0, 0];
  const right = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 判断版本是否满足区间。
 *
 * 空串与 `*` 都视为**无约束**（清单没写 = 不限制，而不是「都不满足」）。
 * 无法解析的子句判**不满足**：宁可少装一个包，也不要让一个说不清要求的包
 * 混进来（区间是限制性声明，宽松解读会撤销作者的限制）。
 */
export function satisfiesRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed || trimmed === '*') return true;

  return trimmed
    .split(/\s+/)
    .filter(Boolean)
    .every((clause) => satisfiesClause(version, clause));
}

function satisfiesClause(version: string, clause: string): boolean {
  const match = /^(>=|<=|>|<|\^|~|=)?\s*v?(.+)$/.exec(clause);
  if (!match) return false;
  const operator = match[1] ?? '=';
  const target = (match[2] ?? '').trim();
  const targetParts = parseVersion(target);
  if (targetParts === null) return false;

  const cmp = compareVersions(version, target);
  switch (operator) {
    case '>=':
      return cmp >= 0;
    case '>':
      return cmp > 0;
    case '<=':
      return cmp <= 0;
    case '<':
      return cmp < 0;
    case '^':
    case '~': {
      // `^1.2.3` → >=1.2.3 <2.0.0；`~1.2.3` → >=1.2.3 <1.3.0
      if (cmp < 0) return false;
      const [major, minor] = targetParts;
      const upper = operator === '^' ? [major + 1, 0, 0] : [major, minor + 1, 0];
      const current = parseVersion(version) ?? [0, 0, 0];
      return compareVersions(current.join('.'), upper.join('.')) < 0;
    }
    default:
      return cmp === 0;
  }
}
