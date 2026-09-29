import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { buttonByText, click, mount, setInputValue, unmount } from '../helpers/reactMount';
import { ArtifactsPage } from '@/pages/artifacts/ArtifactsPage';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { artifactContentHash, buildIndexEntry } from '@/lib/artifactIndex';
import { contentHash } from '@/lib/contentHash';
import type { Artifact, ArtifactIndexEntry } from '@/types';

function art(over: Partial<Artifact> & { id: string }): Artifact {
  const { id, ...rest } = over;
  return { type: 'code', content: 'x', createdAt: '2026-09-29T00:00:00.000Z', ...rest, id };
}

/** 落一份「已入库」的状态：bySession（内容本体）+ index（索引） */
function seed(pairs: Array<{ sessionId: string; messageId: string; artifact: Artifact }>) {
  const bySession: Record<string, Artifact[]> = {};
  const index: Record<string, ArtifactIndexEntry> = {};
  for (const p of pairs) {
    (bySession[p.sessionId] ??= []).push(p.artifact);
    index[p.artifact.id] = buildIndexEntry(p.sessionId, p.messageId, p.artifact);
  }
  useArtifactsStore.setState({ bySession, index });
}

/** 记录当前路由路径，用于断言「跳回会话」真的导航了 */
let currentPath = '';
function RouteProbe(): null {
  currentPath = useLocation().pathname;
  return null;
}

function renderPage() {
  currentPath = '';
  return mount(
    <MemoryRouter initialEntries={['/artifacts']}>
      <RouteProbe />
      <ArtifactsPage />
    </MemoryRouter>,
  );
}

/** 按精确文案找 chip（MUI 的可点击 Chip 渲染成带 role="button" 的 div，不是 <button>） */
function chipByText(host: HTMLElement, text: string): HTMLElement | undefined {
  return Array.from(host.querySelectorAll('.MuiChip-root')).find(
    (el) => (el.textContent ?? '').trim() === text,
  ) as HTMLElement | undefined;
}

/** 页面上每一条产物都会渲染一个会话 chip；用会话名计数即可数出显示了几条 */
function countSessionChips(host: HTMLElement, title: string): number {
  return Array.from(host.querySelectorAll('.MuiChip-root')).filter(
    (el) => (el.textContent ?? '').trim() === title,
  ).length;
}

beforeEach(() => {
  useArtifactsStore.setState({ bySession: {}, index: {} });
  useSessionUiStore.setState({ focusMessageId: null, highlightMessageId: null });
  useSessionsStore.setState({
    sessions: [
      { id: 's1', title: '会话甲' } as never,
      { id: 's2', title: '会话乙' } as never,
    ],
    activeId: null,
  });
});

afterEach(() => {
  unmount();
});

describe('产物库：跨会话折叠（J-D4）', () => {
  it('同内容在两个会话出现 → 默认折叠为一条并标「2 处出现」', () => {
    seed([
      { sessionId: 's1', messageId: 'm1', artifact: art({ id: 'a1', content: 'shared code' }) },
      { sessionId: 's2', messageId: 'm2', artifact: art({ id: 'a2', content: 'shared code' }) },
    ]);
    const host = renderPage();

    expect(host.textContent).toContain('2 处出现');
    // 折叠后只渲染最近一次出现（s2），s1 那条不显示
    expect(countSessionChips(host, '会话乙')).toBe(1);
    expect(countSessionChips(host, '会话甲')).toBe(0);

    // 展开后两条都在
    click(chipByText(host, '2 处出现'));
    expect(countSessionChips(host, '会话甲')).toBe(1);
    expect(countSessionChips(host, '会话乙')).toBe(1);
  });

  it('内容不同则不折叠', () => {
    seed([
      { sessionId: 's1', messageId: 'm1', artifact: art({ id: 'a1', content: 'one' }) },
      { sessionId: 's2', messageId: 'm2', artifact: art({ id: 'a2', content: 'two' }) },
    ]);
    const host = renderPage();
    expect(host.textContent).not.toContain('处出现');
    expect(countSessionChips(host, '会话甲')).toBe(1);
    expect(countSessionChips(host, '会话乙')).toBe(1);
  });
});

describe('产物库：检索（J-D1 / J-D2）', () => {
  beforeEach(() => {
    seed([
      {
        sessionId: 's1',
        messageId: 'm1',
        artifact: art({ id: 'a1', type: 'code', title: '销售周报', content: 'console.log(1)', language: 'ts' }),
      },
      {
        sessionId: 's2',
        messageId: 'm2',
        artifact: art({ id: 'a2', type: 'html', title: '看板', content: '<i>hi</i>' }),
      },
    ]);
  });

  it('关键词命中内容 → 只留命中的那条', () => {
    const host = renderPage();
    const input = host.querySelector('input');
    setInputValue(input as HTMLInputElement, 'console');

    expect(countSessionChips(host, '会话甲')).toBe(1);
    expect(countSessionChips(host, '会话乙')).toBe(0);
  });

  it('关键词不命中 → 空态提示', () => {
    const host = renderPage();
    setInputValue(host.querySelector('input') as HTMLInputElement, '绝不存在的关键字');
    expect(host.textContent).toContain('没有匹配的产物');
  });

  it('类型筛选只留该类型', () => {
    const host = renderPage();
    click(buttonByText(host, 'HTML'));
    expect(countSessionChips(host, '会话乙')).toBe(1);
    expect(countSessionChips(host, '会话甲')).toBe(0);
  });
});

