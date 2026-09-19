/**
 * nanobot 网关端到端验证（协议层）。
 *
 * 策略：沙箱无 nanobot 运行时且端口受限，无法直接连真实网关。
 * 本测试用 monkeypatch 的 `global.fetch` 模拟「OpenAI 兼容 SSE」网关行为，
 * 真实跑通 NanobotClient 的 sendMessage 全链路：
 *   delta.content 文本流 → ToolCallAccumulator 增量解析 → artifact 启发式提取。
 * 同时验证 probe()/listModels()。
 * 真实网关联调步骤见 docs/gateway-e2e.md。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { useSettingsStore } from '@/stores/settingsStore';

// 合法 SSE：每个事件以「双换行」结束（`data: {...}\n\n`）。
// sse.parseSSEBuffer 按标准事件边界切分，缺空行会导致所有帧被合并成一个事件。
function sseStream(chunks: string[]): string {
  return chunks.map((c) => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n';
}

function makeResponse(
  bodyText: string,
  opts: { status?: number; json?: unknown; contentType?: string } = {},
) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyText));
      controller.close();
    },
  });
  const contentType = opts.contentType ?? 'text/event-stream; charset=utf-8';
  return {
    ok: (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    statusText: 'OK',
    body,
    // NanobotClient.fetchSSE 会读 content-type 判断走「SSE 流」还是
    // 「非流式完整 JSON」分支；真实 Response 必然带 headers，这里补齐。
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? contentType : null,
    },
    async text() {
      return bodyText;
    },
    async json() {
      return opts.json;
    },
  } as unknown as Response;
}

// 运行时拼出 tool_calls 的 arguments 分片，避免在源码里直接书写含引号/花括号的字符串字面量
const ARG_FULL = JSON.stringify({ path: '/tmp/x.txt' }); // 形如 {"path":"/tmp/x.txt"}
const ARG_PART1 = ARG_FULL.slice(0, 9); // {"path":
const ARG_PART2 = ARG_FULL.slice(9); // "/tmp/x.txt"}

const SAMPLE_SSE = sseStream([
  JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] }),
  JSON.stringify({ choices: [{ delta: { content: '好的，我来帮你画图。\n' } }] }),
  // tool_calls 增量（标准 OpenAI 风格）
  JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file' } },
          ],
        },
      },
    ],
  }),
  JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ARG_PART1 } }] } }],
  }),
  JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ARG_PART2 } }] } }],
  }),
  // 富产物：mermaid + python 围栏块
  JSON.stringify({
    choices: [
      {
        delta: {
          content:
            '\n```mermaid\nflowchart TD\n A-->B\n```\n\n```python\nprint(1)\n```\n',
        },
      },
    ],
  }),
]);

describe('NanobotClient 网关端到端（OpenAI 兼容 SSE）', () => {
  let client: NanobotClient;

  beforeEach(() => {
    useSettingsStore.getState().setSettings({
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
    });
    client = new NanobotClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('probe 优先打 /health（常量接口），命中即 connected 且只发一次请求', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return makeResponse('', { json: { status: 'ok' } });
      }),
    );
    expect(await client.probe()).toBe('connected');
    // 根路径的 /health，不是 /v1/health
    expect(urls).toEqual(['http://127.0.0.1:8765/health']);
  });

  it('probe 在 /health 缺失（404）时回退 /models，并记住结论不再重试 /health', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        if (String(url).endsWith('/health')) return makeResponse('', { status: 404 });
        return makeResponse('', { json: { data: [{ id: 'nanobot' }] } });
      }),
    );
    expect(await client.probe()).toBe('connected');
    expect(urls).toEqual([
      'http://127.0.0.1:8765/health',
      'http://127.0.0.1:8765/v1/models',
    ]);

    // 第二次：结论已缓存，不该再吃一个 404——否则第三方端点每次心跳都要多一次往返
    urls.length = 0;
    expect(await client.probe()).toBe('connected');
    expect(urls).toEqual(['http://127.0.0.1:8765/v1/models']);
  });

  it('probe 在 /health 网络层失败时报 offline，且不回退 /models', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(await client.probe()).toBe('offline');
    // 网关真的不可达：再打 /models 也是白费一次往返
    expect(urls).toEqual(['http://127.0.0.1:8765/health']);
  });

  it('probe 对 /health 的 5xx 回退但不写缓存（临时故障不该永久降级）', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        if (String(url).endsWith('/health')) return makeResponse('', { status: 503 });
        return makeResponse('', { json: { data: [] } });
      }),
    );
    expect(await client.probe()).toBe('connected'); // 回退 /models 拿到 200

    urls.length = 0;
    expect(await client.probe()).toBe('connected');
    expect(urls[0]).toBe('http://127.0.0.1:8765/health'); // 下次仍先试 /health
  });

  it('probe 在 /health 与 /models 都不通时报 offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/health')) return makeResponse('', { status: 404 });
        return makeResponse('', { status: 401 });
      }),
    );
    expect(await client.probe()).toBe('offline');
  });

  it('listModels 解析 /models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/models')) {
          return makeResponse('', { json: { data: [{ id: 'nanobot', label: 'nanobot' }] } });
        }
        return makeResponse(SAMPLE_SSE);
      }),
    );
    const models = await client.listModels();
    expect(models).toEqual([
      { id: 'nanobot', label: 'nanobot', model: 'nanobot' },
    ]);
  });

  it('sendMessage 全链路：文本流 + tool_calls 增量解析 + artifact 提取', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse(SAMPLE_SSE)),
    );

    const tokens: string[] = [];
    const toolCalls: Array<{ tool: string; status: string; args?: unknown }> = [];
    const artifacts: Array<{ type: string; language?: string }> = [];
    let doneCount = 0;
    const statuses: string[] = [];

    const handle = client.sendMessage(
      { agentId: 'a', messages: [{ role: 'user', content: 'hi' }], stream: true },
      {
        onToken: (t) => tokens.push(t),
        onToolCall: (t) => toolCalls.push({ tool: t.tool, status: t.status, args: t.args }),
        onArtifact: (a) => artifacts.push({ type: a.type, language: a.language }),
        onStatus: (s) => statuses.push(s),
        onDone: () => {
          doneCount += 1;
        },
        onError: () => undefined,
      },
    );
    // sendMessage 返回 ChatHandle 而非 Promise：必须等 handle.done，
    // 否则断言会与流式解析竞态（生产代码 sessionsStore 同样 await handle.done）。
    await handle.done;

    expect(doneCount).toBe(1);
    const full = tokens.join('');
    expect(full).toContain('我来帮你画图');
    expect(full).toContain('flowchart TD');

    // tool_calls：既有 pending（权限门控前），又有 flush 后的 done + 解析后的 args
    expect(toolCalls.some((t) => t.tool === 'read_file' && t.status === 'pending')).toBe(true);
    const done = toolCalls.find((t) => t.status === 'done' && t.tool === 'read_file');
    expect(done).toBeTruthy();
    expect(done?.args).toEqual({ path: '/tmp/x.txt' });

    // artifact：mermaid + python 均被提取
    expect(artifacts.some((a) => a.type === 'mermaid')).toBe(true);
    expect(artifacts.some((a) => a.type === 'code' && a.language === 'python')).toBe(true);
  });

  it('sendMessage 走文件上传分支（multipart）也能解析文本流', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse(sseStream([JSON.stringify({ choices: [{ delta: { content: '已处理文件。' } }] })]))),
    );
    const tokens: string[] = [];
    const handle = client.sendMessage(
      {
        agentId: 'a',
        messages: [{ role: 'user', content: '看图' }],
        stream: true,
        files: [{ name: 'x.png', content: '', mimeType: 'image/png' }],
      },
      {
        onToken: (t) => tokens.push(t),
        onToolCall: () => undefined,
        onArtifact: () => undefined,
        onStatus: () => undefined,
        onDone: () => undefined,
        onError: () => undefined,
      },
    );
    await handle.done;
    expect(tokens.join('')).toBe('已处理文件。');
  });
});

/**
 * 逐条批准（FR-1.5）的传输层：请求透传开关、SSE 事件解析、裁决回传。
 * 引擎侧挂起等裁决的行为由 nanobot 的 pytest 覆盖（tests/test_api_tool_approval.py
 * 与 tests/agent/test_tool_approval.py）。
 */
