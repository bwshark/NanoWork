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
import type { ChannelConfig, MCPConfig } from '@/types';

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

/**
 * MCP 配置的**非同步字段**。
 *
 * 三类：
 *
 * 1. **运行时事实**（§5.2）——全部由本机探测 / 同步产生、必须本机重算：
 *    - `connectionStatus`：真实握手结果，唯一写入者是 `testConfig`；
 *    - `syncStatus`：回答「配置有没有写进**本机**引擎」，本机事实；
 *    - `tools`：探针缓存（`tools/list` 产物）；
 *    - `lastProbedAt` / `lastSyncedAt`：本机探测 / 同步时刻。
 *    同步过去只会得到「本机从未探测过却显示已连接 / 已同步」的假状态。
 * 2. **本机事实字段**——`authKeyNames`：它是「**本机保险库**里配了哪些凭据名」的清单。
 *    跨设备不成立：同步过去会让对端显示「已配置凭据」而其保险库为空（同样是假状态）。
 *    ⚠️ 这一条是任务描述里漏掉、由 `types/mcp.ts` + §5.2 表格双证确认的常见错误。
 * 3. **凭据**（成组）——`auth`：编辑草稿、明文密钥，**严禁上行**（与
 *    `CHANNEL_SYNC_OMIT_KEYS` 剔 `clientSecret` 同口径）。
 *
 * **保留**：`id / name / transport / endpoint / urlType / command / disabledTools /
 * enabled / source / description / category / icon / version / createdAt` + 元数据四字段。
 * 这些是「声明」类，跨端成立。
 */
export const MCP_SYNC_OMIT_KEYS: readonly string[] = [
  // 运行时事实（本机重算，§5.2）
  'connectionStatus', // 真实握手结果，唯一写入者 testConfig
  'syncStatus', // 「配置有没有写进本机引擎」，本机事实
  'tools', // 探针缓存（tools/list 产物）
  'lastProbedAt', // 本机探测时刻
  'lastSyncedAt', // 本机同步进引擎的时刻
  // 本机事实字段
  'authKeyNames', // 「本机保险库里配了哪些凭据名」，跨设备不成立
  // 凭据（成组：id + secret，§5.3）
  'auth', // 编辑草稿，值只应存在于本机保险库
];

/** 单条 MCP 配置 → 可上云的负载（只含声明，不含凭据与运行时事实） */
export function toMcpSyncPayload(config: MCPConfig): Partial<MCPConfig> {
  return pickSyncable(config, MCP_SYNC_OMIT_KEYS);
}
