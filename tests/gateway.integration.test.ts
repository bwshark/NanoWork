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
import { NanobotClient } from '@/ai/nanobotClient';
import { useSettingsStore } from '@/stores/settingsStore';

function sseStream(chunks: string[]): string {
  return chunks.map((c) => `data: ${c}\n`).join('') + 'data: [DONE]\n';
}

function makeResponse(bodyText: string, opts: { status?: number; json?: unknown } = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyText));
      controller.close();
    },
  });
  return {
    ok: (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    statusText: 'OK',
    body,
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

  it('probe 命中 /models 返回 connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/models')) {
          return makeResponse('', { json: { data: [{ id: 'nanobot' }] } });
        }
        return makeResponse('', { status: 404 });
      }),
    );
    const status = await client.probe();
    expect(status).toBe('connected');
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

    await client.sendMessage(
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
    await client.sendMessage(
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
    expect(tokens.join('')).toBe('已处理文件。');
  });
});
