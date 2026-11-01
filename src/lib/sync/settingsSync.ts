/**
 * `Settings` 的**云端同步负载**裁剪（design §3.3 / FR-10.5，批次 3）。
 *
 * ## 为什么 `Settings` 不能像别的实体那样整体同步
 *
 * 它是唯一一个把**两类互斥的东西装在同一个对象里**的实体：
 * 「用户的偏好」（主题、语气、快捷键）与「这台机器的环境」（网关地址、本地路径、
 * 桌面能力）。前者同步是对的，后者同步过去是**错的且有害**的——把 `gatewayEndpoint`
 * 发过去，对方的客户端会去连**你的**机器（FR-10.5 明文点名）；把 `knownWorkspaces`
 * 发过去，对方会多出一批自己磁盘上根本不存在的工作空间路径。
 *
 * ## 为什么是白名单式的显式排除，而不是「猜哪些像本机字段」
 *
 * 与 `sync/syncPayloads.ts` 同一条纪律：猜错的代价是**不可察觉**的——多剔一个字段只是
 * 少同步一点偏好（用户能感知到「设置没跟过来」），少剔一个字段是把本机路径/凭据
 * 发出去（谁也不会发现）。所以这里一律宁可多剔，且清单要显式写出来。
 *
 * ## 与 `pickSyncable` 的分工
 *
 * 顶层排除走 `pickSyncable`；`transcription` 是**嵌套对象**，顶层 omit 无法表达
 * 「保留 `enabled` / `model` / `language`，只剔 `endpoint` / `apiToken`」，
 * 因此它单独处理——整块不 omit，而是把内层裁一遍再放回去。
 */

import { pickSyncable } from './syncSelect';
import type { Settings, TranscriptionConfig, TtsConfig } from '@/types';

/**
 * `Settings` 顶层不同步的字段。
 *
 * | 字段 | 为什么 |
 * |---|---|
 * | `gatewayEndpoint` / `apiToken` | 指向**本机**网关；同步过去会把对方的客户端指到你的机器，且 `apiToken` 是凭据（FR-10.5 点名） |
 * | `desktop` | 托盘 / 全局热键 / 开机自启是**本机能力**，Web 端只有占位；同步过去会得到一份两端都执行不了的配置 |
 * | `defaultWorkspacePath` | 本地路径，各机目录结构不同，跨设备无意义 |
 * | `knownWorkspaces` / `workspaceAliases` | 键是**绝对路径**（别名的 key 是 workdir），跨设备不成立 |
 * | `hiddenSessions` | 描述「**本机上**我看见什么」（§六 问题 2）：会话在各设备的可见性本就不同，同步它会让对方凭空少一批条目 |
 *
 * ⚠️ `transcription` **刻意不在这张表里**：它是个嵌套对象，而 `pickSyncable` 只做
 * 顶层浅拷贝——顶层 omit 掉它会把 `enabled` / `model` / `language` 这三个正当偏好
 * 一起扔掉。它的内层裁剪见 `TRANSCRIPTION_SYNC_OMIT_KEYS`，由 `toSyncPayload` 处理。
 *
 * **保留**：`theme` / `memoryEnabled` / `autoSummarize` / `promptDomain` /
 * `promptStyle` / `userCustomPrompt` / `sidebarCollapsed` / `shortcuts` /
 * `enabledPlugins` —— 这些是纯偏好，与本机环境无关。
 *
 * `enabledPlugins` 值得单独一句：它同步的是**意图**而非事实（§12.2.1 已确立
 * 「事实在引擎侧」），插件包本体由各设备自行安装，与 FR-3.9「只同步启用态、
 * 不同步包本体」天然一致。
 */
export const SETTINGS_SYNC_OMIT_KEYS: readonly string[] = [
  'gatewayEndpoint',
  'apiToken',
  'desktop',
  'defaultWorkspacePath',
  'knownWorkspaces',
  'workspaceAliases',
  'hiddenSessions',
  // 记忆 v2 策略（蒸馏门槛 / 归档阈值 / 注入预算）是**策略**而非事实：
  // 各设备可以有自己的门槛（一台机器想「30 天才算稳定结论」，另一台想更激进），
  // 搬过去只会把对端调好的值覆盖掉。与 `desktop` 同一口径。
  'memoryPolicy',
];

/**
 * 语音转录里不同步的两个字段。
 *
 * - `endpoint`：转录服务地址，通常与网关同源（本机）；留空 = 复用网关，这个「留空」
 *   的语义必须**跟着本机网关走**，不能在设备间搬运；
 * - `apiToken`：凭据，与 `Settings.apiToken` 同一口径（不上行）。
 *
 * 保留 `enabled` / `model` / `language`：它们表达「用户想用语音输入、用哪个模型、
 * 说什么语言」，是跨设备成立的偏好。这里**从负载里省略**（而不是置空）这两个键
 * ——省略 = 不参与同步，对端保留自己的本机值；置空则会把对端配好的地址清掉。
 */
export const TRANSCRIPTION_SYNC_OMIT_KEYS: readonly string[] = ['endpoint', 'apiToken'];

/**
 * 语音合成里不同步的两个字段——与 `TRANSCRIPTION_SYNC_OMIT_KEYS` 同一口径：
 *
 * - `endpoint`：留空 = 沿用转录的工作区地址，这个「留空」必须跟着本机网关走；
 * - `apiToken`：凭据，绝不上行。
 *
 * 保留 `enabled` / `model` / `voice` / `fallbackToSystem`：它们表达「要不要念出来、
 * 用什么音色」，是跨设备成立的偏好。
 *
 * ⚠️ `tts` **不能**进顶层的 `SETTINGS_SYNC_OMIT_KEYS`：整块剔掉会把这些偏好
 * 一起扔掉（与 `transcription` 完全相同的理由）。
 */
export const TTS_SYNC_OMIT_KEYS: readonly string[] = ['endpoint', 'apiToken'];

/**
 * 设置的可上云负载。
 *
 * 返回 `Partial` 而不是 `Settings`：裁剪后的对象**必然缺**若干必填字段，
 * 硬转成 `Settings` 只会让调用方以为拿到了一份完整设置，然后在某处把
 * `gatewayEndpoint` 读成 `undefined` 写回去——那是一种比缺字段更难查的损坏。
 */
export type SettingsSyncPayload = Omit<Partial<Settings>, 'transcription' | 'tts'> & {
  transcription?: Partial<TranscriptionConfig>;
  tts?: Partial<TtsConfig>;
};

/** `Settings` → 可上云负载（只含偏好，不含本机环境与凭据） */
export function toSyncPayload(settings: Settings): SettingsSyncPayload {
  const { transcription, tts, ...rest } = pickSyncable(settings, SETTINGS_SYNC_OMIT_KEYS);
  return {
    ...rest,
    transcription: pickSyncable(transcription ?? {}, TRANSCRIPTION_SYNC_OMIT_KEYS),
    // `tts` 整段缺失 = 「跟随 transcription」，此时**不要**凭空造一个空对象出来：
    // 对端会因此从「跟随」变成「显式配了一份空配置」，语义就变了。
    ...(tts ? { tts: pickSyncable(tts, TTS_SYNC_OMIT_KEYS) } : {}),
  };
}
