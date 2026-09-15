/**
 * 网关 WebUI 认证 WS 桥的出站帧匹配层（可导出纯函数，便于单元测试）。
 *
 * 帧约定（与引擎 webui 通道实现对齐）：
 * - 入站帧（客户端 → 网关）标识键为 `type`：
 *   `{ "type": "webui_request", request_id, action, payload }`；
 * - 出站帧（网关 → 客户端）标识键为 `event`（引擎 `_send_event` 构造
 *   `{"event": event, ...}`）：
 *   `{ "event": "webui_response", request_id, ok, result | error }`。
 * 两者标识键不同，匹配出站响应帧必须用 `event` 而非 `type`。
 */

/** 网关出站 webui_response 帧结构 */
export interface WebuiResponseFrame {
  /** 出站帧标识键（值为 'webui_response'）；注意不是 `type` */
  event?: string;
  request_id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { message?: string; status?: number };
}

/** 匹配成功的响应帧（request_id 已保证为非空字符串） */
export type MatchedWebuiResponseFrame = WebuiResponseFrame & { request_id: string };

/**
 * 解析网关出站原始帧并判定是否为可匹配的 webui_response。
 * 有效条件：JSON 可解析且为对象，`event === 'webui_response'` 且 `request_id` 非空。
 * 心跳 / 推送帧、使用 `type` 标识的入站帧、损坏数据一律返回 null。
 * @param raw WebSocket message 原始文本
 */
export function parseWebuiResponseFrame(raw: string): MatchedWebuiResponseFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const frame = parsed as WebuiResponseFrame;
  if (frame.event !== 'webui_response' || !frame.request_id) return null;
  return frame as MatchedWebuiResponseFrame;
}
