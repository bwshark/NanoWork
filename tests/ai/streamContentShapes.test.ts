import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { useSettingsStore, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { DEFAULT_MEMORY_POLICY } from '@/types';
import type { ChatRequest, StreamHandlers } from '@/ai/runtime/types';

/**
 * 收流的**形状**回归：提供方把 `delta.content` 给成内容块数组时，正文与围栏产物
 * 都必须完好。
 *
 * 走真的 `NanobotClient.sendMessage` + 打桩 fetch，而不是只测纯函数 —— 这条链路上
 * 「有人又写了 `fullText += delta.content`」才是真正的回归点（纯函数测试拦不住）。
 */

const enc = new TextEncoder();

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 一段 SSE 响应体 */
function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  });
}

function stubFetch(frames: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = sseBody(frames);
      // 只需 fetchSSE 真正用到的字段（ok / status / headers / body）
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body,
        text: async () => '',
      } as unknown as Response;
    }),
  );
}

/** 跑一轮，收集回调 */
async function runTurn(frames: string[]) {
  stubFetch(frames);
  const tokens: string[] = [];
  const artifacts: Array<{ title?: string; content: string }> = [];
  let done = false;
  const handlers: StreamHandlers = {
    onToken: (chunk) => tokens.push(chunk),
    onToolCall: () => undefined,
    onArtifact: (ev) => artifacts.push({ title: ev.title, content: ev.content }),
    onStatus: () => undefined,
    onDone: () => {
      done = true;
    },
    onError: (err) => {
      throw err;
    },
  } as StreamHandlers;

  const req: ChatRequest = {
    agentId: 'agent-test',
    messages: [{ role: 'user', content: '帮我生成一个 Web GIS 专家' }],
    stream: true,
  };
  await new NanobotClient().sendMessage(req, handlers).done;
  return { tokens, artifacts, done };
}

beforeEach(() => {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      processDetail: 'key',
      memoryEnabled: false,
      autoSummarize: false,
      memoryRecall: true,
      memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
      transcription: {
        enabled: false,
        provider: 'groq',
        endpoint: '',
        model: 'whisper-1',
        apiToken: '',
        language: 'zh',
      },
      desktop: DEFAULT_DESKTOP,
    },
    status: 'offline',
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('内容块数组形态的 delta', () => {
  it('正文按 text 块拼接，围栏产物拿到完整 JSON（不再出现 [object Object]）', async () => {
    const json = '{"kind":"agent","name":"Web GIS 三维开发专家"}';
    const { tokens, artifacts, done } = await runTurn([
      sseFrame({ choices: [{ delta: { content: '已按你的要求生成：\n```nanowork-expert\n' } }] }),
      // ⚠️ 关键帧：正文包成内容块数组（真实提供方会这么干）
      sseFrame({
        choices: [
          {
            delta: {
              content: [
                { type: 'text', text: '{"kind":"agent",' },
                { type: 'text', text: '"name":"Web GIS 三维开发专家"}' },
              ],
            },
          },
        ],
      }),
      sseFrame({ choices: [{ delta: { content: '\n```' } }] }),
      'data: [DONE]\n\n',
    ]);

    expect(done).toBe(true);
    const joined = tokens.join('');
    expect(joined).not.toContain('[object Object]');
    expect(joined).toContain('```nanowork-expert');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('代码块 (nanowork-expert) 1');
    // 围栏内容必须还是一条合法可解析的 JSON（着色与下载扩展名都读它）
    expect(artifacts[0].content).toBe(json);
    expect(() => JSON.parse(artifacts[0].content)).not.toThrow();
  });

  it('纯字符串 delta 的行为零变化（老链路回归）', async () => {
    const { tokens, artifacts } = await runTurn([
      sseFrame({ choices: [{ delta: { content: '```js\nconst a = 1;\n```' } }] }),
      'data: [DONE]\n\n',
    ]);
    expect(tokens.join('')).toBe('```js\nconst a = 1;\n```');
    expect(artifacts[0].content).toBe('const a = 1;');
  });

  it('只有非正文块（tool_use / image）的帧不进正文，也不打点首字', async () => {
    const { tokens } = await runTurn([
      sseFrame({
        choices: [{ delta: { content: [{ type: 'tool_use', id: 't1', name: 'read_file' }] } }],
      }),
      sseFrame({ choices: [{ delta: { content: '好' } }] }),
      'data: [DONE]\n\n',
    ]);
    expect(tokens).toEqual(['好']);
  });
});
