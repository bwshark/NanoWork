import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { click, mount, unmount } from '../helpers/reactMount';
import { WorkspaceTreeView } from '@/components/artifacts/WorkspaceTreeView';
import { ChangesView } from '@/components/artifacts/ChangesView';
import type {
  GitDiffResult,
  GitStatusResult,
  WorkspaceListResult,
  WorkspaceReadResult,
} from '@/platform/types';

/**
 * 右栏「文件」「变更」两个页面。
 *
 * 这两个页面的共同点是**数据全从主进程来**，所以坏掉的形态都是「界面在、内容空」：
 * 目录树不展开、diff 不出现、行数永远是 0。这类问题不报错、不崩溃，只能靠用例钉住。
 *
 * `@/platform` 整体替换成可编程桩：真实现要读磁盘 / 起 git 子进程，
 * 那些已经在 `tests/electron/workspaceRoutes.test.ts` 里针对真实文件系统验过了。
 */

const mocks = vi.hoisted(() => ({
  workspaceListDir: vi.fn<(dir: string) => Promise<WorkspaceListResult>>(),
  workspaceReadText: vi.fn<(path: string) => Promise<WorkspaceReadResult>>(),
  gitStatus: vi.fn<(dir: string) => Promise<GitStatusResult>>(),
  gitDiff: vi.fn<(dir: string, path: string) => Promise<GitDiffResult>>(),
}));

vi.mock('@/platform', () => ({
  platform: {
    env: 'electron',
    workspaceListDir: mocks.workspaceListDir,
    workspaceReadText: mocks.workspaceReadText,
    gitStatus: mocks.gitStatus,
    gitDiff: mocks.gitDiff,
    openPath: async () => ({ ok: true }),
    openUrl: async () => ({ ok: true }),
    showItemInFolder: async () => ({ ok: true }),
  },
}));

/** 等 promise 链落定（组件里是 `void fn().then(...)`，没有可 await 的句柄） */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function okStatus(files: GitStatusResult['files'], added = 0, removed = 0): GitStatusResult {
  return { ok: true, isRepo: true, files, added, removed };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gitStatus.mockResolvedValue(okStatus([]));
  mocks.gitDiff.mockResolvedValue({ ok: true, patch: '' });
  mocks.workspaceListDir.mockResolvedValue({ ok: true, entries: [] });
});

afterEach(() => {
  unmount();
});

describe('WorkspaceTreeView（文件标签页）', () => {
  it('没绑定工作空间时给出说明，而不是一片空白', async () => {
    const host = mount(<WorkspaceTreeView root="" onOpenFile={() => undefined} />);
    await flush();
    expect(host.textContent).toContain('这个会话还没有工作空间');
    expect(mocks.workspaceListDir).not.toHaveBeenCalled();
  });

  it('列出根目录：目录在前，文件行点一下把路径交给上层预览', async () => {
    mocks.workspaceListDir.mockResolvedValue({
      ok: true,
      entries: [
        { name: 'src', dir: true },
        { name: 'README.md', dir: false, size: 12 },
      ],
    });
    const opened: Array<[string, string]> = [];
    const host = mount(
      <WorkspaceTreeView root="D:/proj" onOpenFile={(p, n) => opened.push([p, n])} />,
    );
    await flush();

    expect(mocks.workspaceListDir).toHaveBeenCalledWith('D:/proj');
    expect(host.textContent).toContain('D:/proj');
    expect(host.textContent).toContain('src');
    expect(host.textContent).toContain('README.md');

    act(() => {
      click(host.querySelector('[role="button"][aria-label^="预览文件"]'));
    });
    // 路径按 `/` 拼接（Windows 上 Node 两种分隔符都吃）
    expect(opened).toEqual([['D:/proj/README.md', 'README.md']]);
  });

  it('目录按层懒加载：展开才请求子目录，折叠后再展开不重复请求', async () => {
    mocks.workspaceListDir.mockImplementation(async (dir: string) =>
      dir === 'D:/proj'
        ? { ok: true, entries: [{ name: 'src', dir: true }] }
        : { ok: true, entries: [{ name: 'main.ts', dir: false, size: 1 }] },
    );
    const host = mount(<WorkspaceTreeView root="D:/proj" onOpenFile={() => undefined} />);
    await flush();
    expect(mocks.workspaceListDir).toHaveBeenCalledTimes(1);

    const expand = () => host.querySelector('[role="button"][aria-label^="展开目录"]');
    act(() => {
      click(expand());
    });
    await flush();
    expect(mocks.workspaceListDir).toHaveBeenCalledWith('D:/proj/src');
    expect(host.textContent).toContain('main.ts');

    // 折叠 → 再展开：命中缓存，不再打一次 IPC
    act(() => {
      click(host.querySelector('[role="button"][aria-label^="折叠目录"]'));
    });
    expect(host.textContent).not.toContain('main.ts');
    act(() => {
      click(expand());
    });
    await flush();
    expect(mocks.workspaceListDir).toHaveBeenCalledTimes(2);
  });

  it('读目录失败时把原因显示出来（空目录和读不到是两件事）', async () => {
    mocks.workspaceListDir.mockResolvedValue({
      ok: false,
      entries: [],
      error: 'EACCES: permission denied',
    });
    const host = mount(<WorkspaceTreeView root="D:/proj" onOpenFile={() => undefined} />);
    await flush();
    expect(host.textContent).toContain('EACCES');
  });
});

