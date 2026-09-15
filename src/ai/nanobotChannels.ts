/**
 * nanobot channels 配置片段生成器与运行时同步器。
 *
 * 背景：nanobot 的 IM 渠道配置位于 config.json 的 `channels` 段
 * （ChannelsConfig extra=allow，键为 camelCase，见 config_base.Base 的
 * alias_generator=to_camel）。本模块把前端 ChannelConfig[] 映射为该片段，
 * 并经 platform.syncNanobotChannels 自动合并进网关实际使用的 config.json
 * 并重启网关，无需用户手动操作。
 *
 * 映射规则（对齐各 channel manifest / config 模型）：
 * - dingtalk → channels.dingtalk = { enabled, clientId, clientSecret, allowFrom }
 * - weixin   → channels.weixin   = { enabled, token, allowFrom }
 * - wecom    → channels.wecom    = { enabled, botId, secret, allowFrom }
 * - feishu / lark → channels.feishu.instances[]（多实例并存），
 *   实例含 { id, instanceId, enabled, domain: 'feishu'|'lark', appId, appSecret,
 *   groupPolicy, allowFrom, topicIsolation }；lark 卡片即 domain='lark' 的实例。
 *   instanceId 取稳定的渠道名（feishu/lark），避免随机 ID 造成实例身份漂移。
 */

import { platform } from '@/platform';
import { genId } from '@/lib/id';
import type { ChannelSyncResult, NanobotChannelsSnapshot } from '@/platform/types';
import type { ChannelConfig, ChannelKind, GroupPolicy } from '@/types';

/** channels 片段中单个普通渠道条目 */
interface NanobotChannelEntry {
  enabled: boolean;
  [key: string]: unknown;
}

/** feishu 多实例段（nanobot canonical 形态） */
interface NanobotFeishuSection {
  instances: Array<Record<string, unknown>>;
}

/** nanobot config.json 的 channels 段结构（节选） */
export interface NanobotChannels {
  [channelName: string]: NanobotChannelEntry | NanobotFeishuSection | unknown;
}

/** 非空才写入（避免把空串覆盖进 nanobot 配置） */
function putIf(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  target[key] = value;
}

/** 单条 ChannelConfig → 对应 channel 条目（feishu/lark 返回实例对象） */
export function toNanobotChannelEntry(cfg: ChannelConfig): Record<string, unknown> {
  const base: Record<string, unknown> = { enabled: cfg.enabled };
  if (cfg.allowFrom.length > 0) base.allowFrom = [...cfg.allowFrom];

  switch (cfg.kind) {
    case 'dingtalk':
      putIf(base, 'clientId', cfg.clientId);
      putIf(base, 'clientSecret', cfg.clientSecret);
      return base;
    case 'weixin':
      putIf(base, 'token', cfg.token);
      return base;
    case 'wecom':
      putIf(base, 'botId', cfg.botId);
      putIf(base, 'secret', cfg.botSecret);
      return base;
    case 'feishu':
    case 'lark': {
      // instanceId 使用渠道名（feishu/lark）：稳定且满足 nanobot [A-Za-z0-9_-]+ 约束，
      // 保证应用数据清理后实例身份不变，避免配对与身份键漂移
      const instanceId = cfg.kind;
      const instance: Record<string, unknown> = {
        id: instanceId,
        instanceId,
        enabled: cfg.enabled,
        domain: cfg.kind,
      };
      putIf(instance, 'appId', cfg.appId);
      putIf(instance, 'appSecret', cfg.appSecret);
      putIf(instance, 'groupPolicy', cfg.groupPolicy);
      putIf(instance, 'topicIsolation', cfg.topicIsolation);
      if (cfg.allowFrom.length > 0) instance.allowFrom = [...cfg.allowFrom];
      return instance;
    }
  }
}

/** ChannelConfig[] → nanobot channels 对象（feishu/lark 合并进 instances 数组） */
export function toNanobotChannels(configs: ChannelConfig[]): NanobotChannels {
  const out: NanobotChannels = {};
  const feishuInstances: Array<Record<string, unknown>> = [];

  for (const cfg of configs) {
    if (cfg.kind === 'feishu' || cfg.kind === 'lark') {
      feishuInstances.push(toNanobotChannelEntry(cfg));
      continue;
    }
    out[cfg.kind] = toNanobotChannelEntry(cfg);
  }

  if (feishuInstances.length > 0) {
    out.feishu = { instances: feishuInstances } satisfies NanobotFeishuSection;
  }
  return out;
}

/** 生成可被直接合并进 nanobot config.json 的完整片段 */
export function buildNanobotChannelsFragment(configs: ChannelConfig[]): string {
  return JSON.stringify({ channels: toNanobotChannels(configs) }, null, 2);
}

/**
 * 同步到 nanobot 运行时（自动，无需用户手动操作）：
 * - electron：主进程将片段合并进网关实际使用的 config.json 并重启网关；
 * - web：无文件系统权限，降级为下载片段文件并提示手动合并。
 *
 * @param configs 当前全部渠道配置
 * @returns 同步结果（ok/message/needsRestart）
 */
