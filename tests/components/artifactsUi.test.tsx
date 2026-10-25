import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { click, mount, setInputValue, unmount } from '../helpers/reactMount';
import { MessageArtifacts } from '@/components/artifacts/MessageArtifacts';
import { ArtifactPanel } from '@/components/artifacts/ArtifactPanel';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { buildIndexEntry } from '@/lib/artifact/artifactIndex';
import { fileArtifactId } from '@/lib/artifact/fileArtifact';
import type { Artifact, ArtifactIndexEntry, Message } from '@/types';

/** 造一条文件产物 + 对应索引条目（模拟「已入库」的会话状态） */
function seedFiles(
  sessionId: string,
  files: Array<{
    path: string;
    content?: string;
    size?: number;
    change?: 'created' | 'modified';
    /** 高亮语言；`.html` 产物靠它进「页面 / 源码」双视图（真实链路由扩展名推断） */
    language?: string;
  }>,
): { refs: Artifact[]; index: Record<string, ArtifactIndexEntry> } {
  const refs: Artifact[] = [];
  const index: Record<string, ArtifactIndexEntry> = {};
  // 正文按内容寻址进内容池（与真实入库一致）：引用上的 `content` 是空的，
  // 渲染 / 「在网页标签打开」都要靠 `index[id].contentHash` 回填
  const bodies: Record<string, string> = {};
  for (const f of files) {
    const artifact: Artifact = {
      id: fileArtifactId(sessionId, f.path),
      type: 'file',
      title: f.path.split('/').pop(),
      content: '', // 引用去 content 入库：正文在内容池
      path: f.path,
      size: f.size,
      change: f.change ?? 'created',
      ...(f.language !== undefined ? { language: f.language } : {}),
      createdAt: '2026-09-29T00:00:00.000Z',
    };
    refs.push(artifact);
    index[artifact.id] = buildIndexEntry(sessionId, 'm1', {
      ...artifact,
      content: f.content ?? '',
    });
    if (f.content) bodies[index[artifact.id].contentHash] = f.content;
  }
  useArtifactsStore.setState((s) => ({
    bySession: { ...s.bySession, [sessionId]: refs },
    index: { ...s.index, ...index },
    bodies: { ...s.bodies, ...bodies },
  }));
  return { refs, index };
}

function messageWith(artifacts: Artifact[], id = 'm1'): Message {
  return { id, role: 'assistant', content: '已写入', artifacts, createdAt: '2026-09-29T00:00:00.000Z' };
}

beforeEach(() => {
  useArtifactsStore.setState({ bySession: {}, index: {}, bodies: {}, indexTombstones: {} });
  useSessionUiStore.setState({
    artifactPanelOpen: false,
    artifactPanelSessionId: null,
    artifactPanelTabs: [],
    artifactPanelActiveTabId: null,
    artifactPanelFullscreen: false,
    artifactPanelView: 'all',
    focusMessageId: null,
    highlightMessageId: null,
  });
});

afterEach(() => {
  unmount();
});

