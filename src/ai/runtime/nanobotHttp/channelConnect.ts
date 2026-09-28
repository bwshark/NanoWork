/**
 * IM 渠道扫码接入的**协议层**（`settings.channel.connect.*`）。
 *
 * ## 为什么单独一层
 *
 * 这是与 `/v1/chat/completions` **并列的另一条引擎协议**：走主进程签发的认证
 * WebSocket（`electron/main.ts` 的 `channelConnectViaGateway`），载荷是网关
 * `webui_response` 帧的 `result`。它的 wire 字段名（`session_id` / `qr_url` /
 * `interval_ms` …）与起始参数（`domain` / `instance_id` / `mode`）**只允许出现在
 * 本目录**——渲染层其余代码一律消费下面的 camelCase 领域类型（ADR-020，CI 检查二
 * 会拦）。`channelMeta` 里原先那份 `scanConnect.startParams` 因此也搬到了这里。
 *
 * ## 职责边界
 *
 * 传输不在这里：开 WS、签发 token、解析帧都在主进程。本模块只做**参数编码**与
 * **响应解码**，`platform.channelConnect` 退化成一条只搬运不解释的通道——于是
 * 「这条协议长什么样」只有一个答案。
 */
import { platform } from '@/platform';
import { readBool, readEnum, readStr } from '../codec';
import type { ChannelConnectAction } from '@/platform/types';
import type { ChannelKind } from '@/types';

/** 引擎声明的连接状态机（取值即 wire 枚举） */
export const CHANNEL_CONNECT_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
] as const;

export type ChannelConnectStatus = (typeof CHANNEL_CONNECT_STATUSES)[number];

/**
 * 解码后的扫码结果（渲染层只认它）。
 *
 * `status` 刻意**可选**：引擎没给状态（或给了我们不认识的值）时应当「什么都不做」
 * 而不是猜一个——状态机那边的 `default` 分支就是为它留的（与收口前行为一致）。
 */
export interface ChannelConnectResult {
  status?: ChannelConnectStatus;
  /** 连接会话 id（poll / cancel 需回传） */
  sessionId?: string;
  /** 二维码内容：微信是图片直链，飞书 / Lark 是待编码授权链接（渲染层自行分辨） */
  qrUrl?: string;
  /** 建议轮询间隔（毫秒） */
  intervalMs?: number;
  /** 会话过期时间戳（毫秒） */
  expiresAtMs?: number;
  /** 服务端附加提示 */
  message?: string;
  /** 额外验证挑战（当前只有 `verify_code`） */
  challenge?: string;
  /** 验证码校验是否失败（`challenge=verify_code` 场景） */
  verificationFailed?: boolean;
  /** 目标实例 id（飞书 / Lark） */
  instanceId?: string;
  /** 目标域（feishu | lark） */
  domain?: string;
  /** 扫码创建的应用 App ID */
  appId?: string;
  /** 微信登录账号标识 */
  account?: string;
  /** 成功后是否需要重启网关才生效 */
  requiresRestart?: boolean;
}

/** 一次扫码协议调用 */
export interface ChannelConnectRequest {
  action: ChannelConnectAction;
  /**
   * 我们的渠道种类。
   *
   * `start` 的起始参数按它索引——**不能按引擎渠道名**：飞书与 Lark 用的是同一个
   * 引擎渠道 `feishu`，但 `domain` / `instance_id` 不同（见下面的 `START_PARAMS`）。
   */
  kind: ChannelKind;
  /** 引擎渠道名（`channelMeta.scanConnect.engineChannel`）；缺省 = `kind` */
  engineChannel?: string;
  /** poll / cancel 携带的连接会话 id */
  sessionId?: string;
  /** 微信 `challenge` 场景的验证码 */
  verifyCode?: string;
  /** 微信失败后重登：透传 `force` */
  force?: boolean;
}

export type ChannelConnectOutcome =
  | { ok: true; result: ChannelConnectResult }
  | { ok: false; error: string };

/**
 * `start` 的起始参数（**wire**，按我们的渠道种类索引）。
 *
 * 原先放在 `channelMeta.scanConnect.startParams` 里，属「UI 元数据表顺手带了协议参数」：
 * `domain` / `instance_id` / `mode` 是网关 `settings.channel.connect.start` 的入参，
 * 与「卡片上显示什么提示」没有任何关系。
 *
 * `mode: 'replace'` 是有意的：扫码接入是「重新创建并覆盖配置」，不 replace 会在已有
 * 应用上叠加出第二套凭据。
 */
const START_PARAMS: Partial<Record<ChannelKind, Record<string, string>>> = {
  feishu: { domain: 'feishu', instance_id: 'feishu', mode: 'replace' },
  lark: { domain: 'lark', instance_id: 'lark', mode: 'replace' },
};

/**
 * 编码：领域请求 → wire 参数（**本仓库出现这些键名的两处之一**）。
 *
 * 起始参数**只给 `start`**：poll / cancel 靠 `session_id` 定位已建立的会话，带上
 * 渠道参数没有意义（与收口前的行为一致——那版把 `startParams` 只用在 `start` 分支）。
 * 这条差一点写错：三个存储动作共用一个 encoder 时，「谁该带什么」最容易顺手全带。
 */
function encodeParams(req: ChannelConnectRequest): Record<string, string> {
  const params: Record<string, string> =
    req.action === 'start' ? { ...(START_PARAMS[req.kind] ?? {}) } : {};
  if (req.sessionId) params.session_id = req.sessionId;
  if (req.verifyCode) params.verify_code = req.verifyCode;
  if (req.force) params.force = 'true';
  return params;
}

/**
 * 解码：wire 载荷 → 领域结果。
 *
 * 一律走 `codec` 的容错读取器并**同时接受两种键名**：网关当前发的是 snake_case，
 * 但引擎侧 pydantic 的 `alias_generator=to_camel` 意味着某天它可能改发 camelCase
 * （其它协议已经出现过这种漂移，见 `codec.ts` 顶部）。缺字段一律落 `undefined`，
 * 由上层决定缺省语义——**不做 `?? 'pending'` 这类猜测**。
 */
export function decodeChannelConnect(raw: unknown): ChannelConnectResult {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const v = entry[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  return {
    status: readEnum(entry, CHANNEL_CONNECT_STATUSES, 'status'),
    sessionId: readStr(entry, 'session_id', 'sessionId'),
    qrUrl: readStr(entry, 'qr_url', 'qrUrl'),
    intervalMs: num('interval_ms', 'intervalMs'),
    expiresAtMs: num('expires_at_ms', 'expiresAtMs'),
    message: readStr(entry, 'message'),
    challenge: readStr(entry, 'challenge'),
    verificationFailed: readBool(entry, 'verification_failed', 'verificationFailed'),
    instanceId: readStr(entry, 'instance_id', 'instanceId'),
    domain: readStr(entry, 'domain'),
    appId: readStr(entry, 'app_id', 'appId'),
    account: readStr(entry, 'account'),
    requiresRestart: readBool(entry, 'requires_restart', 'requiresRestart'),
  };
}

/**
 * 发起一次扫码协议调用：编码 → 经平台层搬运 → 解码。
 *
 * 不抛异常（与 `platform.channelConnect` 的约定一致）：传输失败转成 `ok:false`，
 * 由状态机按退避重试，调用方不必写 try/catch。
 */
export async function channelConnect(
  req: ChannelConnectRequest,
): Promise<ChannelConnectOutcome> {
  const res = await platform.channelConnect(
    req.action,
    req.engineChannel ?? req.kind,
    encodeParams(req),
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, result: decodeChannelConnect(res.result) };
}
