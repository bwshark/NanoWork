/**
 * 同步负载的两个共享选择器（design §5.1 / §5.2）。
 *
 * 为什么必须集中而不是各消费方自己写：这两件事一旦分散，漏掉的形态都是**静默**的
 * ——漏过滤墓碑 = 「删不掉的幽灵条目」；漏剔除运行时事实 = 「本机从未探测过、却显示
 * connected」的假状态（与 §12.4.2 那个假连接测试是同一个错误）。
 */

import { isTombstone } from './syncMeta';

/**
 * 过滤墓碑，返回可展示的条目。
 *
 * 删除在同步语义下是「留墓碑」而不是摘除数组项（LWW 要求删除可传播），代价就是
 * **每一个读取处**都要过滤。消费方有十几个，各写一遍 `filter((item) => !item.deletedAt)`
 * 必然漏——漏一处就是一个删不掉的幽灵条目，所以统一从这里走。
 *
 * 容错空值：未水合 / 旧持久化数据里字段缺失时传进来 `undefined`，返回空数组而不是抛错。
 */
export function liveEntities<T extends { deletedAt?: string | null }>(
  list: readonly T[] | undefined | null,
): T[] {
  if (!list || list.length === 0) return [];
  return list.filter((item) => !isTombstone(item));
}

/**
 * 剔除**运行时事实字段**，只留声明（§5.2）。
 *
 * 同一个实体里混着两类东西：声明（`endpoint` / `enabled` / `disabledTools`）该同步，
 * 事实（`status` / `tools` / `lastProbedAt` / `syncStatus`）是本机探测结果、必须本机
 * 重算。把事实同步过去，对端就会显示「从未探测过却已连接」。
 *
 * `omitKeys` 刻意是**显式清单**而不是「猜哪些字段像事实」：这个判断只有写实体的人
 * 知道，而猜错的代价是假状态而不是报错。凭据字段（`clientSecret` / `token` /
 * `auth`）同理进排除清单，是否上行见 `docs/architecture-syncmeta.md` §5.3。
 *
 * 只做浅拷贝；值为 `undefined` 的键原样保留（序列化时自然会丢，这里不替调用方决定）。
 */
export function pickSyncable<T extends object>(
  entity: T,
  omitKeys: readonly string[],
): Partial<T> {
  const omit = new Set(omitKeys);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity)) {
    if (!omit.has(key)) out[key] = value;
  }
  return out as Partial<T>;
}