describe('NanobotClient 逐条批准通道 (FR-1.5)', () => {
  let client: NanobotClient;

  beforeEach(() => {
    useSettingsStore.getState().setSettings({
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
    });
    client = new NanobotClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 一个只包含审批请求事件的 SSE 流 */
  const APPROVAL_SSE = sseStream([
    JSON.stringify({
      choices: [
        {
          delta: {
            nanobot_event: {
              kind: 'approval_request',
              id: 'appr-1',
              tool: 'write_file',
              args: { path: 'demo.txt', content: 'hi' },
              call_id: 'call-9',
            },
          },
        },
      ],
    }),
  ]);

  it('解析 nanobot_event.kind=approval_request 并映射到 onApprovalRequest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(APPROVAL_SSE)));

    const seen: Array<{ id: string; tool: string; args: unknown; callId?: string }> = [];
    const handle = client.sendMessage(
      { agentId: 'a', messages: [{ role: 'user', content: 'hi' }], stream: true },
      {
        onToken: () => undefined,
        onToolCall: () => undefined,
        onArtifact: () => undefined,
        onStatus: () => undefined,
        onApprovalRequest: (r) =>
          seen.push({ id: r.id, tool: r.tool, args: r.args, callId: r.callId }),
        onDone: () => undefined,
        onError: () => undefined,
      },
    );
    await handle.done;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      id: 'appr-1',
      tool: 'write_file',
      args: { path: 'demo.txt', content: 'hi' },
      callId: 'call-9',
    });
  });

  it('JSON 请求体透传 approval_mode', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return makeResponse(sseStream([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]));
      }),
    );

    const handle = client.sendMessage(
      {
        agentId: 'a',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        sessionId: 's1',
        approvalMode: 'ask',
      },
      {
        onToken: () => undefined,
        onToolCall: () => undefined,
        onArtifact: () => undefined,
        onStatus: () => undefined,
        onDone: () => undefined,
        onError: () => undefined,
      },
    );
    await handle.done;

    const body = JSON.parse(bodies[0]) as Record<string, unknown>;
    expect(body.approval_mode).toBe('ask');
    expect(body.session_id).toBe('s1');
  });

  it('multipart 请求体携带 approval_mode', async () => {
    const forms: FormData[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        forms.push(init.body as FormData);
        return makeResponse(sseStream([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]));
      }),
    );

    const handle = client.sendMessage(
      {
        agentId: 'a',
        messages: [{ role: 'user', content: '看图' }],
        stream: true,
        approvalMode: 'ask',
        files: [{ name: 'x.png', content: '', mimeType: 'image/png' }],
      },
      {
        onToken: () => undefined,
        onToolCall: () => undefined,
        onArtifact: () => undefined,
        onStatus: () => undefined,
        onDone: () => undefined,
        onError: () => undefined,
      },
    );
    await handle.done;

    expect(forms[0].get('approval_mode')).toBe('ask');
  });

  it('respondApproval POST 到 /tool-approvals/{id} 并带裁决与原因', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return makeResponse('', { json: { ok: true } });
      }),
    );

    await client.respondApproval('appr-42', 'deny', '不要动这个文件');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:8765/v1/tool-approvals/appr-42');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      decision: 'deny',
      reason: '不要动这个文件',
    });
  });

  it('respondApproval 遇到 404 抛出具名错误（请求已失效）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse('', { status: 404 })),
    );

    await expect(client.respondApproval('appr-gone', 'allow')).rejects.toThrow(/已失效/);
  });
});
