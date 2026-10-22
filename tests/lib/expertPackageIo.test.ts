/**
 * 专家包的文件读写（FR-3.3）。
 *
 * 这层只验证「平台能力被正确调用 + 失败不抛错」——解析与对账逻辑在
 * `expertPackage.test.ts` 里逐条钉，这里不重复。两个容易写错的点：
 *
 * 1. **用户取消不是错误**：`pickFile` 返 null 时必须走 `canceled`，
 *    否则界面会对着「我什么都没选」弹一个红色失败提示；
 * 2. **写盘失败不抛**：异常冒到 React 里就是白屏，而这里能变成 toast 一句话。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformMocks = vi.hoisted(() => ({
  writeTextFile: vi.fn(),
  pickFile: vi.fn(),
}));

vi.mock('@/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform')>();
  return {
    ...actual,
    platform: {
      ...actual.platform,
      writeTextFile: platformMocks.writeTextFile,
      pickFile: platformMocks.pickFile,
    },
  };
});

import { exportExpertPackageFile, readExpertPackageFile } from '@/lib/expertPackageIo';
import { EXPERT_PACKAGE_SCHEMA } from '@/types/expertPackage';
import type { Agent } from '@/types';

function makeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: '前端专家',
    systemPrompt: '你是前端。',
    skillIds: ['sk-1'],
    imBinding: null,
    enabled: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    source: 'user',
    ...over,
  };
}

beforeEach(() => {
  platformMocks.writeTextFile.mockReset();
  platformMocks.pickFile.mockReset();
});

describe('exportExpertPackageFile', () => {
  it('用相对文件名落盘（Electron 解析到 ~/.nanowork/，Web 触发下载）', async () => {
    platformMocks.writeTextFile.mockResolvedValue(undefined);
    const r = await exportExpertPackageFile(makeAgent({ avatar: '🌱' }), () => '代码审查');
    expect(r.ok).toBe(true);
    expect(r.fileName).toBe('前端专家.nanowork-expert.json');
    const [path, content] = platformMocks.writeTextFile.mock.calls[0] as [string, string];
    // 必须是**相对**路径：绝对路径会被主进程的 resolveWriteTarget 判越界
    expect(path).toBe('前端专家.nanowork-expert.json');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed.schema).toBe(EXPERT_PACKAGE_SCHEMA);
    expect((parsed.agent as Record<string, unknown>).avatar).toBe('🌱');
  });

  it('写盘失败返回 error 而不是抛异常', async () => {
    platformMocks.writeTextFile.mockRejectedValue(new Error('EACCES'));
    const r = await exportExpertPackageFile(makeAgent(), () => 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('EACCES');
    expect(r.fileName).toBe('');
  });
});

describe('readExpertPackageFile', () => {
  it('用户取消 → canceled，不是错误', async () => {
    platformMocks.pickFile.mockResolvedValue(null);
    const r = await readExpertPackageFile();
    expect(r.ok).toBe(false);
    expect(r.canceled).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('合法文件 → 包 + 文件名', async () => {
    platformMocks.pickFile.mockResolvedValue({
      name: 'pkg.json',
      content: JSON.stringify({
        schema: EXPERT_PACKAGE_SCHEMA,
        slug: 'x',
        version: '1.0.0',
        description: '',
        expertType: 'agent',
        skills: [],
        agent: { name: 'x', systemPrompt: 'y' },
      }),
    });
    const r = await readExpertPackageFile();
    expect(r.ok).toBe(true);
    expect(r.pkg?.agent.name).toBe('x');
    expect(r.fileName).toBe('pkg.json');
  });

  it('坏文件 → error 带解析器给的分类文案', async () => {
    platformMocks.pickFile.mockResolvedValue({ name: 'bad.json', content: '{oops' });
    const r = await readExpertPackageFile();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('JSON');
    // 文件名要带出来：用户可能在同一个目录里选错了好几个文件
    expect(r.fileName).toBe('bad.json');
  });

  it('pickFile 抛异常也不外泄（返回 error）', async () => {
    platformMocks.pickFile.mockRejectedValue(new Error('dialog failed'));
    const r = await readExpertPackageFile();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('dialog failed');
  });
});
