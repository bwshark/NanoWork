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
import type { ChatRequest, StreamHandlers } from '@/ai/runtime/types';
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

/**
 * 长任务与静默超时（idle timeout）。
 *
 * 回归问题：客户端原先按**总时长**掐表（固定 120s），像「帮我写一个俄罗斯方块
 * 小游戏，保存在本地」这种多轮工具调用的任务，流明明在正常推进，也会在第 120
 * 秒被客户端单方面 abort，界面弹「响应超时：超过 120 秒仍未返回完整结果」。
 *
 * 现在的语义是静默超时：任何一次数据到达（含 keep-alive 注释帧）都把计时器归零，
 * 只有连续 idleWindow 收不到任何字节才判定断链。用假定时器推进时间去验证，
 * 免得测试真的等上几分钟。
 */
describe('NanobotClient 长任务与静默超时', () => {
  let client: NanobotClient;
  const encoder = new TextEncoder();

  /** 可手动喂数据的响应体流；signal 中断时让 read() 抛错（与真实 fetch 的 abort 行为一致） */
  interface ControllableStream {
    response: Response;
    /** 推入原始 SSE 文本（可以是 keep-alive 注释帧） */
    push: (raw: string) => void;
    /** 推入一条 `delta.content` 帧 */
    pushContent: (content: string) => void;
    close: () => void;
  }

  function controllableStream(signal?: AbortSignal): ControllableStream {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    // 真实 fetch 在 signal abort 时会让挂起的 read() 抛 AbortError；假流必须同样中断，
    // 否则超时后 read() 永不返回，超时用例会一直等不到 handle.done。
    signal?.addEventListener('abort', () => {
      try {
        ctrl.error(new DOMException('Aborted', 'AbortError'));
      } catch {
        // 流已关闭 / 已出错：忽略
      }
    });
    return {
      response: {
        ok: true,
        status: 200,
        statusText: 'OK',
        body,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type'
              ? 'text/event-stream; charset=utf-8'
              : null,
        },
        async text() {
          return '';
        },
        async json() {
          return {};
        },
      } as unknown as Response,
      push: (raw) => ctrl.enqueue(encoder.encode(raw)),
      pushContent: (content) =>
        ctrl.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
        ),
      close: () => ctrl.close(),
    };
  }

  /**
   * 替换 fetch 为「可手动喂数据」的流。
   * `stream()` 在请求建立后即可取用（假 fetch 在第一个微任务前就同步返回了响应）。
   */
  function stubStreamFetch(): { stream: () => ControllableStream } {
    let current: ControllableStream | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        current = controllableStream(init.signal ?? undefined);
        return current.response;
      }),
    );
    return {
      stream: () => {
        if (!current) throw new Error('请求尚未建立：假 fetch 还没被调用');
        return current;
      },
    };
  }

  /** 假定时器下清空微任务队列（被测链路的 fetch / read 全是微任务，只有超时用宏任务） */
  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }

  /** 收集回调，避免每个用例重复写十行空实现 */
  function collect(): { seen: { tokens: string[]; errors: string[]; done: number }; handlers: StreamHandlers } {
    const seen = { tokens: [] as string[], errors: [] as string[], done: 0 };
    const handlers: StreamHandlers = {
      onToken: (t) => seen.tokens.push(t),
      onToolCall: () => undefined,
      onArtifact: () => undefined,
      onStatus: () => undefined,
      onDone: () => {
        seen.done += 1;
      },
      onError: (e) => seen.errors.push(e.message),
    };
    return { seen, handlers };
  }

  /** 用户报障的原话：无附件的纯文本长任务 */
  const LONG_TASK_REQ: ChatRequest = {
    agentId: 'a',
    messages: [{ role: 'user', content: '帮我写一个俄罗斯方块小游戏，保存在本地。' }],
    stream: true,
    sessionId: 's1',
  };

  beforeEach(() => {
    useSettingsStore.getState().setSettings({
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
    });
    client = new NanobotClient();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('流持续有数据时，总时长数倍于基准窗口也不会被掐断', async () => {
    const fake = stubStreamFetch();
    const { seen, handlers } = collect();
    const startedAt = Date.now();
    const handle = client.sendMessage(LONG_TASK_REQ, handlers);

    // 每 90 秒喂一帧，累计 630 秒：是 120s 基准窗口的 5 倍多。
    // 旧实现（总时长固定 120s）必然在第 120 秒 abort；新实现只要链路在动就一直跑。
    for (let i = 0; i < 7; i += 1) {
      await vi.advanceTimersByTimeAsync(90_000);
      fake.stream().pushContent(`t${i}`);
      await flush();
    }
    fake.stream().push('data: [DONE]\n\n');
    fake.stream().close();
    await handle.done;

    expect(Date.now() - startedAt).toBeGreaterThan(600_000);
    expect(seen.errors).toEqual([]);
    expect(seen.done).toBe(1);
    expect(seen.tokens).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6']);
  });

  it('流中途静默超过窗口即判定断链：报错并保留已收到的内容', async () => {
    const fake = stubStreamFetch();
    const { seen, handlers } = collect();
    const handle = client.sendMessage(LONG_TASK_REQ, handlers);

    await flush();
    fake.stream().pushContent('半截回答');
    await flush();
    expect(seen.tokens.join('')).toBe('半截回答');

    // 此后毫无动静：超过基准窗口即 abort，并通过 onError 如实报错
    await vi.advanceTimersByTimeAsync(121_000);
    await handle.done;

    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0]).toContain('已收到部分结果');
    expect(seen.errors[0]).toContain('无新数据');
    // 无附件的场景不该再提示「附件越大网关处理越久」
    expect(seen.errors[0]).not.toContain('附件');
    expect(seen.done).toBe(0);
  });

  it('网关只回了响应头、始终没有内容：文案是「没返回任何内容」而非「已收到部分结果」', async () => {
    // 真实网关会先 prepare() 写出响应头，再长时间思考——此时链路有过字节，
    // 但其实一个字都没产出。文案必须以「有没有负载」为准，否则会误导用户去
    // 检查「残缺的半截回答」。
    const fake = stubStreamFetch();
    const { seen, handlers } = collect();
    const handle = client.sendMessage(LONG_TASK_REQ, handlers);

    await flush();
    expect(fake.stream()).toBeTruthy();
    await vi.advanceTimersByTimeAsync(121_000);
    await handle.done;

    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0]).toContain('没有返回任何内容');
    expect(seen.errors[0]).not.toContain('已收到部分结果');
    expect(seen.errors[0]).not.toContain('附件');
  });

  it('keep-alive 注释帧不产生事件，但同样算链路活跃', async () => {
    const fake = stubStreamFetch();
    const { seen, handlers } = collect();
    const handle = client.sendMessage(LONG_TASK_REQ, handlers);

    await flush();
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(90_000);
      fake.stream().push(': keep-alive\n\n');
      await flush();
    }
    expect(seen.errors).toEqual([]);
    // 注释帧不该被当成内容透传给 UI
    expect(seen.tokens).toEqual([]);

    fake.stream().pushContent('终于来了');
    fake.stream().push('data: [DONE]\n\n');
    fake.stream().close();
    await handle.done;

    expect(seen.tokens.join('')).toBe('终于来了');
    expect(seen.done).toBe(1);
  });

  it('等用户裁决期间的长静默不算断链（引擎本就挂起等人）', async () => {
    const fake = stubStreamFetch();
    const { seen, handlers } = collect();
    const approvals: string[] = [];
    handlers.onApprovalRequest = (r) => approvals.push(r.id);
    const handle = client.sendMessage(LONG_TASK_REQ, handlers);

    await flush();
    const stream = fake.stream();
    stream.push(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              nanobot_event: {
                kind: 'approval_request',
                id: 'appr-1',
                tool: 'write_file',
                args: { path: 'tetris.html' },
              },
            },
          },
        ],
      })}\n\n`,
    );
    await flush();
    expect(approvals).toEqual(['appr-1']);

    // 用户盯着授权弹窗想了 5 分钟：链路上一个字节都没有。
    // 这段静默是人的思考时间，绝不能按断链处理（引擎自己还要等更久才判拒）。
    await vi.advanceTimersByTimeAsync(300_000);
    expect(seen.errors).toEqual([]);

    // 裁决回传后引擎继续输出（respondApproval 走的是另一次 POST，与流无关）
    await client.respondApproval('appr-1', 'allow');
    stream.pushContent('已写入 tetris.html');
    stream.push('data: [DONE]\n\n');
    stream.close();
    await handle.done;

    expect(seen.errors).toEqual([]);
    expect(seen.tokens.join('')).toBe('已写入 tetris.html');
  });

  it('挂起裁决过期后静默超时恢复生效（陈旧 id 不会永久关掉判死）', async () => {
    const fake = stubStreamFetch();
    const { seen, handlers } = collect();
    handlers.onApprovalRequest = () => undefined;
    const handle = client.sendMessage(LONG_TASK_REQ, handlers);

    await flush();
    const stream = fake.stream();
    stream.push(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              nanobot_event: {
                kind: 'approval_request',
                id: 'appr-stale',
                tool: 'write_file',
                args: {},
              },
            },
          },
        ],
      })}\n\n`,
    );
    await flush();

    // 睡过「等裁决」的宽限期（15 分钟）后，这条链路重新接受判死——
    // 否则一个再也不回来的裁决会把所有会话的静默超时永久关掉。
    await vi.advanceTimersByTimeAsync(1_000_000);
    await handle.done;

    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0]).toContain('无新数据');
  });

  it('带附件时静默额度按体积扩容（1MB ≈ 180s，不再是固定 120s）', async () => {
    const fake = stubStreamFetch();
    const { seen, handlers } = collect();
    // 1MB 附件：base64 长度 4/3 倍（且取 4 的整数倍，保证 atob 可解码）
    const file = {
      name: 'big.bin',
      content: 'A'.repeat(1_398_100),
      mimeType: 'application/octet-stream',
    };
    const handle = client.sendMessage({ ...LONG_TASK_REQ, files: [file] }, handlers);

    await flush();
    fake.stream().pushContent('开始处理');
    await flush();

    // 静默 150s：超过 120s 基准，但在 1MB 附件扩容出的 180s 额度内
    await vi.advanceTimersByTimeAsync(150_000);
    expect(seen.errors).toEqual([]);

    fake.stream().push('data: [DONE]\n\n');
    fake.stream().close();
    await handle.done;

    expect(seen.done).toBe(1);
    expect(seen.tokens.join('')).toBe('开始处理');
  });
});
