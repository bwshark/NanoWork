/**
 * 渠道凭据（IM）的**字段归属**与**保险库命名**——渲染层与主进程共用的单一事实来源。
 *
 * ## 为什么单独成文件
 *
 * 这件事需要**两个 bundle 各自知道**：
 *
 * - 渲染层：持久化时剥掉明文、把值交给保险库、UI 判「是否已配置凭据」；
 * - 主进程：合并 `config.json` 时从保险库把值回补进 `channels` 段。
 *
 * 判定若各写一遍，出现的第一种分叉就是「渲染层存的和主进程补的不是同一个字段名」——
 * 表现成渠道看着配好了却连不上（或反之，补了个引擎不认识的键）。所以映射只在这里声明。
 *
 * 因此本模块**只允许 `import type`**（别名路径在运行时被擦除），主进程才能用相对路径
 * 直接引用（`electron/main.ts` 的 esbuild 未配 `@/` 别名，见 `src/lib/constants.ts` 同款说明）。
 *
 * ## 为什么是「密钥类字段」而不是「全部凭据字段」
 *
 * `clientId` / `appId` / `botId` 是**应用标识**，不是密钥：它们明文落 `channels.json`
 * 不构成泄露，且 UI 编辑时需要回显（保险库的值不回传渲染层，放进去就显示不出来了）。
 * 会构成泄露的是下面这张表里的四个字段——它们的值只允许存在于**加密保险库**与
 * **引擎 config.json**（引擎消费必需）两处。
 *
 * 注意与 `CHANNEL_SYNC_OMIT_KEYS`（`lib/syncPayloads.ts`）的区别：那张表管**云端负载**，
 * 因此把 id 与 secret **成组**剔除（只留 id 会同步出一条「看着配好、实际连不上」的渠道）；
 * 本表管**本机落盘**，id 留着有用（回显），故只剥密钥。
 */

import type { ChannelKind } from '@/types';

/**
 * 各渠道的**密钥类**字段（值进加密保险库，不进 `channels.json`）。
 *
 * 必须与 `lib/channelMeta.ts` 里 `kind: 'secret'` 的字段保持一致——
 * 有一条护栏用例（`tests/lib/channelSecrets.test.ts`）专门钉这条，两边漏一个就会红。
 */
export const CHANNEL_SECRET_FIELD_KEYS: Record<ChannelKind, readonly string[]> = {
  dingtalk: ['clientSecret'],
  feishu: ['appSecret'],
  lark: ['appSecret'],
  weixin: ['token'],
  wecom: ['botSecret'],
};

/**
 * 渠道凭据在保险库里的名字前缀。
 *
 * 加前缀而非直接用 `kind`：保险库是 MCP 服务器与渠道**共用**的一张表
 * （键是名字），名叫 `dingtalk` 的 MCP 服务器与钉钉渠道会撞在同一个条目上——
 * 两者互相覆盖，且症状是「MCP 的 token 变成了渠道的 secret」这种最难看的一类串味。
 */
export const CHANNEL_VAULT_PREFIX = 'channel:';

/** 收窄为普通对象（数组、null、标量一律拒绝） */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 某渠道的密钥类字段清单 */
export function channelSecretKeys(kind: ChannelKind): readonly string[] {
  return CHANNEL_SECRET_FIELD_KEYS[kind] ?? [];
}

/** 某渠道凭据在保险库中的条目名 */
export function channelVaultName(kind: string): string {
  return `${CHANNEL_VAULT_PREFIX}${kind}`;
}

/** 该保险库条目名是否属于某条渠道 */
export function isChannelVaultName(name: string): boolean {
  return name.startsWith(CHANNEL_VAULT_PREFIX);
}

/** 从保险库条目名反解渠道 kind（不是渠道条目则返回空串） */
export function channelKindOfVaultName(name: string): string {
  return isChannelVaultName(name) ? name.slice(CHANNEL_VAULT_PREFIX.length) : '';
}

/**
 * 取实体上的**非空**密钥字段，作为保险库的写入载荷。
 *
 * 空串 = 「本次不提供密钥」（表单留空代表不修改），故不写进载荷——写了会让
 * 保险库的 `write` 收到空值集合，而它的语义是「整条替换，空对象即删除」，
 * 于是「用户没填」被当成「用户清空了」。
 *
 * `kind` 缺失或未知 → 空对象（宁可不写，也不猜一个字段名出来）。
 */
export function pickChannelSecrets(entity: unknown): Record<string, string> {
  const record = asRecord(entity);
  const kind = record?.kind;
  if (!record || typeof kind !== 'string') return {};
  const out: Record<string, string> = {};
  for (const key of channelSecretKeys(kind as ChannelKind)) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

/**
 * 剥掉密钥字段（返回新对象；原对象不动）。
 *
 * 不是普通对象 / 无 kind 时**原样返回**：拿不准就不动它，宁可让它明文落盘，
 * 也不要因为一次误判把用户填的东西删掉。
 */
export function stripChannelSecrets<T>(entity: T): T {
  const record = asRecord(entity);
  const kind = record?.kind;
  if (!record || typeof kind !== 'string') return entity;
  const out: Record<string, unknown> = { ...record };
  for (const key of channelSecretKeys(kind as ChannelKind)) delete out[key];
  return out as T;
}

/**
 * 把保险库的 key 名清单（`{ 'channel:feishu': ['appSecret'] }`）收敛为
 * `{ feishu: ['appSecret'] }`——只留渠道条目，MCP 的条目原样不认。
 */
export function channelSecretKeysByKind(
  vaultKeys: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, keys] of Object.entries(vaultKeys)) {
    const kind = channelKindOfVaultName(name);
    if (kind) out[kind] = [...keys];
  }
  return out;
}
