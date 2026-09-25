/**
 * 各实体的**云端同步负载**裁剪（design §5.2 / §5.3）。
 *
 * ## 与「提交给引擎的负载」是两件事，别混
 *
 * - **引擎负载**（`channelsStore.syncAll` → `toNanobotChannels`）：必须**带凭据**，
 *   引擎靠它连 IM。少一个 `appSecret` 就是渠道不可用。
 * - **云端同步负载**（本文件）：必须**剔除凭据**与运行时事实。凭据是「本机的授权」，
 *   上行即等于把渠道密钥发到云端（§5.3 已定案不上行）；运行时事实（`syncStatus` /
 *   `lastSyncAt`）同步过去只会得到「本机从未同步过却显示已同步」的假状态。
 *
 * 两条路径的字段清单**重叠但不相同**，所以各自一处显式声明，不共用一个排除表。
 *
 * ## 为什么是显式清单而不是「猜哪些字段像凭据」
 *
 * 判断只有写实体的人知道，猜错的代价是**静默**的：多剔一个字段只是少同步一点
 * （可察觉），少剔一个字段是把密钥发出去（不可察觉）。所以这里一律宁可多剔。
 */

import { pickSyncable } from './syncSelect';
import type { ChannelConfig } from '@/types';

/**
 * 渠道配置的**非同步字段**。
 *
 * 两类：
 *
 * 1. **运行时事实**（§5.2）——`syncStatus` / `lastSyncAt` 是本机同步结果，对端重算；
 * 2. **凭据成组**（§5.3）——不只是 `clientSecret` / `appSecret` / `botSecret` /
 *    `token` 四个密钥，连 `clientId` / `appId` / `botId` 一起剔。理由：id 与 secret
 *    是**同一个凭据对**，只留 id 会同步出一条「看着配好了、实际连不上」的渠道，
 *    而用户在界面上根本看不出差在哪——这比什么都不留更难查。
 *
 * 保留的是**意图**：`kind` / `enabled` / `allowFrom` / `groupPolicy` /
 * `topicIsolation`（以及同步元数据四字段）。对端据此知道「用户开了哪些渠道、
 * 白名单与群策略怎么设」，凭据各自在本地填。
 */
export const CHANNEL_SYNC_OMIT_KEYS: readonly string[] = [
  // 运行时事实
  'lastSyncAt',
  'syncStatus',
  // 凭据（成组：id + secret）
  'clientId',
  'clientSecret',
  'appId',
  'appSecret',
  'botId',
  'botSecret',
  'token',
];

/** 单条渠道配置 → 可上云的负载（只含声明，不含凭据与运行时事实） */
export function toChannelSyncPayload(config: ChannelConfig): Partial<ChannelConfig> {
  return pickSyncable(config, CHANNEL_SYNC_OMIT_KEYS);
}

/** 批量版：`channelsStore` 的整份负载交给 V1.5 的同步层 */
export function toChannelSyncPayloads(
  configs: readonly ChannelConfig[],
): Array<Partial<ChannelConfig>> {
  return configs.map(toChannelSyncPayload);
}
