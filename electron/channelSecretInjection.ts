/**
 * 渠道凭据的**主进程侧回补**（`channels.json` 已不再存明文密钥的配套件）。
 *
 * ## 它补的是什么洞
 *
 * 渲染层持久化时已剥掉密钥（`channelsStore.partialize` + `lib/channel/channelSecrets.ts`），
 * 于是**应用重启后渲染层手上没有密钥**，它提交给主进程的 `channels` 片段自然也不带。
 * 而 `syncNanobotChannels` 对托管渠道键是**整体替换**语义——照单收下就等于把
 * `config.json` 里的 `clientSecret` / `appSecret` / `token` 一并抹掉，
 * 症状是**渠道直接不可用**（且从界面看配置一切正常）。
 *
 * 所以合并前必须先按名字从保险库把值取回来（同 `injectConnectorSecrets` 的做法：
 * 密钥只回主进程、不回渲染层）。
 *
 * ## 两道防线（缺一不可）
 *
 * 1. **回补**（`injectChannelSecrets`）：保险库可用时，用保险库的值覆盖。
 *    保险库是权威来源——允许条目自带同名字段会让「保险库改了但配置没变」变成
 *    一条静默失效的路径。
 * 2. **兜底保留**（`carryOverChannelSecrets`）：保险库**不可用**（Linux 无 keyring、
 *    `safeStorage` 拒绝加密等）时回补不到值，此时若仍按「整体替换」写盘，
 *    一次启动同步就会把引擎侧唯一一份可用凭据抹掉。故：待写条目缺某密钥字段
 *    而磁盘上已有值时，**保留磁盘值**。
 *
 * ## 不只是密钥：`tool_approval` 同理
 *
 * 渲染层 `ChannelConfig` 模型不认识 `tool_approval`（B3-03 IM 审批，引擎按
 * `channels.<name>.tool_approval` 段级读取），用户手工写进 config.json 的该键
 * 会在 `toNanobotChannels` 重建片段 + 托管键整体替换时被静默抹掉——症状与密钥
 * 被抹完全同构（磁盘上没了，界面一切正常）。故归入同一兜底保留名单。
 *
 * 两者的边界是「incoming **有键**才参与」——整条渠道不在 incoming 里代表用户删了它，
 * 那种情况下不能靠兜底把它复活。
 *
 * ## 为什么依赖注入
 *
 * `credentialVault` 只在主进程存在；把读函数作为参数注入后，本模块不 import 任何
 * Electron 运行时，可直接被 vitest 覆盖（对齐 `electron/credentialVault.ts` /
 * `electron/storageRoutes.ts` 的做法），也让「读不到凭据」这条分支测得到。
 */
import { channelSecretKeys, channelVaultName } from '../src/lib/channel/channelSecrets';

/** 保险库条目读取器（主进程传 `credentialVault.read`） */
export type SecretReader = (name: string) => Promise<Record<string, string>>;

/** 平铺托管的渠道键（飞书是段，单独处理；lark 是 feishu 段内的实例，不是顶层键） */
const PLAIN_CHANNEL_KINDS = ['dingtalk', 'weixin', 'wecom'] as const;

/** 飞书段键（feishu 与 lark 两个 kind 共用此段，按实例的 domain 区分） */
const FEISHU_SECTION_KEY = 'feishu';

/**
 * 渲染层片段不携带、但整体替换时必须保留的引擎侧配置键。
 *
 * 与密钥同一失效方式：`toNanobotChannels` 凭 UI 模型重建片段，模型外的键
 * 一律缺席；`mergeChannelsIntoConfig` 对托管键是整体替换，不兜底就会静默抹掉。
 * 现含 `tool_approval`（B3-03：IM 渠道工具审批模式，引擎按段级键读取）。
 */
const CARRIED_OVER_ENGINE_KEYS = ['tool_approval'] as const;

/** 收窄为普通对象（数组、null、标量一律拒绝） */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 实例的渠道 kind：domain 为 lark 即 lark，其余（含缺失）视为 feishu */
function feishuInstanceKind(instance: Record<string, unknown>): 'feishu' | 'lark' {
  return instance.domain === 'lark' ? 'lark' : 'feishu';
}

/**
 * 把保险库里的渠道密钥回补进待写入 `config.json` 的 `channels` 段。
 *
 * - 平铺渠道（dingtalk / weixin / wecom）：按 `kind` 取保险库条目；
 * - 飞书段：按每个实例的 `domain` 分别取（feishu / lark 各有自己的条目）。
 *
 * 返回新对象，不改入参。保险库读不到值（无条目 / 解密失败 / 环境不可用）时
 * 该渠道原样返回——留给 `carryOverChannelSecrets` 兜底。
 */
