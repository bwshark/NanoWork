import { describe, expect, it, vi } from 'vitest';

import { resolveProjectMemorySection } from '@/lib/agent/projectMemoryTurn';
import type { ProjectMemory } from '@/lib/project/projectClient';
import type { ApiResult } from '@/lib/net/authedRequest';

const memory = (over: Partial<ProjectMemory> = {}): ProjectMemory => ({
  text: '本项目一律用 pnpm。',
  rev: 3,
  updatedAt: '2026-11-17T10:00:00Z',
  updatedBy: 'boss@corp.example',
  canEdit: false,
  maxChars: 20000,
  ...over,
});

const ok = (data: ProjectMemory): ApiResult<ProjectMemory> => ({ ok: true, data });

describe('resolveProjectMemorySection', () => {
  it('会话不属任何项目时直接跳过，不发请求', async () => {
    const fetch = vi.fn();
    const result = await resolveProjectMemorySection({ fetch });
    expect(result.reason).toBe('no-project');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('没有 provider（未登录）时跳过', async () => {
    const result = await resolveProjectMemorySection({ projectId: 'p1' });
    expect(result.reason).toBe('not-logged-in');
    expect(result.section).toBe('');
  });

  it('读到正文就把段拼好并带回版本号', async () => {
    const result = await resolveProjectMemorySection({
      projectId: 'p1',
      projectName: '登月计划',
      fetch: async () => ok(memory()),
    });
    expect(result.reason).toBe('injected');
    expect(result.section).toContain('<project_memory>');
    expect(result.section).toContain('本项目一律用 pnpm。');
    expect(result.section).toContain('登月计划');
    expect(result.rev).toBe(3);
  });

  it('项目还没写共享记忆时不注入任何东西（不塞占位句）', async () => {
    const result = await resolveProjectMemorySection({
      projectId: 'p1',
      fetch: async () => ok(memory({ text: '   ', rev: 0 })),
    });
    expect(result.reason).toBe('empty');
    expect(result.section).toBe('');
  });

  it('超时降级为「本轮没有共享记忆」，不抛', async () => {
    const result = await resolveProjectMemorySection({
      projectId: 'p1',
      timeoutMs: 5,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return ok(memory());
      },
    });
    expect(result.reason).toBe('timeout');
    expect(result.section).toBe('');
  });

  it('fetch 自己抛异常也只是降级（调用方没有 try/catch）', async () => {
    const result = await resolveProjectMemorySection({
      projectId: 'p1',
      fetch: async () => {
        throw new Error('boom');
      },
    });
    expect(result.reason).toBe('error');
    expect(result.message).toContain('boom');
  });

  it('401 与「读失败」分开：前者是没登录，后者是云端问题', async () => {
    const unauthorized = await resolveProjectMemorySection({
      projectId: 'p1',
      fetch: async () => ({ ok: false, status: 401, message: '未登录', unauthorized: true }),
    });
    expect(unauthorized.reason).toBe('not-logged-in');

    const serverError = await resolveProjectMemorySection({
      projectId: 'p1',
      fetch: async () => ({ ok: false, status: 500, message: '炸了', unauthorized: false }),
    });
    expect(serverError.reason).toBe('error');
  });
});
