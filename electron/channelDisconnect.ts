/**
 * 渠道断开连接时「清洗 channels 片段」的纯函数层（可导出，便于单元测试）。
 *
 * 背景：nanobot 引擎没有提供任何 disconnect / logout action ——
 * 「断开」必须由应用侧在配置 / 文件层完成。本层负责把
 * config.json 的 channels 段中指定渠道的连接凭证就地清除并停用渠道，
 * 使网关重启后该渠道回到「未连接、可重新扫码」状态。
 *
 * 语义约定（与引擎加载行为对齐）：
 * - weixin：清 `token` / `baseUrl` 并置 `enabled=false`；保留
 *   allowFrom 等策略字段（重连后沿用，无需重新配置）。
 *   注意：微信凭证另有 `<config 目录>/weixin/account.json` 状态文件
 *   （引擎 _load_state 优先读取），由主进程在调用本函数之外单独删除，
 *   只清 config 不算断开。
 * - feishu / lark：feishu 与 lark 实例共存于 `channels.feishu.instances[]`，
 *   按 `domain` 字段定位目标实例（缺省 domain 视为 feishu），仅清该实例的
 *   `appId` / `appSecret` / `identityKey` 并置 `enabled=false`，
 *   其余 domain 实例原样保留；保留实例上的策略字段（allowFrom 等）。
 *
 * 幂等：已断开的渠道再次调用不产生变更（返回 false），供上游跳过落盘。
 */

import { join } from 'node:path';

/** 支持断开连接的渠道 kind（其余渠道无扫码接入路径，不提供断开） */
export type DisconnectChannelKind = 'weixin' | 'feishu' | 'lark';

/** 判断值是否为普通对象（排除 null / 数组） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 定位微信引擎状态文件 account.json 的路径（纯函数，便于单元测试）。
 *
 * 与引擎 `nanobot/channels/weixin/state.py` 的 local_state_present 对齐：
 * 优先读 `channels.weixin.stateDir`（兼容 snake_case `state_dir`），
 * 非空则在该目录下定位 account.json；否则回落默认 `<config 目录>/weixin/`。
 * 应用自身从不写 stateDir，此为手工配置兜底。
 * @param configDir config.json 所在目录（dirname(configPath)）
 * @param weixin config.json 的 channels.weixin 段（可为任意值，容错处理）
 */
export function resolveWeixinAccountPath(configDir: string, weixin: unknown): string {
  let stateDir = '';
  if (isPlainObject(weixin)) {
    if (typeof weixin.stateDir === 'string' && weixin.stateDir.trim() !== '') {
      stateDir = weixin.stateDir.trim();
    } else if (typeof weixin.state_dir === 'string' && weixin.state_dir.trim() !== '') {
      stateDir = weixin.state_dir.trim();
    }
  }
  if (stateDir) return join(stateDir, 'account.json');
  return join(configDir, 'weixin', 'account.json');
}

/**
 * 清洗 nanobot config.json channels 段中指定渠道的连接凭证（原地修改）。
 * @param channels config.json 的 channels 段对象
 * @param kind 渠道 kind（weixin / feishu / lark；lark 按 domain 匹配实例）
 * @returns 是否发生了变更（上游据此决定是否原子落盘）
 */
export function disconnectChannelInConfig(
  channels: Record<string, unknown>,
  kind: DisconnectChannelKind,
): boolean {
  if (kind === 'weixin') {
    const weixin = channels.weixin;
    if (!isPlainObject(weixin)) return false;
    let changed = false;
    if ('token' in weixin) {
      delete weixin.token;
      changed = true;
    }
    if ('baseUrl' in weixin) {
      delete weixin.baseUrl;
      changed = true;
    }
    if (weixin.enabled !== false) {
      weixin.enabled = false;
      changed = true;
    }
    return changed;
  }

  // feishu / lark：共用 channels.feishu.instances[]，按 domain 定位（实例隔离）
  const feishu = channels.feishu;
  if (!isPlainObject(feishu)) return false;
  const instances = feishu.instances;
  if (!Array.isArray(instances)) return false;

  let changed = false;
  for (const inst of instances) {
    if (!isPlainObject(inst)) continue;
    // 缺省 domain 的实例视为 feishu（与 fromNanobotChannels 反向映射一致）
    const domain = typeof inst.domain === 'string' ? inst.domain : 'feishu';
    if (domain !== kind) continue;
    if ('appId' in inst) {
      delete inst.appId;
      changed = true;
    }
    if ('appSecret' in inst) {
      delete inst.appSecret;
      changed = true;
    }
    if ('identityKey' in inst) {
      delete inst.identityKey;
      changed = true;
    }
    if (inst.enabled !== false) {
      inst.enabled = false;
      changed = true;
    }
  }
  return changed;
}
