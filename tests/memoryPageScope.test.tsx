/**
 * 记忆页的作用域与文件切换（FR-4.2 / FR-4.5）。
 *
 * 这组用例锁的是**最危险的一条**：每个可编辑的目标都是一份独立内容，任何
 * 「把 A 的内容存进 B」的串台都是静默数据损坏——不报错、不崩溃，只是某天用户
 * 发现跨项目的记忆里混进了某个项目的细节。所以断言都围绕「切换后真的重新读盘」
 * 与「保存只落当前目标」：
 *
 * 1. 默认进工作区级（且默认编辑 `MEMORY.md`），切到用户级要**真的重新读盘**；
 * 2. 保存 / 清空只作用于当前目标，其它目标一个字节都不动；
 * 3. 切层 / 切文件瞬间先清空编辑框，避免「加载中」时被手快点保存写过去；
 * 4. 工作区级是**目录**（`MEMORY.md` + 日期文件），写今天的日志不得波及精炼记忆
 *    ——旧实现把合并视图整体写回 `MEMORY.md`，会让同一句话在磁盘上存两份。
 *
 * 种子数据一律走 `MemoryService.save` 而不是直接写 localStorage：Web 存储适配器
 * 会把值做 JSON 序列化，裸写字符串在下一次 `get` 时 `JSON.parse` 失败会被吞成
 * null——测试会「因为读不到内容」而失败，而不是因为被测行为错了。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryPage } from '@/pages/memory/MemoryPage';
import { MemoryService } from '@/lib/memory';
import { CURATED_MEMORY_FILE, dailyMemoryFileName } from '@/lib/workspaceMemory';
import {
  buttonByText,
  click,
  dialogRoot,
  flush,
  mount,
  setInputValue,
  unmount,
} from './helpers/reactMount';

const WS_TEXT = '工作区记忆内容';
/** 刻意与上面不等长：规模概览断言要靠长度区分两层，等长就等于什么都没验证 */
const USER_TEXT = '用户级记忆';

function editor(host: HTMLElement): HTMLTextAreaElement {
  const el = host.querySelector('textarea');
  expect(el).toBeTruthy();
  return el as HTMLTextAreaElement;
}

beforeEach(async () => {
  unmount();
  MemoryService.useWorkspace('default');
  await MemoryService.save(WS_TEXT, 'workspace');
  await MemoryService.save(USER_TEXT, 'user');
});

describe('MemoryPage 作用域切换', () => {
  it('默认展示工作区级，切到用户级会重新读盘', async () => {
    const host = mount(<MemoryPage />);
    await flush();

    expect(editor(host).value).toBe(WS_TEXT);

    click(buttonByText(host, '用户级'));
    await flush();
    expect(editor(host).value).toBe(USER_TEXT);

    click(buttonByText(host, '工作区级'));
    await flush();
    expect(editor(host).value).toBe(WS_TEXT);
  });

  it('保存只写当前作用域，另一层不变', async () => {
    const host = mount(<MemoryPage />);
    await flush();

    click(buttonByText(host, '用户级'));
    await flush();
    setInputValue(editor(host), '改过的用户级记忆内容');
    click(buttonByText(host, '保存'));
    await flush();

    expect(await MemoryService.load('user')).toBe('改过的用户级记忆内容');
    // 关键断言：工作区级没有被这次保存波及
    expect(await MemoryService.load('workspace')).toBe(WS_TEXT);
  });

  it('清空只清当前作用域（需二次确认）', async () => {
    const host = mount(<MemoryPage />);
    await flush();

    // 工作区级清空会删掉该工作目录下的整批记忆文件，因此必须先过一次确认对话框
    click(buttonByText(host, '清空'));
    await flush();
    expect(await MemoryService.load('workspace')).toBe(WS_TEXT);

    click(buttonByText(dialogRoot(), '清空'));
    await flush();

    expect(await MemoryService.load('workspace')).toBe('');
    expect(await MemoryService.load('user')).toBe(USER_TEXT);
  });

  it('切层瞬间先清空编辑框，不把上一层内容带过去', async () => {
    const host = mount(<MemoryPage />);
    await flush();
    expect(editor(host).value).toBe(WS_TEXT);

    // 不 flush：切换动作同步清空 + 置 loading，此时编辑框必须是空的。
    // 「先清空再读盘」正是防手快保存串台的那一步。
    click(buttonByText(host, '用户级'));
    expect(editor(host).value).toBe('');
    expect(editor(host).disabled).toBe(true);

    await flush();
    expect(editor(host).value).toBe(USER_TEXT);
  });

  it('两层规模概览各自独立展示', async () => {
    const host = mount(<MemoryPage />);
    await flush();

    const summaries = await MemoryService.scopeSummaries();
    const user = summaries.find((s) => s.scope === 'user');
    const workspace = summaries.find((s) => s.scope === 'workspace');
    expect(user?.chars).toBe(USER_TEXT.length);
    expect(workspace?.chars).toBe(WS_TEXT.length);
    // 切换器上的字符数来自真实读盘结果（两层长度不同，因此这条断言有区分力）
    expect(host.textContent).toContain(`${USER_TEXT.length} 字符`);
    expect(host.textContent).toContain(`${WS_TEXT.length} 字符`);
  });
});

describe('MemoryPage 工作区文件切换', () => {
  it('写今天的日志不会覆盖精炼记忆', async () => {
    const host = mount(<MemoryPage />);
    await flush();
    expect(editor(host).value).toBe(WS_TEXT);

    const today = dailyMemoryFileName();
    click(buttonByText(host, '今天'));
    await flush();
    // 今天的日志还没写过 → 编辑器是空的（「不存在」，而不是「有一份空的」）
    expect(editor(host).value).toBe('');

    setInputValue(editor(host), '今天沉淀的一句话');
    click(buttonByText(host, '保存'));
    await flush();

    // 落进当天的日期文件……
    expect(await MemoryService.readFile(undefined, today)).toBe('今天沉淀的一句话');
    // ……而精炼记忆一个字节都没动（旧实现会把合并视图整体写回，两份就串了）
    expect(await MemoryService.readFile(undefined, CURATED_MEMORY_FILE)).toBe(WS_TEXT);
    // 合并视图里两份都在：注入时读到的正是这一份
    const merged = await MemoryService.load('workspace');
    expect(merged).toContain(WS_TEXT);
    expect(merged).toContain('今天沉淀的一句话');
  });

  it('切到另一份文件会重新读盘，而不是沿用上一份的正文', async () => {
    const today = dailyMemoryFileName();
    await MemoryService.writeFile(undefined, today, '今天已经记过的内容');

    const host = mount(<MemoryPage />);
    await flush();
    expect(editor(host).value).toBe(WS_TEXT);

    click(buttonByText(host, '今天'));
    await flush();
    expect(editor(host).value).toBe('今天已经记过的内容');
  });
});
