/**
 * 每轮知识库检索（FR-2.3 / FR-4.7）：**永不抛、会超时、失败只是"这轮没资料"**。
 *
 * 这一层的存在意义就是别让"云端可选能力"拖垮整轮发送。所以下面每条失败路径都
 * 断言两件事：`section === ''`（不注入）**且** 函数正常返回（不抛给调用方）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KNOWLEDGE_TOP_K,
  getKnowledgeSearchProvider,
  resolveKnowledgeSection,
  setKnowledgeSearchProvider,
} from '@/lib/agent/agentKnowledgeTurn';
import type { KbSearchHit } from '@/lib/kb/kbClient';

const HIT: KbSearchHit = {
  chunkId: 'c1',
  docId: 'd1',
  docTitle: '差旅制度',
  kbId: 'k1',
  score: 0.5,
  snippet: '报销流程：走财务邮箱。',
};

const BINDING = { orgId: 'o1', kbIds: ['k1', 'k2'] };

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // 检索失败时本模块会打一行 warn（"静默降级不能连日志都静默"）：
  // 用例里把它收掉，同时**断言它确实打了**，否则这条约束没人守。
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // 全局注入必须清干净：留下来会让下一个用例用上一个的桩
  setKnowledgeSearchProvider(null);
  vi.restoreAllMocks();
});

describe('跳过检索的三种情形', () => {
  it('没有绑定：不请求，也不留 warn 噪声', async () => {
    const search = vi.fn();
    const result = await resolveKnowledgeSection({ binding: undefined, query: '报销', search });
    expect(result).toMatchObject({ section: '', reason: 'no-binding', hitCount: 0 });
    expect(search).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('没有检索词（用户只发了附件之类）：不请求', async () => {
    const search = vi.fn();
    const result = await resolveKnowledgeSection({ binding: BINDING, query: '   ', search });
    expect(result.reason).toBe('no-query');
    expect(search).not.toHaveBeenCalled();
  });

  it('未登录（没有注入 provider）：跳过，且**不是**报错', async () => {
    const result = await resolveKnowledgeSection({ binding: BINDING, query: '报销' });
    expect(result.reason).toBe('not-logged-in');
    expect(getKnowledgeSearchProvider()).toBeNull();
  });
});

describe('检索成功', () => {
  it('把绑定与检索词原样交给 provider，并把命中渲染成段', async () => {
    const search = vi.fn().mockResolvedValue({ ok: true, data: [HIT] });
    const result = await resolveKnowledgeSection({ binding: BINDING, query: ' 报销 ', search });

    expect(search).toHaveBeenCalledWith({
      orgId: 'o1',
      kbIds: ['k1', 'k2'],
      query: '报销',
      topK: KNOWLEDGE_TOP_K,
    });
    expect(result.reason).toBe('injected');
    expect(result.hitCount).toBe(1);
    expect(result.section).toContain('<knowledge_context>');
    expect(result.section).toContain('差旅制度');
  });

  it('「整个组织」的绑定（kbIds 为空）原样下传空数组——是否省略字段由 provider 决定', async () => {
    const search = vi.fn().mockResolvedValue({ ok: true, data: [HIT] });
    await resolveKnowledgeSection({
      binding: { orgId: 'o1', kbIds: [] },
      query: '报销',
      search,
    });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ kbIds: [] }));
  });

  it('命中都不可用（0 分 / 空正文）→ 不注入', async () => {
    const search = vi.fn().mockResolvedValue({ ok: true, data: [{ ...HIT, score: 0 }] });
    const result = await resolveKnowledgeSection({ binding: BINDING, query: '报销', search });
    expect(result).toMatchObject({ section: '', reason: 'empty' });
  });

  it('可以显式指定 provider（优先于全局注入）', async () => {
    setKnowledgeSearchProvider(vi.fn().mockResolvedValue({ ok: true, data: [HIT] }));
    const explicit = vi.fn().mockResolvedValue({ ok: true, data: [] });
    const result = await resolveKnowledgeSection({
      binding: BINDING,
      query: '报销',
      search: explicit,
    });
    expect(explicit).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('empty');
  });
});

describe('失败一律降级为「本轮没有资料」', () => {
  it('403（绑定过期 / 角色被降级）：不注入、不抛，且留一行 warn', async () => {
    const search = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      message: '当前角色无权访问该知识库',
      unauthorized: false,
    });
    const result = await resolveKnowledgeSection({ binding: BINDING, query: '报销', search });

    expect(result.section).toBe('');
    expect(result.reason).toBe('error');
    expect(result.message).toContain('无权访问');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('403'));
  });

  it('401 单独记为「未登录」（不是云端故障，别让人去查服务）', async () => {
    const search = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      message: '未登录',
      unauthorized: true,
    });
    const result = await resolveKnowledgeSection({ binding: BINDING, query: '报销', search });
    expect(result.reason).toBe('not-logged-in');
  });

  it('provider 抛错（网络层）：不注入、不抛', async () => {
    const search = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const result = await resolveKnowledgeSection({ binding: BINDING, query: '报销', search });
    expect(result).toMatchObject({ section: '', reason: 'error', message: 'fetch failed' });
  });

  it('超时：到点就放弃，而不是等云端想明白', async () => {
    // 永不 resolve 的桩：模拟云端卡住
    const search = vi.fn().mockReturnValue(new Promise(() => {}));
    const result = await resolveKnowledgeSection({
      binding: BINDING,
      query: '报销',
      search,
      timeoutMs: 20,
    });
    expect(result.section).toBe('');
    expect(result.reason).toBe('timeout');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('超时'));
  });

  it('超时后 provider 才返回也不会再影响结果（已降级，不再注入）', async () => {
    let release: (value: unknown) => void = () => {};
    const search = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const result = await resolveKnowledgeSection({
      binding: BINDING,
      query: '报销',
      search,
      timeoutMs: 10,
    });
    expect(result.reason).toBe('timeout');
    release({ ok: true, data: [HIT] });
    await Promise.resolve();
    expect(result.section).toBe('');
  });
});