describe('消息底部产物卡片区', () => {
  it('没有文件产物时不渲染任何内容（围栏产物仍走内联渲染）', () => {
    const host = mount(<MessageArtifacts sessionId="s1" message={messageWith([])} />);
    expect(host.textContent).toBe('');
  });

  it('列出本条消息的文件产物，并给出会话级「查看所有产物」入口', () => {
    const { refs } = seedFiles('s1', [
      { path: 'D:/aa/tetris.html', content: '<html/>', size: 30720 },
      { path: 'D:/aa/README.md', content: '# hi', size: 2355 },
    ]);
    const host = mount(<MessageArtifacts sessionId="s1" message={messageWith(refs)} />);

    expect(host.textContent).toContain('tetris.html');
    expect(host.textContent).toContain('README.md');
    expect(host.textContent).toContain('30 KB');
    expect(host.textContent).toContain('查看所有产物 (2)');
    // 没有变更时不显示「查看所有变更」
    expect(host.textContent).not.toContain('查看所有变更');
  });

  it('点卡片 → 打开右侧面板并直接预览该产物（产品指定的主路径）', () => {
    const { refs } = seedFiles('s1', [{ path: 'D:/aa/tetris.html', content: '<html/>' }]);
    const host = mount(<MessageArtifacts sessionId="s1" message={messageWith(refs)} />);

    act(() => {
      click(host.querySelector('[role="button"]'));
    });

    const ui = useSessionUiStore.getState();
    expect(ui.artifactPanelOpen).toBe(true);
    expect(ui.artifactPanelSessionId).toBe('s1');
    expect(ui.artifactPanelActiveTabId).toBe(refs[0].id);
    expect(ui.artifactPanelTabs.map((t) => t.id)).toEqual([refs[0].id]);
  });

  it('「查看所有变更」按变更口径打开面板；计数来自版本链', () => {
    const created = seedFiles('s1', [{ path: 'D:/aa/x.ts', content: 'v1' }]);
    // 再写一次 → 升版，形成 1 次变更
    useArtifactsStore.getState().recordArtifact('s1', 'm1', {
      ...created.refs[0],
      content: 'v2',
      change: 'modified',
    });
    const refs = useArtifactsStore.getState().bySession.s1;
    const host = mount(<MessageArtifacts sessionId="s1" message={messageWith(refs)} />);

    expect(host.textContent).toContain('查看所有变更 (1)');
    act(() => {
      click(
        Array.from(host.querySelectorAll('button')).find((b) =>
          (b.textContent ?? '').includes('查看所有变更'),
        ) ?? null,
      );
    });
    expect(useSessionUiStore.getState().artifactPanelView).toBe('changes');
    expect(useSessionUiStore.getState().artifactPanelActiveTabId).toBeNull();
  });

  it('「定位到消息」把请求交给会话 UI（消息 id 取自索引）', () => {
    const { refs } = seedFiles('s1', [{ path: 'D:/aa/x.ts', content: 'v1' }]);
    const host = mount(<MessageArtifacts sessionId="s1" message={messageWith(refs)} />);

    const locate = host.querySelector('[aria-label^="定位到消息"]');
    act(() => {
      click(locate);
    });
    expect(useSessionUiStore.getState().focusMessageId).toBe('m1');
    // 定位不应误触预览
    expect(useSessionUiStore.getState().artifactPanelOpen).toBe(false);
  });
});

describe('产物面板：列表与预览', () => {
  it('文件产物用扩展名角标列出行，超出阈值收进「展开更多 (N)」', () => {
    const paths = Array.from({ length: 8 }, (_, i) => `D:/aa/file-${i}.ts`);
    seedFiles('s1', paths.map((path) => ({ path, content: 'x', size: 1024 })));
    useSessionUiStore.setState({ artifactPanelOpen: true, artifactPanelSessionId: 's1' });

    const host = mount(<ArtifactPanel />);
    const rows = () => host.querySelectorAll('[role="button"][aria-label^="打开产物"]');
    expect(rows()).toHaveLength(6); // COLLAPSED_LIMIT
    expect(host.textContent).toContain('展开更多 (2)');

    act(() => {
      click(
        Array.from(host.querySelectorAll('button')).find((b) =>
          (b.textContent ?? '').includes('展开更多'),
        ) ?? null,
      );
    });
    expect(rows()).toHaveLength(8);
    expect(host.textContent).toContain('收起');
  });

  it('「变更」口径只列被再次编辑过的文件产物（与「查看所有变更」计数同口径）', () => {
    const { refs } = seedFiles('s1', [
      { path: 'D:/aa/once.ts', content: 'one' },
      { path: 'D:/aa/edited.ts', content: 'v1' },
    ]);
    const edited = refs.find((a) => a.path?.endsWith('edited.ts'));
    useArtifactsStore.getState().recordArtifact('s1', 'm1', {
      ...(edited as Artifact),
      content: 'v2',
      change: 'modified',
    });
    // 富产物即便被改过也不进这一视图（它的版本徽章在「全部」里已标出）
    const richArt: Artifact = {
      id: 'rich-1',
      type: 'mermaid',
      title: '流程图 1',
      content: 'graph TD;',
      createdAt: '2026-09-29T00:00:00.000Z',
    };
    const richEntry: ArtifactIndexEntry = {
      ...buildIndexEntry('s1', 'm1', richArt),
      version: 2,
      versions: [
        { version: 1, contentHash: 'sha256:r1', createdAt: 't1' },
        { version: 2, contentHash: 'sha256:r2', createdAt: 't2' },
      ],
    };
    useArtifactsStore.setState((s) => ({
      bySession: { ...s.bySession, s1: [...s.bySession.s1, richArt] },
      index: { ...s.index, [richArt.id]: richEntry },
    }));
    useSessionUiStore.setState({
      artifactPanelOpen: true,
      artifactPanelSessionId: 's1',
      artifactPanelView: 'changes',
    });

    const host = mount(<ArtifactPanel />);
    const rows = host.querySelectorAll('[role="button"][aria-label^="打开产物"]');
    expect(rows).toHaveLength(1);
    expect(host.textContent).toContain('edited.ts');
    expect(host.textContent).not.toContain('once.ts');
    expect(rows[0].getAttribute('aria-label')).toContain('edited.ts');
  });

  it('正文态：显示标签与产物名，「产物列表」入口回到列表', () => {
    const { refs } = seedFiles('s1', [{ path: 'D:/aa/report.md', content: '# hi' }]);
    useSessionUiStore.setState({
      artifactPanelOpen: true,
      artifactPanelSessionId: 's1',
      artifactPanelTabs: [{ id: refs[0].id, kind: 'artifact' as const }],
      artifactPanelActiveTabId: refs[0].id,
    });

    const host = mount(<ArtifactPanel />);
    expect(host.textContent).toContain('report.md');
    // 标签栏常驻：正文态下「产物列表」入口仍在
    expect(host.querySelector('[aria-label="产物列表"]')).toBeTruthy();
    // 列表态才有的「概览」在正文态让位
    expect(host.textContent).not.toContain('智能体');

    act(() => {
      click(host.querySelector('[aria-label="产物列表"]'));
    });
    expect(useSessionUiStore.getState().artifactPanelActiveTabId).toBeNull();
    // 回列表不清标签，还能切回去
    expect(useSessionUiStore.getState().artifactPanelTabs.map((t) => t.id)).toEqual([refs[0].id]);
    expect(host.textContent).toContain('智能体');
  });
});