export async function injectChannelSecrets(
  channels: Record<string, unknown>,
  readSecrets: SecretReader,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...channels };

  for (const kind of PLAIN_CHANNEL_KINDS) {
    const entry = asObject(out[kind]);
    if (!entry) continue;
    const secrets = await safeRead(readSecrets, channelVaultName(kind));
    if (Object.keys(secrets).length === 0) continue;
    out[kind] = { ...entry, ...secrets };
  }

  const feishu = asObject(out[FEISHU_SECTION_KEY]);
  const instances = feishu && Array.isArray(feishu.instances) ? feishu.instances : null;
  if (feishu && instances) {
    // 缓存：同一段里可能有多个同 domain 实例，避免重复读保险库
    const cache = new Map<string, Record<string, string>>();
    const nextInstances: unknown[] = [];
    for (const raw of instances) {
      const instance = asObject(raw);
      if (!instance) {
        nextInstances.push(raw);
        continue;
      }
      const kind = feishuInstanceKind(instance);
      let secrets = cache.get(kind);
      if (!secrets) {
        secrets = await safeRead(readSecrets, channelVaultName(kind));
        cache.set(kind, secrets);
      }
      nextInstances.push(
        Object.keys(secrets).length === 0 ? instance : { ...instance, ...secrets },
      );
    }
    out[FEISHU_SECTION_KEY] = { ...feishu, instances: nextInstances };
  }

  return out;
}

/** 保险库读取失败不阻断同步：当作「没有密钥」，由兜底保留接住 */
async function safeRead(readSecrets: SecretReader, name: string): Promise<Record<string, string>> {
  try {
    return await readSecrets(name);
  } catch {
    return {};
  }
}

/**
 * 兜底保留：待写条目**缺某密钥字段**而磁盘上已有非空值时，沿用磁盘值。
 *
 * 只在 `incoming` **存在该键**时生效：
 * - 缺字段（回补不到）→ 保留磁盘值，避免抹掉引擎侧唯一可用凭据；
 * - 整条不在 incoming → 用户删了它，不做保留（否则删不掉渠道）。
 */
export function carryOverChannelSecrets(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };

  for (const kind of PLAIN_CHANNEL_KINDS) {
    const next = asObject(incoming[kind]);
    const prev = asObject(existing[kind]);
    if (!next || !prev) continue;
    out[kind] = carryOverKeys(next, prev, [
      ...channelSecretKeys(kind),
      ...CARRIED_OVER_ENGINE_KEYS,
    ]);
  }

  const nextSection = asObject(incoming[FEISHU_SECTION_KEY]);
  const prevSection = asObject(existing[FEISHU_SECTION_KEY]);
  if (nextSection && prevSection) {
    // 段级键（tool_approval）与实例级密钥分两层兜底：前者挂在段上，
    // 后者按 instanceId 逐实例匹配（见 carryOverFeishuInstances）
    const section = carryOverKeys(nextSection, prevSection, CARRIED_OVER_ENGINE_KEYS);
    out[FEISHU_SECTION_KEY] = carryOverFeishuInstances(section, prevSection);
  }

  return out;
}

/** 逐字段兜底：目标缺值（undefined / 空串）而来源有非空值时，取来源的值 */
function carryOverKeys(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const key of keys) {
    const current = out[key];
    const fallback = source[key];
    if (typeof current === 'string' && current !== '') continue;
    if (typeof fallback === 'string' && fallback !== '') out[key] = fallback;
  }
  return out;
}

/**
 * 飞书段的兜底保留。
 *
 * 实例身份用 `instanceId` 匹配（应用写入时取渠道名，稳定）；老数据缺失时退回
 * `domain`（同一 domain 在本应用里至多一个实例）。匹配不上的一律不保留——
 * 宁可让用户重连，也不要把 A 实例的密钥塞给 B 实例（那是串味，比断开更糟）。
 */
function carryOverFeishuInstances(
  nextSection: Record<string, unknown>,
  prevSection: Record<string, unknown>,
): Record<string, unknown> {
  const nextList = Array.isArray(nextSection.instances) ? nextSection.instances : null;
  const prevList = Array.isArray(prevSection.instances) ? prevSection.instances : null;
  if (!nextList || !prevList) return { ...nextSection };

  const prevByKey = new Map<string, Record<string, unknown>>();
  for (const raw of prevList) {
    const instance = asObject(raw);
    if (!instance) continue;
    const key = instanceIdentity(instance);
    if (key) prevByKey.set(key, instance);
  }

  const instances = nextList.map((raw) => {
    const instance = asObject(raw);
    if (!instance) return raw;
    const key = instanceIdentity(instance);
    const prev = key ? prevByKey.get(key) : undefined;
    if (!prev) return instance;
    return carryOverKeys(instance, prev, channelSecretKeys(feishuInstanceKind(instance)));
  });

  return { ...nextSection, instances };
}

/** 实例身份键：优先 instanceId，退回 domain */
function instanceIdentity(instance: Record<string, unknown>): string {
  for (const key of ['instanceId', 'id', 'domain'] as const) {
    const value = instance[key];
    if (typeof value === 'string' && value !== '') return `${key}:${value}`;
  }
  return '';
}
