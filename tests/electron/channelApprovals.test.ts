/**
 * IM 会话审批端点（gateway 侧）的**落点与解码**判据。
 *
 * ## 为什么这批用例值得存在
 *
 * IM 轮次的审批 future 挂在 **gateway 进程**的 `PENDING_APPROVALS` 上；任务视图那条
 * `POST /v1/tool-approvals/{id}` 落在 **serve 进程**。两进程各有一张注册表，互不可见。
 *
 * 于是「裁决打错进程」是本项目里最阴的一类失效：
 *
 * | 打到 | 引擎返回 | 用户看到 |
 * |---|---|---|
 * | serve（错） | 409 / 未找到 | 「点了允许，什么都没发生」 |
 * | gateway（对） | 200 | 回执 + 工具真的执行 |
 *
 * **全程零报错、零日志、零红字**。没有测试兜住的话，改错端口这件事会一路活到
 * 真机上才被发现，而那时用户已经把审批卡点烂了。
 *
 * 另外两个判据同样静默：
 * - 缺 `id` 的条目若被补一个假 id → 裁决打空 → 引擎说「已过期」→ 用户以为被拒了；
 * - `chat_id` 若被 URL 编码坏了 → 查的是另一个会话的注册表 → 那张卡永远不出现。
 */

import { describe, expect, it } from 'vitest';
import {
  GATEWAY_HEALTH_HOST,
  GATEWAY_HEALTH_PORT,
  buildChannelApprovalResolveRequest,
  buildChannelApprovalsRequest,
  decodeChannelApprovals,
} from '../../electron/channelApprovals';

describe('审批端点必须落在 gateway 进程', () => {
  it('⭐ 查询端点打在 gateway health 端口，不是 serve 端口', () => {
    const req = buildChannelApprovalsRequest('feishu.feishu', 'oc_v3_abc123');

    expect(req.host).toBe(GATEWAY_HEALTH_HOST);
    expect(req.port).toBe(GATEWAY_HEALTH_PORT);
    // serve 的默认端口是 18900：审批打到这里就会 409
    expect(req.port).not.toBe(18900);
  });

  it('⭐ 裁决端点打在 gateway health 端口，不是 serve 端口', () => {
    const req = buildChannelApprovalResolveRequest({
      channel: 'feishu.feishu',
      chatId: 'oc_v3_abc123',
      requestId: 'appr-1',
      decision: 'allow',
    });

    expect(req.host).toBe(GATEWAY_HEALTH_HOST);
    expect(req.port).toBe(GATEWAY_HEALTH_PORT);
    expect(req.port).not.toBe(18900);
  });

  it('⭐ 裁决路径不是任务视图那条（两进程各有一张注册表，混用必 409）', () => {
    const req = buildChannelApprovalResolveRequest({
      channel: 'feishu.feishu',
      chatId: 'oc_v3_abc123',
      requestId: 'appr-1',
      decision: 'allow',
    });

    expect(req.path).toBe('/v1/approvals/resolve');
    // 任务视图那条落在 serve 进程，绝不能串
    expect(req.path).not.toContain('/v1/tool-approvals');
    expect(req.method).toBe('POST');
  });

  it('查询端点带 channel 与 chat_id 两个查询参数', () => {
    const req = buildChannelApprovalsRequest('feishu.feishu', 'oc_v3_abc123');

    expect(req.method).toBe('GET');
    expect(req.path).toContain('/v1/approvals?');
    expect(req.path).toContain('channel=feishu.feishu');
    expect(req.path).toContain('chat_id=oc_v3_abc123');
  });

  it('⭐ chatId 含特殊字符时正确 URL 编码（编码坏了 = 查另一个会话）', () => {
    const req = buildChannelApprovalsRequest('feishu.feishu', 'oc a+b&c');

    // 空格是 %20（URLSearchParams 用 + 表示空格，但这里我们查的是它自己的编码结果）
    expect(req.path).toContain('chat_id=');
    expect(req.path).not.toContain('oc a+b&c');
    // 关键：不能把 & 裸露出来——那会把 chat_id 截断，后半截被当成别的参数
    expect(req.path.split('?')[1].split('&')).toHaveLength(2);
  });
});