describe('产物面板：多标签', () => {
  /** 从列表里第 `index` 行打开产物（打开后列表让位，需要先经「产物列表」回来） */
  function openRow(host: HTMLDivElement, index: number) {
    const rows = host.querySelectorAll('[role="button"][aria-label^="打开产物"]');
    expect(rows[index]).toBeTruthy();
    act(() => {
      click(rows[index]);
    });
  }

  it('依次打开两个产物 → 标签栏两个标签，可来回切换', () => {
    const { refs } = seedFiles('s1', [
      { path: 'D:/aa/a.ts', content: 'const a = 1;' },
      { path: 'D:/aa/b.ts', content: 'const b = 2;' },
    ]);
    useSessionUiStore.setState({ artifactPanelOpen: true, artifactPanelSessionId: 's1' });

    const host = mount(<ArtifactPanel />);
    openRow(host, 0);
    // 打开第一个后列表让位给正文 —— 靠标签栏左侧「产物列表」回到列表再开第二个
    act(() => {
      click(host.querySelector('[aria-label="产物列表"]'));
    });
    // 已打开的产物在列表里被标记（aria-current），避免重复点开
    expect(
      host.querySelector(`[aria-label="打开产物 a.ts"]`)?.getAttribute('aria-current'),
    ).toBe('true');
    openRow(host, 1);

    expect(useSessionUiStore.getState().artifactPanelTabs.map((t) => t.id)).toEqual([refs[0].id, refs[1].id]);
    expect(useSessionUiStore.getState().artifactPanelActiveTabId).toBe(refs[1].id);

    const tabEls = () => Array.from(host.querySelectorAll('[role="tab"]'));
    expect(tabEls()).toHaveLength(2);
    expect(host.textContent).toContain('b.ts');

    // 切回第一个标签 → 激活项与正文都跟着换
    act(() => {
      click(host.querySelector('[aria-label="切换到产物 a.ts"]'));
    });
    expect(useSessionUiStore.getState().artifactPanelActiveTabId).toBe(refs[0].id);
    expect(tabEls()[0].getAttribute('aria-selected')).toBe('true');
  });

  it('关闭标签：非当前标签不影响激活项，关掉最后一个回到列表', () => {
    const { refs } = seedFiles('s1', [
      { path: 'D:/aa/a.ts', content: 'const a = 1;' },
      { path: 'D:/aa/b.ts', content: 'const b = 2;' },
    ]);
    useSessionUiStore.setState({
      artifactPanelOpen: true,
      artifactPanelSessionId: 's1',
      artifactPanelTabs: [
        { id: refs[0].id, kind: 'artifact' as const },
        { id: refs[1].id, kind: 'artifact' as const },
      ],
      artifactPanelActiveTabId: refs[1].id,
    });

    const host = mount(<ArtifactPanel />);
    act(() => {
      click(host.querySelector('[aria-label="关闭标签 a.ts"]'));
    });
    expect(useSessionUiStore.getState().artifactPanelTabs.map((t) => t.id)).toEqual([refs[1].id]);
    expect(useSessionUiStore.getState().artifactPanelActiveTabId).toBe(refs[1].id);
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(1);
    // 只剩一个标签时不再提供「关闭全部」——那时它等同于「关闭它」
    expect(host.querySelector('[aria-label="关闭全部标签"]')).toBeNull();

    act(() => {
      click(host.querySelector('[aria-label="关闭标签 b.ts"]'));
    });
    expect(useSessionUiStore.getState().artifactPanelTabs.map((t) => t.id)).toEqual([]);
    expect(useSessionUiStore.getState().artifactPanelActiveTabId).toBeNull();
    // 标签清空后回到列表态
    expect(host.textContent).toContain('智能体');
  });

  it('两个以上标签时提供「关闭全部」', () => {
    const { refs } = seedFiles('s1', [
      { path: 'D:/aa/a.ts', content: 'const a = 1;' },
      { path: 'D:/aa/b.ts', content: 'const b = 2;' },
    ]);
    useSessionUiStore.setState({
      artifactPanelOpen: true,
      artifactPanelSessionId: 's1',
      artifactPanelTabs: [
        { id: refs[0].id, kind: 'artifact' as const },
        { id: refs[1].id, kind: 'artifact' as const },
      ],
      artifactPanelActiveTabId: refs[1].id,
    });

    const host = mount(<ArtifactPanel />);
    act(() => {
      click(host.querySelector('[aria-label="关闭全部标签"]'));
    });
    expect(useSessionUiStore.getState().artifactPanelTabs).toEqual([]);
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  it('消息卡片连点两个产物 → 两个标签（点卡片是追加语义，不是顶掉）', () => {
    const { refs } = seedFiles('s1', [
      { path: 'D:/aa/a.ts', content: 'const a = 1;' },
      { path: 'D:/aa/b.ts', content: 'const b = 2;' },
    ]);
    const host = mount(<MessageArtifacts sessionId="s1" message={messageWith(refs)} />);
    const cards = host.querySelectorAll('[role="button"]');

    act(() => {
      click(cards[0]);
    });
    act(() => {
      click(cards[1]);
    });

    const ui = useSessionUiStore.getState();
    expect(ui.artifactPanelTabs.map((t) => t.id)).toEqual([refs[0].id, refs[1].id]);
    expect(ui.artifactPanelActiveTabId).toBe(refs[1].id);
  });
});

describe('产物面板：新建标签页与全屏', () => {
  it('点「+」新建空白网页标签：标签栏多一格，内容区换成地址栏 + 引导语', () => {
    useSessionUiStore.setState({ artifactPanelOpen: true, artifactPanelSessionId: 's1' });
    const host = mount(<ArtifactPanel />);

    act(() => {
      click(host.querySelector('[aria-label="新建标签页"]'));
    });

    const tabs = useSessionUiStore.getState().artifactPanelTabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe('web');
    // 空白标签不显示文字（只有地球图标），与参考稿一致
    expect(host.querySelector('[aria-label="切换到标签页 新标签页"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="地址栏"]')).toBeTruthy();
    expect(host.textContent).toContain('在上方输入网址开始浏览');
    // 还没地址 → 不渲染 iframe
    expect(host.querySelector('iframe')).toBeNull();
  });

  it('地址栏回车 → 地址进标签（本地地址补 http）并渲染 iframe', () => {
    useSessionUiStore.setState({ artifactPanelOpen: true, artifactPanelSessionId: 's1' });
    const host = mount(<ArtifactPanel />);
    act(() => {
      click(host.querySelector('[aria-label="新建标签页"]'));
    });

    const input = host.querySelector<HTMLInputElement>('[aria-label="地址栏"]');
    act(() => {
      setInputValue(input, 'localhost:5176');
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    const tab = useSessionUiStore.getState().artifactPanelTabs[0];
    expect(tab.kind === 'web' && tab.url).toBe('http://localhost:5176');
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5176');
  });

  it('全屏：按钮文案切换、拖宽抓手撤掉；ESC 退出', () => {
    useSessionUiStore.setState({ artifactPanelOpen: true, artifactPanelSessionId: 's1' });
    const host = mount(<ArtifactPanel />);
    expect(host.querySelector('[role="separator"]')).toBeTruthy();

    act(() => {
      click(host.querySelector('[aria-label="进入全屏"]'));
    });
    expect(useSessionUiStore.getState().artifactPanelFullscreen).toBe(true);
    expect(host.querySelector('[aria-label="退出全屏"]')).toBeTruthy();
    // 面板已铺满窗口，没有边缘可拖
    expect(host.querySelector('[role="separator"]')).toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useSessionUiStore.getState().artifactPanelFullscreen).toBe(false);
    expect(host.querySelector('[role="separator"]')).toBeTruthy();
  });
});

describe('产物面板：html 产物 → 网页标签', () => {
  /** 造一个已入库的 .html 文件产物（正文进内容池，与真实链路一致） */
  function seedHtml() {
    return seedFiles('s1', [
      { path: 'D:/aa/snake.html', content: '<!DOCTYPE html><h1>贪吃蛇</h1>', language: 'html' },
    ]);
  }

  it('html 产物多出「在网页标签打开」入口；Web 端用正文快照开标签', () => {
    const { refs } = seedHtml();
    useSessionUiStore.setState({
      artifactPanelOpen: true,
      artifactPanelSessionId: 's1',
      artifactPanelTabs: [{ id: refs[0].id, kind: 'artifact' as const }],
      artifactPanelActiveTabId: refs[0].id,
    });

    const host = mount(<ArtifactPanel />);
    const entry = host.querySelector('[aria-label="在网页标签打开"]');
    expect(entry).toBeTruthy();

    act(() => {
      click(entry);
    });

    const tabs = useSessionUiStore.getState().artifactPanelTabs;
    expect(tabs).toHaveLength(2);
    const web = tabs[1];
    expect(web.kind).toBe('web');
    if (web.kind !== 'web') throw new Error('unreachable');
    // 标签按产物名命名（比 file:///D:/aa/... 好读）
    expect(web.label).toBe('snake.html');
    // jsdom 里 platform.env === 'web'：加载不了 file://，退回写入时的正文快照
    expect(web.doc).toContain('贪吃蛇');
    expect(host.querySelector('[aria-label="切换到标签页 snake.html"]')).toBeTruthy();
  });

  it('非 html 产物不显示该入口（.ts 文件只看源码）', () => {
    const { refs } = seedFiles('s1', [{ path: 'D:/aa/a.ts', content: 'const a = 1;' }]);
    useSessionUiStore.setState({
      artifactPanelOpen: true,
      artifactPanelSessionId: 's1',
      artifactPanelTabs: [{ id: refs[0].id, kind: 'artifact' as const }],
      artifactPanelActiveTabId: refs[0].id,
    });

    const host = mount(<ArtifactPanel />);
    expect(host.querySelector('[aria-label="在网页标签打开"]')).toBeNull();
  });
});

describe('产物面板：拖宽', () => {
  it('拖动左边缘抓手改宽度（指针左移变宽），并夹在上下限内', () => {
    const { refs } = seedFiles('s1', [{ path: 'D:/aa/report.md', content: '# hi' }]);
    useSessionUiStore.setState({
      artifactPanelOpen: true,
      artifactPanelSessionId: 's1',
      artifactPanelTabs: [{ id: refs[0].id, kind: 'artifact' as const }],
      artifactPanelActiveTabId: refs[0].id,
    });

    const host = mount(<ArtifactPanel />);
    const separator = () => host.querySelector('[role="separator"]') as HTMLElement;
    const widthNow = () => Number(separator().getAttribute('aria-valuenow'));
    const drag = (type: string, clientX: number) => {
      act(() => {
        separator().dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
      });
    };

    expect(widthNow()).toBe(460); // 有标签时的默认宽度

    drag('pointerdown', 1000);
    drag('pointermove', 800); // 指针左移 200 → 宽度 +200
    expect(widthNow()).toBe(660);

    drag('pointermove', 5000); // 拖过头 → 夹到下限
    expect(widthNow()).toBe(260);

    drag('pointerup', 5000);
    // 松手后不再跟随（dragRef 已清空）
    drag('pointermove', 900);
    expect(widthNow()).toBe(260);
  });
});