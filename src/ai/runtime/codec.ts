/**
 * 引擎配置编解码（D1）。
 *
 * 为什么单独一个文件：nanobot 的配置模型用 pydantic `alias_generator=to_camel`
 * 生成 camelCase 键，但历史数据 / 引擎回写路径上会出现 snake_case，且飞书实例
 * 身份字段存在同样的漂移。此前这些「两种键名都试一遍」的防御逻辑散落在
 * channels / config 两处，属于同一个知识被抄了两遍。
 *
 * 按第 8 章 8.2 的布局，**键名归一统一收口到这里**：`nanobotHttp/` 下其它模块
 * 只调用本文件的读取器，不再各自实现 `??` 兜底。
 *
 * 命名约定：`read*` 为读侧（容错、缺省安全），`putIf*` 为写侧（非空才写）。
 */

/** 读侧：从条目中取第一个非空字符串（按给定键名顺序尝试，兼容 camelCase / snake_case） */
export function readStr(
  entry: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = entry[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/**
 * 读侧：取布尔字段（按给定键名顺序尝试）。
 * 非布尔值一律视为缺失——不做 `!!v` 强转，避免把 `"false"` 这类字符串
 * 误判为 true（引擎回写的都是真布尔，出现字符串说明数据已被外部改坏，
 * 此时回退到缺省语义比猜更安全）。
 */
export function readBool(
  entry: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const v = entry[key];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

/**
 * 读侧：取字符串白名单数组（兼容 `allowFrom` / `allow_from`）。
 * 非数组、或元素非字符串一律丢弃——白名单是安全边界，宁可少收不可猜。
 */
export function readStrArray(entry: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const v = entry[key];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

/**
 * 读侧：取枚举字符串字段，值不在允许集合内时返回 undefined。
 * @param allowed 合法取值集合
 */
export function readEnum<T extends string>(
  entry: Record<string, unknown>,
  allowed: readonly T[],
  ...keys: string[]
): T | undefined {
  const v = readStr(entry, ...keys);
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/**
 * 写侧：仅在值非空（非 undefined / null / 空串）时写入。
 * 避免把空串写进引擎配置，覆盖掉引擎侧手工填的值或默认值。
 */
export function putIf(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value === undefined || value === null || value === '') return;
  target[key] = value;
}

/**
 * 解析 stdio 启动命令为 token 列表：空格分隔，双引号包裹的段
 * （含内部空格）视为单个 arg，引号本身去掉。
 * 例：`a "b c" d` → ['a', 'b c', 'd']。
 */
export function parseCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

/**
 * 写侧：把 token 列表还原为命令行字符串，含空白字符的 arg 用双引号包裹
 * （与 `parseCommand` 互逆，保证「读→写」往返不丢空格）。
 */
export function joinCommand(tokens: string[]): string {
  return tokens.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' ');
}
