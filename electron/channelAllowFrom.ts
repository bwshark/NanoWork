/**
 * 渠道白名单（allowFrom）归一化纯函数层（可导出，便于单元测试）。
 *
 * 背景：nanobot 引擎对渠道私聊有「配对审批（pairing）」准入机制 ——
 * `allowFrom` 为空数组（或缺失）时进入纯配对码模式，未审批用户发消息
 * 只会收到 "pairing code... approve in WebUI" 的拦截回复。
 * 微信扫码成功后引擎只回写 token / baseUrl，从不写 allowFrom；飞书
 * 注册 / 换身份时甚至会主动清空实例 allowFrom，导致扫码接入的渠道
 * 必然落入配对审批墙。本层在扫码成功后的重启前兜底归一为 ["*"]，
 * 与前端手动配置路径（channelsStore defaultsFor / ChannelConfigDialog
 * toPatch）的 ['*'] 兜底语义保持一致。
 */

/** 判断值是否为「空」白名单：缺失 / 非数组 / 空数组均视为空 */
function isEmptyAllowFrom(v: unknown): boolean {
  return !Array.isArray(v) || v.length === 0;
}

/**
 * 归一单个配置对象的 allowFrom：
 * - 兼容读 `allowFrom`（camelCase）与 `allow_from`（snake_case）；
 * - 任一键非空（用户显式配置了精确名单）即视为已配置 → 原样保留，绝不覆盖；
 * - 两键皆缺失 / 空数组 → 写入 `allowFrom = ["*"]`（全部放行，消除配对审批墙）。
 * @returns 是否发生了变更
 */
export function normalizeChannelAllowFrom(cfg: Record<string, unknown>): boolean {
  // 双键并存时任一非空即视为已配置：避免 allowFrom: [] 错误覆盖非空的 allow_from
  const effective = isEmptyAllowFrom(cfg.allowFrom) ? cfg.allow_from : cfg.allowFrom;
  if (!isEmptyAllowFrom(effective)) return false;
  cfg.allowFrom = ['*'];
  return true;
}

/**
 * 归一 nanobot config.json channels 段中指定引擎渠道的 allowFrom
 * （原地修改，供主进程扫码成功后重启前的兜底时序调用）。
 * - weixin：处理 `channels.weixin.allowFrom`；
 * - feishu：处理 `channels.feishu.instances[]` 中每个实例的 `allowFrom`；
 * - 其余渠道不处理（无扫码接入路径）。
 * @returns 是否发生了变更（上游据此决定是否原子落盘）
 */
export function normalizeEngineChannelAllowFrom(
  channels: Record<string, unknown>,
  engineChannel: string,
): boolean {
  let changed = false;
  if (engineChannel === 'weixin') {
    const weixin = channels.weixin;
    if (typeof weixin === 'object' && weixin !== null && !Array.isArray(weixin)) {
      if (normalizeChannelAllowFrom(weixin as Record<string, unknown>)) changed = true;
    }
  } else if (engineChannel === 'feishu') {
    const feishu = channels.feishu;
    if (typeof feishu === 'object' && feishu !== null && !Array.isArray(feishu)) {
      const instances = (feishu as Record<string, unknown>).instances;
      if (Array.isArray(instances)) {
        for (const inst of instances) {
          if (typeof inst === 'object' && inst !== null && !Array.isArray(inst)) {
            if (normalizeChannelAllowFrom(inst as Record<string, unknown>)) changed = true;
          }
        }
      }
    }
  }
  return changed;
}
