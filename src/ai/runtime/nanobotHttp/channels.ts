/**
 * nanobot **IM 渠道域**：领域对象 ⇄ `channels` 配置段。
 *
 * 背景：nanobot 的 IM 渠道配置位于 config.json 的 `channels` 段
 * （ChannelsConfig extra=allow，键为 camelCase，见 config_base.Base 的
 * alias_generator=to_camel）。本模块把前端 `ChannelConfig[]` 映射为该片段，
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
 *
 * 键名归一并入 `../codec`：本文件只管「哪个领域字段映射到哪个引擎键」，
 * 不再自行实现 camelCase / snake_case 双写兜底。
 */
import { platform } from '@/platform';
import { genId } from '@/lib/core/id';
import { putIf, readBool, readEnum, readStr, readStrArray } from '../codec';
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

/** 单条 ChannelConfig → 对应 channel 条目（feishu/lark 返回实例对象） */
export function toNanobotChannelEntry(cfg: ChannelConfig): Record<string, unknown> {
  const base: Record<string, unknown> = { enabled: cfg.enabled };
  if (cfg.allowFrom.length > 0) base.allowFrom = [...cfg.allowFrom];
  // 平铺渠道（dingtalk / weixin / wecom）：条目即段，tool_approval 段级即条目级。
  // 引擎按 snake_case 从 model_extra 原样读取（见 workspace_access.channel_tool_approval_modes），
  // 故键名必须用 `tool_approval`，不可写成 camelCase。feishu / lark 走下方
  // instances 分支、段级单独写，故此处不会落到实例里。
  putIf(base, 'tool_approval', cfg.toolApproval);

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
  // 引擎按 feishu 段级读取 tool_approval，feishu / lark 共用同一段：取单一取值，
  // 以 feishu 优先，缺失时退回 lark（二者并存时通常取一致值）。
  let feishuSectionApproval: 'ask' | 'auto' | undefined;

  for (const cfg of configs) {
    if (cfg.kind === 'feishu' || cfg.kind === 'lark') {
      feishuInstances.push(toNanobotChannelEntry(cfg));
      if (cfg.toolApproval && (cfg.kind === 'feishu' || feishuSectionApproval === undefined)) {
        feishuSectionApproval = cfg.toolApproval;
      }
      continue;
    }
    out[cfg.kind] = toNanobotChannelEntry(cfg);
  }

  if (feishuInstances.length > 0) {
    const section: Record<string, unknown> = { instances: feishuInstances };
    if (feishuSectionApproval) section.tool_approval = feishuSectionApproval;
    out.feishu = section;
  }
  return out;
}

/** 生成可被直接合并进 nanobot config.json 的完整片段（诊断 / 测试用） */
export function buildNanobotChannelsFragment(configs: ChannelConfig[]): string {
  return JSON.stringify({ channels: toNanobotChannels(configs) }, null, 2);
}

/**
 * 同步渠道配置到引擎运行时（自动，无需用户手动操作）：
 * - electron：主进程将片段合并进网关实际使用的 config.json 并重启网关；
 * - web：无文件系统权限，降级为下载片段文件并提示手动合并。
 */
export async function syncChannelsToRuntime(
  configs: ChannelConfig[],
): Promise<ChannelSyncResult> {
  const fragment = buildNanobotChannelsFragment(configs);
  return platform.syncNanobotChannels(fragment);
}

// —— 反向映射：nanobot channels 段 → 本地 ChannelConfig（回显用） ——

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
      allowFrom: normalizeAllowFromForDisplay(kind, readStrArray(e, 'allowFrom', 'allow_from')),
      syncStatus: 'synced',
      lastSyncAt: syncedAt,
    };
    if (kind === 'dingtalk') {
      cfg.clientId = readStr(e, 'clientId', 'client_id');
      cfg.clientSecret = readStr(e, 'clientSecret', 'client_secret');
    } else if (kind === 'weixin') {
      cfg.token = readStr(e, 'token');
    } else {
      cfg.botId = readStr(e, 'botId', 'bot_id');
      cfg.botSecret = readStr(e, 'secret');
    }
    const approval = readStr(e, 'tool_approval');
    if (approval === 'ask' || approval === 'auto') cfg.toolApproval = approval;
    out.push(cfg);
  };

  plain('dingtalk', 'dingtalk');
  plain('weixin', 'weixin');
  plain('wecom', 'wecom');

  const feishu = snapshot.feishu;
  if (typeof feishu === 'object' && feishu !== null && !Array.isArray(feishu)) {
    const section = feishu as Record<string, unknown>;
    // 段级 tool_approval（feishu / lark 共用该段），回显到该段下每个实例配置。
    // 引擎历史版本曾把它泄漏进 instances[]，段级缺失时兜底回收首个有效值。
    let sectionApproval = readStr(section, 'tool_approval');
    if (!sectionApproval && Array.isArray(section.instances)) {
      for (const inst of section.instances) {
        if (typeof inst !== 'object' || inst === null) continue;
        const candidate = readStr(inst as Record<string, unknown>, 'tool_approval');
        if (candidate === 'ask' || candidate === 'auto') {
          sectionApproval = candidate;
          break;
        }
      }
    }
    const approvalMode: 'ask' | 'auto' | undefined =
      sectionApproval === 'ask' || sectionApproval === 'auto' ? sectionApproval : undefined;
    const instances = Array.isArray(section.instances)
      ? (section.instances as Array<Record<string, unknown>>).filter(
          (x) => typeof x === 'object' && x !== null,
        )
      : [section];
    for (const inst of instances) {
      // 飞书实例按 domain 映射为 feishu / lark kind（无 domain 视为 feishu）
      const instKind: ChannelKind = readStr(inst, 'domain') === 'lark' ? 'lark' : 'feishu';
      out.push({
        id: genId(),
        kind: instKind,
        enabled: inst.enabled !== false,
        appId: readStr(inst, 'appId', 'app_id'),
        appSecret: readStr(inst, 'appSecret', 'app_secret'),
        groupPolicy: readEnum<GroupPolicy>(
          inst,
          ['open', 'mention'],
          'groupPolicy',
          'group_policy',
        ),
        topicIsolation: readBool(inst, 'topicIsolation', 'topic_isolation'),
        toolApproval: approvalMode,
        allowFrom: normalizeAllowFromForDisplay(
          instKind,
          readStrArray(inst, 'allowFrom', 'allow_from'),
        ),
        syncStatus: 'synced',
        lastSyncAt: syncedAt,
      });
    }
  }
  return out;
}

/**
 * 从引擎回读渠道配置。
 * 非 electron 端无文件系统权限：**直接短路**，不发起 IPC 往返
 * （能力判定放在 adapter 一处，避免每个 store 各写一遍 env 分支）。
 */
export async function readChannelsFromRuntime(): Promise<ChannelConfig[]> {
  if (platform.env !== 'electron') return [];
  const snapshot = await platform.getNanobotChannels();
  return fromNanobotChannels(snapshot);
}