export async function syncChannelsToNanobotRuntime(
  configs: ChannelConfig[],
): Promise<ChannelSyncResult> {
  const fragment = buildNanobotChannelsFragment(configs);
  return platform.syncNanobotChannels(fragment);
}

// —— 反向映射：nanobot channels 段 → 本地 ChannelConfig（回显用） ——

/** 读取条目中的非空字符串字段（兼容 camelCase / snake_case 两种键名） */
function str(entry: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = entry[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** 读取 allowFrom 白名单（兼容 allow_from；非数组回退空） */
function allowFromOf(entry: Record<string, unknown>): string[] {
  const v = entry.allowFrom ?? entry.allow_from;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** 具备扫码接入路径的渠道 kind（回显白名单归一仅作用于这些渠道） */
const QR_ONBOARD_KINDS: ReadonlySet<ChannelKind> = new Set(['weixin', 'feishu', 'lark']);

/**
 * 回显层白名单归一：空名单 → ['*']，仅对扫码渠道（weixin / feishu / lark）回显归一。
 * 背景：引擎扫码回写从不写 allowFrom（飞书甚至主动清空），空白名单在
 * nanobot 中 = 纯配对码模式；主进程扫码成功时序已兜底写 ["*"]，回读侧
 * 同步归一，使回显与手动配置路径（defaultsFor / toPatch）语义一致，
 * 避免卡片显示空白名单。
 * 非扫码渠道（dingtalk / wecom）空白名单是引擎刻意保留的配对审批模式，
 * 保持原样不归一，防止经 hydrate → persist → syncAll 链路放大为全渠道写入。
 * 仅影响回显：向引擎同步的 toNanobotChannels 仍保持空值不写键的行为。
 */
function normalizeAllowFromForDisplay(kind: ChannelKind, list: string[]): string[] {
  if (!QR_ONBOARD_KINDS.has(kind)) return list;
  return list.length > 0 ? list : ['*'];
}

/** 读取群聊响应策略（仅 open / mention 合法，其余回退 undefined） */
function groupPolicyOf(entry: Record<string, unknown>): GroupPolicy | undefined {
  const v = str(entry, 'groupPolicy', 'group_policy');
  return v === 'open' || v === 'mention' ? v : undefined;
}

/** 读取布尔策略字段（兼容 camelCase / snake_case） */
function boolOf(entry: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const v = entry[key];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

/**
 * 反向映射：nanobot config.json 的 channels 段 → 本地 ChannelConfig[]。
 * 用于本地 channelsStore 缺失配置时的回显（配置可能直接在 nanobot 侧写入）。
 * 仅解析前端支持的渠道；feishu 段按 instances[] 的 domain 区分 feishu / lark，
 * 无 instances 时整段视为单个 feishu 实例。
 * @param snapshot 主进程回读的 channels 段；null 时返回空数组
 */
export function fromNanobotChannels(
  snapshot: NanobotChannelsSnapshot | null,
): ChannelConfig[] {
  if (!snapshot) return [];
  const out: ChannelConfig[] = [];
  const syncedAt = new Date().toISOString();

  /** 解析普通单实例渠道（dingtalk / weixin / wecom） */
  const plain = (kind: ChannelKind, name: string): void => {
    const entry = snapshot[name];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return;
    const e = entry as Record<string, unknown>;
    const cfg: ChannelConfig = {
      id: genId(),
      kind,
      enabled: e.enabled !== false,
      allowFrom: normalizeAllowFromForDisplay(kind, allowFromOf(e)),
      syncStatus: 'synced',
      lastSyncAt: syncedAt,
    };
    if (kind === 'dingtalk') {
      cfg.clientId = str(e, 'clientId', 'client_id');
      cfg.clientSecret = str(e, 'clientSecret', 'client_secret');
    } else if (kind === 'weixin') {
      cfg.token = str(e, 'token');
    } else {
      cfg.botId = str(e, 'botId', 'bot_id');
      cfg.botSecret = str(e, 'secret');
    }
    out.push(cfg);
  };

  plain('dingtalk', 'dingtalk');
  plain('weixin', 'weixin');
  plain('wecom', 'wecom');

  const feishu = snapshot.feishu;
  if (typeof feishu === 'object' && feishu !== null && !Array.isArray(feishu)) {
    const section = feishu as Record<string, unknown>;
    const instances = Array.isArray(section.instances)
      ? (section.instances as Array<Record<string, unknown>>).filter(
          (x) => typeof x === 'object' && x !== null,
        )
      : [section];
    for (const inst of instances) {
      // 飞书实例按 domain 映射为 feishu / lark kind（无 domain 视为 feishu）
      const instKind: ChannelKind = str(inst, 'domain') === 'lark' ? 'lark' : 'feishu';
      out.push({
        id: genId(),
        kind: instKind,
        enabled: inst.enabled !== false,
        appId: str(inst, 'appId', 'app_id'),
        appSecret: str(inst, 'appSecret', 'app_secret'),
        groupPolicy: groupPolicyOf(inst),
        topicIsolation: boolOf(inst, 'topicIsolation', 'topic_isolation'),
        allowFrom: normalizeAllowFromForDisplay(instKind, allowFromOf(inst)),
        syncStatus: 'synced',
        lastSyncAt: syncedAt,
      });
    }
  }
  return out;
}
