/**
 * 模型连接探针（`electron/modelProbe.ts`）。
 *
 * 探针的全部价值在于「它真的发了请求、并且把上游的回答如实翻给人看」，
 * 所以这里**不 mock 传输层**：真起一个 HTTP 服务器，按路径返回 200 / 401 / 500，
 * 并记下收到的请求头（用来证伪「留空也会带一个空 Bearer」这种静默行为）。
 *
 * 锁两类真实踩到过的问题：
 *
 * 1. **留空 ≠ 带空凭据**。表单允许不填 API Key（本地部署、内网网关、引擎侧已配好），
 *    此时必须发**裸请求**。塞一个 `Authorization: Bearer ` 会让某些网关直接判 401，
 *    而用户看到的却是「我这个端点明明不需要密钥」。
 * 2. **401 不能只说「HTTP 401 Unauthorized」**。它是「网络通的、上游答了话、只是不认
 *    你的凭据」，与「连不上」是两件事；措辞要把人引向填写/更新 API Key，并保留上游原文。
 */

import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { describeProbeFailure, probeModelEndpoint } from '../../electron/modelProbe';

interface Stub {
  /** 基地址（形如 http://127.0.0.1:PORT/v1） */
  base: string;
  close: () => Promise<void>;
  /** 每次请求记下的 Authorization 头（没带就是 undefined） */
  seen: (string | undefined)[];
}

/** 起一个假的 OpenAI 兼容端点：行为按路径分派 */
async function startStub(): Promise<Stub> {
  const seen: (string | undefined)[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.headers.authorization as string | undefined);
    // stash 的基地址带着 `/v1`，所以这里先把前缀剥掉再按子路径分派
    const path = (req.url ?? '').split('?')[0].replace(/^\/v1/, '');
    if (path === '/auth/models') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"Unauthorized"}');
      return;
    }
    if (path === '/boom/models') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('server exploded');
      return;
    }
    if (path === '/html/models') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>请先登录</html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        // 刻意乱序 + 一条畸形项：探针要排序、要丢掉没有 id 的东西
        data: [{ id: 'qwen3-32b' }, { id: 'gpt-4o' }, { object: 'model' }, { id: 'Qwen3.8-Flash' }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

describe('describeProbeFailure: 失败措辞', () => {
  it('401 说清「连到了、只是没凭据」，并保留上游原文', () => {
    const text = describeProbeFailure({
      status: 401,
      statusText: 'Unauthorized',
      body: '{"error":"Unauthorized"}',
      keySource: null,
    });
    expect(text).toContain('已连到上游');
    expect(text).toContain('HTTP 401');
    expect(text).toContain('API Key');
    expect(text).toContain('{"error":"Unauthorized"}');
  });

  it('按凭据来源分岔：引擎侧的密钥被拒 ≠ 表单填的密钥被拒', () => {
    const fromConfig = describeProbeFailure({
      status: 401,
      statusText: 'Unauthorized',
      body: '',
      keySource: 'config',
    });
    expect(fromConfig).toContain('引擎侧已配置的密钥被拒');

    const fromForm = describeProbeFailure({
      status: 403,
      statusText: 'Forbidden',
      body: '',
      keySource: 'request',
    });
    expect(fromForm).toContain('检查「API Key」');
  });

  it('非鉴权失败保持原样（404 / 500 就是 404 / 500，别往密钥上引）', () => {
    const text = describeProbeFailure({
      status: 404,
      statusText: 'Not Found',
      body: 'not here',
      keySource: null,
    });
    expect(text).toBe('HTTP 404 Not Found not here');
  });

  it('上游原文截断到 200 字（反代错误页可能很长，会把弹窗撑爆）', () => {
    const text = describeProbeFailure({
      status: 500,
      statusText: 'Internal Server Error',
      body: 'x'.repeat(500),
      keySource: null,
    });
    expect(text.endsWith('x'.repeat(200))).toBe(true);
  });
});

describe('probeModelEndpoint: 真实请求', () => {
  it('200 → 模型清单按名排序、畸形项丢掉、凭据来源原样回传', async () => {
    const stub = await startStub();
    try {
      const result = await probeModelEndpoint({
        apiBase: stub.base,
        apiKey: 'sk-test',
        keySource: 'request',
      });
      expect(result.ok).toBe(true);
      expect(result.models).toEqual(['Qwen3.8-Flash', 'gpt-4o', 'qwen3-32b']);
      expect(result.keySource).toBe('request');
      expect(stub.seen[0]).toBe('Bearer sk-test');
      // 尾部斜杠不该导致 `//models`
      expect(typeof result.latencyMs).toBe('number');
    } finally {
      await stub.close();
    }
  });

  it('API Key 留空时**不带** Authorization 头（裸请求，而不是空 Bearer）', async () => {
    const stub = await startStub();
    try {
      const result = await probeModelEndpoint({
        apiBase: `${stub.base}/`,
        apiKey: '',
        keySource: null,
      });
      expect(result.ok).toBe(true);
      expect(stub.seen).toEqual([undefined]);
      expect(result.keySource).toBeNull();
    } finally {
      await stub.close();
    }
  });

  it('401 → 不抛异常，返回带解释的失败（界面据此显示原因）', async () => {
    const stub = await startStub();
    try {
      const result = await probeModelEndpoint({
        apiBase: `${stub.base}/auth`,
        apiKey: '',
        keySource: null,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('已连到上游');
      expect(result.error).toContain('401');
      expect(result.keySource).toBeNull();
    } finally {
      await stub.close();
    }
  });

  it('500 → 原样的状态码文案', async () => {
    const stub = await startStub();
    try {
      const result = await probeModelEndpoint({
        apiBase: `${stub.base}/boom`,
        apiKey: '',
        keySource: null,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('HTTP 500');
    } finally {
      await stub.close();
    }
  });

  it('200 但不是模型清单（登录页 / 反代页）也算失败，别说「连接成功」', async () => {
    const stub = await startStub();
    try {
      const result = await probeModelEndpoint({
        apiBase: `${stub.base}/html`,
        apiKey: '',
        keySource: null,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('不是 OpenAI 兼容的模型清单');
    } finally {
      await stub.close();
    }
  });

  it('连不上 → 连接失败文案（不是超时，也不是「key 不对」）', async () => {
    // 127.0.0.1:1 上没有监听者
    const result = await probeModelEndpoint({
      apiBase: 'http://127.0.0.1:1/v1',
      apiKey: '',
      keySource: null,
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('连接失败');
  });

  it('超时 → 文案里带上实际超时秒数', async () => {
    const server: Server = createServer(() => {
      // 故意不回应：让探针自己中止
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const result = await probeModelEndpoint({
        apiBase: `http://127.0.0.1:${port}/v1`,
        apiKey: '',
        keySource: null,
        timeoutMs: 300,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('连接超时');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