describe('ChangesView（变更标签页）', () => {
  it('不是 git 仓库时说明原因，而不是显示「没有改动」', async () => {
    mocks.gitStatus.mockResolvedValue({
      ok: false,
      isRepo: false,
      files: [],
      added: 0,
      removed: 0,
      error: '这个目录不是 git 仓库',
    });
    const host = mount(<ChangesView root="D:/proj" />);
    await flush();
    expect(host.textContent).toContain('这个目录不是 git 仓库');
    expect(host.textContent).toContain('依赖 git');
  });

  it('表头带汇总增删，默认选中第一个文件并加载它的 diff', async () => {
    mocks.gitStatus.mockResolvedValue(
      okStatus(
        [
          { path: 'src/a.ts', status: 'modified', added: 12, removed: 3 },
          { path: 'src/b.ts', status: 'untracked', added: 5, removed: 0 },
        ],
        17,
        3,
      ),
    );
    mocks.gitDiff.mockResolvedValue({
      ok: true,
      patch: '@@ -1,1 +1,2 @@\n-old\n+new\n+extra',
    });

    const host = mount(<ChangesView root="D:/proj" />);
    await flush();

    expect(host.textContent).toContain('+17');
    expect(host.textContent).toContain('-3');
    expect(mocks.gitDiff).toHaveBeenCalledWith('D:/proj', 'src/a.ts');
    expect(host.textContent).toContain('+new');
    expect(host.textContent).toContain('-old');
  });

  it('点另一个文件 → 换成它的 diff', async () => {
    mocks.gitStatus.mockResolvedValue(
      okStatus([
        { path: 'a.ts', status: 'modified', added: 1, removed: 0 },
        { path: 'b.ts', status: 'modified', added: 1, removed: 0 },
      ]),
    );
    mocks.gitDiff.mockImplementation(async (_dir, path) => ({
      ok: true,
      patch: path === 'b.ts' ? '+from-b' : '+from-a',
    }));

    const host = mount(<ChangesView root="D:/proj" />);
    await flush();
    expect(host.textContent).toContain('from-a');

    act(() => {
      click(host.querySelector('[role="button"][aria-label="查看改动 b.ts"]'));
    });
    await flush();
    expect(mocks.gitDiff).toHaveBeenLastCalledWith('D:/proj', 'b.ts');
    expect(host.textContent).toContain('from-b');
  });

  it('没有未提交改动时给一句明确的话', async () => {
    mocks.gitStatus.mockResolvedValue(okStatus([]));
    const host = mount(<ChangesView root="D:/proj" />);
    await flush();
    expect(host.textContent).toContain('没有未提交的改动');
  });
});
