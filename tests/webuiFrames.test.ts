import { describe, it, expect } from 'vitest';
import { parseWebuiResponseFrame } from '../electron/webuiFrames';

/**
 * 网关认证 WS 桥出站帧匹配层测试（回归防护：响应帧标识键必须是 `event`）。
 *
 * 历史缺陷：桥曾用 `frame.type !== 'webui_response'` 匹配，而引擎出站帧
 * 由 `_send_event` 构造为 `{"event": event, ...}`，导致所有请求 30s 超时。
 */
describe('parseWebuiResponseFrame: 出站帧匹配', () => {
  it('真实网关帧样本（event 标识键）能匹配到 waiter 所需的 request_id 与 ok', () => {
    const raw = JSON.stringify({
      event: 'webui_response',
      request_id: 'r1',
      ok: true,
      result: { status: 'succeeded', session_id: 'sess_1' },
    });
    const frame = parseWebuiResponseFrame(raw);
    expect(frame).not.toBeNull();
    expect(frame!.request_id).toBe('r1');
    expect(frame!.ok).toBe(true);
    expect(frame!.result).toEqual({ status: 'succeeded', session_id: 'sess_1' });
  });

  it('错误响应（ok=false）同样按 event + request_id 匹配，error 字段透传', () => {
    const raw = JSON.stringify({
      event: 'webui_response',
      request_id: 'r2',
      ok: false,
      error: { message: 'channel not found', status: 404 },
    });
    const frame = parseWebuiResponseFrame(raw);
    expect(frame).not.toBeNull();
    expect(frame!.request_id).toBe('r2');
    expect(frame!.ok).toBe(false);
    expect(frame!.error).toEqual({ message: 'channel not found', status: 404 });
  });

  it('回归防护：以 type 为标识键的旧匹配形态不匹配', () => {
    const raw = JSON.stringify({ type: 'webui_response', request_id: 'r3', ok: true });
    expect(parseWebuiResponseFrame(raw)).toBeNull();
  });

  it('入站帧形态（type=webui_request）不匹配', () => {
    const raw = JSON.stringify({
      type: 'webui_request',
      request_id: 'r4',
      action: 'settings.channel.connect.start',
      payload: {},
    });
    expect(parseWebuiResponseFrame(raw)).toBeNull();
  });

  it('心跳 / 其它事件帧忽略', () => {
    expect(parseWebuiResponseFrame(JSON.stringify({ event: 'webui_ping' }))).toBeNull();
    expect(parseWebuiResponseFrame(JSON.stringify({ event: 'channel_message', data: {} }))).toBeNull();
  });

  it('缺少 request_id 的响应帧不匹配（无法路由到 waiter）', () => {
    expect(
      parseWebuiResponseFrame(JSON.stringify({ event: 'webui_response', ok: true })),
    ).toBeNull();
    expect(
      parseWebuiResponseFrame(JSON.stringify({ event: 'webui_response', request_id: '', ok: true })),
    ).toBeNull();
  });

  it('非法 JSON / 非对象数据一律返回 null', () => {
    expect(parseWebuiResponseFrame('not-json')).toBeNull();
    expect(parseWebuiResponseFrame('')).toBeNull();
    expect(parseWebuiResponseFrame('null')).toBeNull();
    expect(parseWebuiResponseFrame('42')).toBeNull();
    expect(parseWebuiResponseFrame('"webui_response"')).toBeNull();
  });
});