describe('裁决请求体', () => {
  it('字段名是 snake_case（网关 wire 格式）', () => {
    const req = buildChannelApprovalResolveRequest({
      channel: 'feishu.feishu',
      chatId: 'oc_v3_abc123',
      requestId: 'appr-xyz',
      decision: 'allow',
      reason: '这次允许',
    });

    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toEqual({
      channel: 'feishu.feishu',
      chat_id: 'oc_v3_abc123',
      request_id: 'appr-xyz',
      decision: 'allow',
      reason: '这次允许',
    });
  });

  it('拒绝理由缺省补空串（不是 undefined —— 网关那边按字符串读）', () => {
    const req = buildChannelApprovalResolveRequest({
      channel: 'feishu.feishu',
      chatId: 'oc_v3_abc123',
      requestId: 'appr-xyz',
      decision: 'deny',
    });

    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.reason).toBe('');
  });
});

describe('审批快照解码', () => {
  it('snake_case 解成 camelCase', () => {
    const decoded = decodeChannelApprovals(
      JSON.stringify({
        ok: true,
        session_key: 'feishu.feishu:oc_v3_abc123',
        approvals: [
          {
            id: 'appr-1',
            tool: 'write_file',
            args: { path: 'D:/tmp/a.js' },
            call_id: 'call_1',
            timeout_seconds: 300,
            short_code: 'xxxxxxx1',
          },
        ],
      }),
    );

    expect(decoded).not.toBeNull();
    expect(decoded!.approvals[0]).toEqual({
      id: 'appr-1',
      tool: 'write_file',
      args: { path: 'D:/tmp/a.js' },
      callId: 'call_1',
      timeoutSeconds: 300,
      shortCode: 'xxxxxxx1',
    });
  });

  it('⭐ 缺 id 的条目跳过（补假 id 会让裁决打空 → 引擎说「已过期」）', () => {
    const decoded = decodeChannelApprovals(
      JSON.stringify({
        approvals: [
          { tool: 'write_file', args: {} },
          { id: '', tool: 'read_file', args: {} },
          { id: 'appr-ok', tool: 'write_file', args: {} },
        ],
      }),
    );

    expect(decoded!.approvals).toHaveLength(1);
    expect(decoded!.approvals[0].id).toBe('appr-ok');
  });

  it('非法 JSON / 非对象 → null（调用方据此报「解析失败」）', () => {
    expect(decodeChannelApprovals('not json')).toBeNull();
    expect(decodeChannelApprovals('null')).toBeNull();
    expect(decodeChannelApprovals('"str"')).toBeNull();
    expect(decodeChannelApprovals('123')).toBeNull();
  });

  it('顶层是数组 → 空列表而不是 null（数组也是 object，approvals 取不到）', () => {
    // 刻意不判 null：网关不会返回数组，但真返回了也不该让渲染层崩。
    expect(decodeChannelApprovals('[]')!.approvals).toEqual([]);
  });

  it('approvals 缺失或不是数组 → 空列表（不是抛错）', () => {
    expect(decodeChannelApprovals('{}')!.approvals).toEqual([]);
    expect(decodeChannelApprovals('{"approvals": "x"}')!.approvals).toEqual([]);
    expect(decodeChannelApprovals('{"approvals": [null, 1]}')!.approvals).toEqual([]);
  });

  it('缺省字段有兜底值（tool/args/timeout/short_code）', () => {
    const decoded = decodeChannelApprovals(
      JSON.stringify({ approvals: [{ id: 'appr-1' }] }),
    );

    expect(decoded!.approvals[0]).toEqual({
      id: 'appr-1',
      tool: 'unknown',
      args: {},
      timeoutSeconds: 300,
      shortCode: '',
    });
  });
});