describe('产物库：排序与跳转（J-D3 / J-D5）', () => {
  it('切换排序真的颠倒顺序', () => {
    seed([
      {
        sessionId: 's1',
        messageId: 'm1',
        artifact: art({ id: 'a1', title: '旧产物', content: 'old', createdAt: '2026-09-01T00:00:00.000Z' }),
      },
      {
        sessionId: 's2',
        messageId: 'm2',
        artifact: art({ id: 'a2', title: '新产物', content: 'new', createdAt: '2026-09-25T00:00:00.000Z' }),
      },
    ]);
    const host = renderPage();

    const order = () => Array.from(host.querySelectorAll('.MuiChip-root'))
      .map((el) => (el.textContent ?? '').trim())
      .filter((t) => t === '会话甲' || t === '会话乙');

    expect(order()).toEqual(['会话乙', '会话甲']);
    click(buttonByText(host, '最早优先'));
    expect(order()).toEqual(['会话甲', '会话乙']);
  });

  it('点会话 chip → 选中该会话 + 导航到 /chat + 定位到消息', () => {
    seed([{ sessionId: 's1', messageId: 'm1', artifact: art({ id: 'a1', content: 'x' }) }]);
    const host = renderPage();

    const chip = chipByText(host, '会话甲');
    click(chip);
    act(() => undefined);

    expect(useSessionsStore.getState().activeId).toBe('s1');
    expect(useSessionUiStore.getState().focusMessageId).toBe('m1');
    expect(currentPath).toBe('/chat');
  });
});

describe('产物库：索引缺失的旧产物', () => {
  it('即时补算仍能显示（不写回索引）', () => {
    // 模拟本版之前入库的数据：bySession 有内容，index 里没有对应条目
    useArtifactsStore.setState({
      bySession: { s1: [art({ id: 'legacy', content: 'old stuff' })] },
      index: {},
    });
    const host = renderPage();
    expect(countSessionChips(host, '会话甲')).toBe(1);
    expect(useArtifactsStore.getState().index).toEqual({});
    expect(artifactContentHash(art({ id: 'legacy', content: 'old stuff' }))).toMatch(/^sha256:/);
  });
});

describe('产物库：正文从 bodies 回填（彻底去重 D1）', () => {
  it('bySession 只存引用、正文在 bodies 时渲染仍能拿到正文并能被检索命中', () => {
    // 真实落点形态：bySession 引用 content 清空、正文只在 bodies 一份
    const content = 'console.log("deduped-body")';
    const hash = contentHash(content);
    useArtifactsStore.setState({
      bySession: { s1: [art({ id: 'a1', content: '' })] },
      index: { a1: buildIndexEntry('s1', 'm1', art({ id: 'a1', content })) },
      bodies: { [hash]: content },
    });
    const host = renderPage();
    // 关键词命中正文（从 bodies 回填后）→ 条目可见
    setInputValue(host.querySelector('input') as HTMLInputElement, 'deduped-body');
    expect(countSessionChips(host, '会话甲')).toBe(1);
  });

  it('bodies 缺失（未迁移旧数据）回落内联 content，不丢正文', () => {
    // 没 bodies：渲染走 fallback = bySession 里的内联 content
    useArtifactsStore.setState({
      bySession: { s1: [art({ id: 'a1', content: 'fallback-body' })] },
      index: { a1: buildIndexEntry('s1', 'm1', art({ id: 'a1', content: 'fallback-body' })) },
      bodies: {},
    });
    const host = renderPage();
    setInputValue(host.querySelector('input') as HTMLInputElement, 'fallback-body');
    expect(countSessionChips(host, '会话甲')).toBe(1);
  });
});

describe('产物库：版本徽章 + 「仅编辑过」筛选（FR-7.4 接入全局检索）', () => {
  function seedVersions(entries: Array<{ id: string; version: number; versions: Array<{ version: number; contentHash: string; createdAt: string }> }>) {
    const bySession: Record<string, Artifact[]> = { s1: [] };
    const index: Record<string, ArtifactIndexEntry> = {};
    for (const e of entries) {
      const a = art({ id: e.id, content: `body-${e.id}` });
      bySession.s1.push(a);
      index[e.id] = { ...buildIndexEntry('s1', `m-${e.id}`, a), version: e.version, versions: e.versions };
    }
    useArtifactsStore.setState({ bySession, index });
  }

  it('有多版本历史的产物显示 vN 徽章', () => {
    seedVersions([
      { id: 'a1', version: 3, versions: [
        { version: 1, contentHash: 'sha256:1', createdAt: 't' },
        { version: 2, contentHash: 'sha256:2', createdAt: 't' },
        { version: 3, contentHash: 'sha256:3', createdAt: 't' },
      ] },
    ]);
    const host = renderPage();
    expect(chipByText(host, 'v3')).toBeTruthy();
  });

  it('单版本产物不显示版本徽章', () => {
    seed([
      { sessionId: 's1', messageId: 'm1', artifact: art({ id: 'a1', content: 'only-one' }) },
    ]);
    const host = renderPage();
    expect(chipByText(host, 'v1')).toBeFalsy();
  });

  it('「仅编辑过」开关只留多版本产物', () => {
    seedVersions([
      { id: 'a1', version: 1, versions: [{ version: 1, contentHash: 'sha256:1', createdAt: 't' }] },
      { id: 'a2', version: 2, versions: [
        { version: 1, contentHash: 'sha256:1', createdAt: 't' },
        { version: 2, contentHash: 'sha256:2', createdAt: 't' },
      ] },
    ]);
    const host = renderPage();
    expect(countSessionChips(host, '会话甲')).toBe(2);
    click(buttonByText(host, '仅编辑过'));
    expect(countSessionChips(host, '会话甲')).toBe(1);
    expect(host.textContent).toContain('v2');
  });
});
