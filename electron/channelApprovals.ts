/**
 * IM 会话审批（gateway 侧）的**端点构造与响应解码**纯逻辑层。
 *
 * ## 为什么单独抽出来
 *
 * 仓库惯例：`electron/main.ts` 顶层依赖 Electron app ready 与一堆副作用，**无法被
 * import**，逻辑放在那里就永远测不到。本模块只依赖 `node:url` 与平台类型，可以
 * 直接被单测 import。
 *
 * 抽出来的理由不是「代码好看」，而是这条铁律此前**完全无测试保护**：
 *
 * > IM 轮次的审批 future 挂在 **gateway 进程**的 `PENDING_APPROVALS` 上；
 * > 打到 **serve 进程**（任务视图那条 `POST /v1/tool-approvals/{id}`）会 409，
 * > 而用户看到的是「点了允许，什么都没发生」——**全程零报错**。
 *
 * 两进程各有一张注册表，端口一改就是静默失效：没有任何报错、没有日志、
 * 没有红字，只有「点了没反应」。这种失效必须由测试兜住，不能靠人记。
 *
 * ## 判据形状
 *
 * 端点构造与「用哪个端口」是同一件事，故合在一个模块里：改端口就会连带改到
 * 构造处，测试里也能一眼看出「审批端点 = gateway 端口」。
 */

/** gateway health 端口（审批裁决必须落在这里） */
export const GATEWAY_HEALTH_HOST = '127.0.0.1';
export const GATEWAY_HEALTH_PORT = 18790;

/** 一个待发出的 HTTP 请求描述（主进程据此发包） */
export interface ChannelApprovalRequest {
  host: string;
  port: number;
  path: string;
  method: 'GET' | 'POST';
}

/**
 * 读取某个 IM 会话当前挂着的待裁决审批：`GET /v1/approvals?channel=&chat_id=`。
 *
 * ⚠️ 这是**会话级快照**（无游标、全量语义），不是某个轮次的事件流：
 * IM 触发的轮次桌面端没有登记，拿不到游标。
 */
export function buildChannelApprovalsRequest(
  channel: string,
  chatId: string,
  /** 实际使用的 health 端口（可能被顺延，见 `enginePorts.ts`）；缺省用默认值 */
  port: number = GATEWAY_HEALTH_PORT,
): ChannelApprovalRequest {
  const query = new URLSearchParams({ channel, chat_id: chatId });
  return {
    host: GATEWAY_HEALTH_HOST,
    port,
    path: `/v1/approvals?${query.toString()}`,
    method: 'GET',
  };
}

/**
 * 裁决一条待裁决审批：`POST /v1/approvals/resolve`。
 *
 * ⚠️ 与任务视图的 `POST /v1/tool-approvals/{id}` **不是同一个端点**：
 * 前者落在 gateway 进程，后者落在 serve 进程。两张注册表互不可见。
 */
export function buildChannelApprovalResolveRequest(params: {
  channel: string;
  chatId: string;
  requestId: string;
  decision: string;
  reason?: string;
  /** 实际使用的 health 端口（可能被顺延）；缺省用默认值 */
  port?: number;
}): ChannelApprovalRequest & { body: string } {
  return {
    host: GATEWAY_HEALTH_HOST,
    port: params.port ?? GATEWAY_HEALTH_PORT,
    path: '/v1/approvals/resolve',
    method: 'POST',
    body: JSON.stringify({
      channel: params.channel,
      chat_id: params.chatId,
      request_id: params.requestId,
      decision: params.decision,
      reason: params.reason ?? '',
    }),
  };
}

/**
 * 把网关的 snake_case 审批快照解码成渲染层类型；结构不合法返回 null。
 *
 * 未知字段一律丢弃而不是猜：审批卡上「允许」按钮点下去打的是 `id`，
 * 猜错字段名会让用户点了没反应。
 *
 * ⚠️ 缺 `id` 的条目直接**跳过**（而不是补一个假 id）：`id` 是寻址用的唯一凭据，
 * 补出来的假 id 会让裁决打空——引擎那边返回「已过期」，用户以为审批被拒了。
 */
export function decodeChannelApprovals(raw: string): {
  ok: boolean;
  approvals: Array<{
    id: string;
    tool: string;
    args: Record<string, unknown>;
    callId?: string;
    timeoutSeconds: number;
    shortCode: string;
  }>;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const wire = parsed as Record<string, unknown>;
  const rawApprovals = Array.isArray(wire.approvals) ? wire.approvals : [];
  const approvals: Array<{
    id: string;
    tool: string;
    args: Record<string, unknown>;
    callId?: string;
    timeoutSeconds: number;
    shortCode: string;
  }> = [];
  for (const entry of rawApprovals) {
    if (!entry || typeof entry !== 'object') continue;
    const ap = entry as Record<string, unknown>;
    if (typeof ap.id !== 'string' || !ap.id) continue;
    approvals.push({
      id: ap.id,
      tool: typeof ap.tool === 'string' ? ap.tool : 'unknown',
      args:
        ap.args && typeof ap.args === 'object'
          ? (ap.args as Record<string, unknown>)
          : {},
      ...(typeof ap.call_id === 'string' && ap.call_id ? { callId: ap.call_id } : {}),
      timeoutSeconds:
        typeof ap.timeout_seconds === 'number' ? ap.timeout_seconds : 300,
      shortCode: typeof ap.short_code === 'string' ? ap.short_code : '',
    });
  }
  return { ok: true, approvals };
}
