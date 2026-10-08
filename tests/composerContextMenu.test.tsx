/**
 * 输入区右键上下文菜单（剪切 / 复制 / 粘贴 / 全选）。
 *
 * ## 为什么这组用例值得单独存在
 *
 * 系统原生右键菜单在 contentEditable 里**看不见内联附件徽章**（它只是些带
 * `data-att-id` 的 span），剪贴只会带走文字、附件静默丢失。这里钉的不是
 * 「菜单长什么样」，而是三条容易静默坏掉的语义：
 *
 * 1. **每一项接回的是 Composer 已有的富编辑能力**：复制/剪切走
 *    `writeRichClipboard`（含应用层缓存），不是浏览器的默认剪贴；
 * 2. **菜单抢焦点后选区还在**：`autoFocus` 会把焦点移出输入区，若不还原
 *    右键那一刻的选区，`copySelection` 会读到空选区 —— 表现成「点了复制却
 *    什么都没复制」。这条真的会静默失败，所以必须守。
 * 3. **粘贴与键盘 Ctrl+V 同一套优先级**：菜单触发没有 `ClipboardEvent`，
 *    只能主动读剪贴板；RICH_CLIP_MIME → 图片 → 文本键命中富缓存 → 纯文本。
 *
 * 判定「能不能剪」只看**是否有非折叠选区**，不逐像素比样式。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { Composer } from '@/pages/chat/Composer';
import { ComposerContextMenu } from '@/pages/chat/ComposerContextMenu';
import { muiTheme } from '@/theme/muiTheme';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import {
  useSettingsStore,
  DEFAULT_TRANSCRIPTION,
  DEFAULT_DESKTOP,
} from '@/stores/settingsStore';
import { _clearForTest, stashRichPayload } from '@/lib/richClipboard';
import { resetEventStream } from './helpers/eventStream';
import { click, mount, unmount } from './helpers/reactMount';
import { DEFAULT_MEMORY_POLICY } from '@/types';

// —— 剪贴板桩 ——
// jsdom 不实现 navigator.clipboard（也没有 ClipboardItem），默认没有可复制的
// 富载荷通道；这里只补 writeText / readText 两条最基础的路，用来断言
// 「菜单项确实把内容写/读到了剪贴板」，而不是断言富 MIME 本身。
type ClipStub = {
  writeText: ReturnType<typeof vi.fn>;
  readText: ReturnType<typeof vi.fn>;
};
let clip: ClipStub;

function installClipboard(overrides?: Partial<ClipStub>): void {
  clip = {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
    ...overrides,
  };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: clip,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  installClipboard();
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
      transcription: DEFAULT_TRANSCRIPTION,
      desktop: DEFAULT_DESKTOP,
    },
    status: 'offline',
  });
  useSessionsStore.setState({
    sessions: [],
    activeId: null,
    streams: {},
    pendingApprovals: [],
    error: null,
  });
  useAgentsStore.setState({ agents: [], activeAgentId: null });
  resetEventStream();
});

afterEach(async () => {
  vi.restoreAllMocks();
  _clearForTest();
  unmount();
  /**
   * MUI Menu / Grow 的过渡走 react-transition-group 的 `setTimeout`，**不归
   * React 管**：组件卸载后它还在飞，测试环境已销毁时才触发 → vitest 记一条
   * `Unhandled Error`，所有用例全绿但整个 run 退出码是 1。判门禁看退出码，
   * 所以这 400ms 必须等。
   */
  await new Promise((r) => setTimeout(r, 400));
});

/** 挂载真实的输入区（ComposerMenu 用 useNavigate，必须在 Router 内） */
function mountComposer(): HTMLElement {
  return mount(
    <ThemeProvider theme={muiTheme}>
      <MemoryRouter>
        <Composer />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** 输入区本体：唯一带 contentEditable 的元素 */
function editableOf(host: HTMLElement): HTMLElement {
  const el = host.querySelector<HTMLElement>('[contenteditable="true"]');
  expect(el, '输入区应该存在').toBeTruthy();
  return el!;
}

/** 派发一次右键（React 的 onContextMenu 监听 contextmenu） */
function rightClick(el: Element, x = 100, y = 100): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }),
    );
  });
}

/** 菜单项（MUI Menu 经 Portal 渲染到 document.body，不在挂载容器里） */
function menuItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

function menuItem(label: string): HTMLElement {
  const hit = menuItems().find(
    (el) => (el.textContent ?? '').trim() === label,
  );
  expect(
    hit,
    `菜单里应有「${label}」，实际：${menuItems().map((i) => i.textContent).join(' / ')}`,
  ).toBeTruthy();
  return hit!;
}

function isDisabled(el: HTMLElement): boolean {
  return el.getAttribute('aria-disabled') === 'true';
}

/** 把输入区文本设成给定值（直接改 DOM：不触发 onInput，也就不会打乱选区） */
function setEditableText(el: HTMLElement, text: string): void {
  act(() => {
    el.textContent = text;
  });
}

/** 在输入区内建立整段选区 */
function selectAllInEditable(el: HTMLElement): void {
  act(() => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
}

describe('右键菜单组件：形态与回调', () => {
  function renderMenu(canEdit: boolean) {
    const handlers = {
      onClose: vi.fn(),
      onCut: vi.fn(),
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onSelectAll: vi.fn(),
    };
    mount(
      <ThemeProvider theme={muiTheme}>
        <ComposerContextMenu
          position={{ top: 40, left: 60 }}
          canEdit={canEdit}
          {...handlers}
        />
      </ThemeProvider>,
    );
    return handlers;
  }

  it('按截图列出四项：剪切 / 复制 / 粘贴 / 全选', () => {
    renderMenu(true);
    expect(menuItems().map((el) => el.textContent)).toEqual([
      '剪切',
      '复制',
      '粘贴',
      '全选',
    ]);
  });

  it('没有可剪贴的选区时，剪切 / 复制置灰（而不是点了没反应）', () => {
    renderMenu(false);
    expect(isDisabled(menuItem('剪切'))).toBe(true);
    expect(isDisabled(menuItem('复制'))).toBe(true);
    // 粘贴 / 全选与选区无关，始终可用
    expect(isDisabled(menuItem('粘贴'))).toBe(false);
    expect(isDisabled(menuItem('全选'))).toBe(false);
  });

  it('点击每一项都会先关菜单、再触发对应回调', () => {
    const handlers = renderMenu(true);
    click(menuItem('复制'));
    expect(handlers.onCopy).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('禁用项点不动（回调不会被触发）', () => {
    const handlers = renderMenu(false);
    click(menuItem('剪切'));
    expect(handlers.onCut).not.toHaveBeenCalled();
  });

  it('position 为 null 时不渲染菜单', () => {
    mount(
      <ThemeProvider theme={muiTheme}>
        <ComposerContextMenu
          position={null}
          canEdit
          onClose={vi.fn()}
          onCut={vi.fn()}
          onCopy={vi.fn()}
          onPaste={vi.fn()}
          onSelectAll={vi.fn()}
        />
      </ThemeProvider>,
    );
    expect(menuItems()).toHaveLength(0);
  });
});

describe('输入区右键：弹出与可用性', () => {
  it('在输入区点右键会弹出菜单（四项齐全）', () => {
    const host = mountComposer();
    rightClick(editableOf(host));
    expect(menuItems().map((el) => el.textContent)).toEqual([
      '剪切',
      '复制',
      '粘贴',
      '全选',
    ]);
  });

  it('没有选区时剪切 / 复制置灰，粘贴与全选可用', () => {
    const host = mountComposer();
    setEditableText(editableOf(host), '一段文字');
    rightClick(editableOf(host));

    expect(isDisabled(menuItem('剪切'))).toBe(true);
    expect(isDisabled(menuItem('复制'))).toBe(true);
    expect(isDisabled(menuItem('粘贴'))).toBe(false);
    expect(isDisabled(menuItem('全选'))).toBe(false);
  });

  it('已有选区时剪切 / 复制可用', () => {
    const host = mountComposer();
    const editable = editableOf(host);
    setEditableText(editable, '一段文字');
    selectAllInEditable(editable);
    rightClick(editable);

    expect(isDisabled(menuItem('剪切'))).toBe(false);
    expect(isDisabled(menuItem('复制'))).toBe(false);
  });

  it('右键落在附件徽章上，整枚徽章成为选区（剪切/复制可用）', () => {
    const host = mountComposer();
    const editable = editableOf(host);
    setEditableText(editable, '');
    const chip = document.createElement('span');
    chip.dataset.attId = 'att-1';
    chip.contentEditable = 'false';
    chip.textContent = 'IMG.png';
    act(() => {
      editable.appendChild(chip);
    });

    rightClick(chip);

    expect(isDisabled(menuItem('剪切'))).toBe(false);
    expect(isDisabled(menuItem('复制'))).toBe(false);
  });
});

describe('输入区右键：菜单动作', () => {
  it('复制：把选区文本写进剪贴板', async () => {
    const host = mountComposer();
    const editable = editableOf(host);
    setEditableText(editable, '复制我');
    selectAllInEditable(editable);
    rightClick(editable);

    click(menuItem('复制'));
    // writeRichClipboard 是异步降级链，等微任务跑完
    await Promise.resolve();
    await Promise.resolve();

    expect(clip.writeText).toHaveBeenCalledWith('复制我');
  });

  it('剪切：写剪贴板成功后把选区从输入区删除', async () => {
    const host = mountComposer();
    const editable = editableOf(host);
    setEditableText(editable, '剪掉我');
    selectAllInEditable(editable);
    rightClick(editable);

    click(menuItem('剪切'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(clip.writeText).toHaveBeenCalledWith('剪掉我');
    expect(editable.textContent).toBe('');
  });

  it('⚠️ 菜单抢走焦点后选区仍在：复制仍能取到右键那一刻选中的内容', async () => {
    const host = mountComposer();
    const editable = editableOf(host);
    setEditableText(editable, '别丢了我');
    selectAllInEditable(editable);
    rightClick(editable);

    // 模拟菜单的 autoFocus 把选区打散（焦点移出输入区）
    act(() => {
      window.getSelection()?.removeAllRanges();
    });

    click(menuItem('复制'));
    await Promise.resolve();
    await Promise.resolve();

    expect(clip.writeText).toHaveBeenCalledWith('别丢了我');
  });

  it('粘贴：纯文本按光标处插入（与 Ctrl+V 兜底路径一致）', async () => {
    installClipboard({ readText: vi.fn().mockResolvedValue('贴进来') });
    const host = mountComposer();
    const editable = editableOf(host);
    setEditableText(editable, 'hi');
    rightClick(editable);

    click(menuItem('粘贴'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(editable.textContent).toContain('贴进来');
  });

  it('粘贴：纯文本键命中应用层富缓存时还原富内容', async () => {
    stashRichPayload(
      'cache-key',
      JSON.stringify({ rich: '富内容', attachments: [] }),
    );
    installClipboard({ readText: vi.fn().mockResolvedValue('cache-key') });
    const host = mountComposer();
    const editable = editableOf(host);
    setEditableText(editable, '');
    rightClick(editable);

    click(menuItem('粘贴'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 命中的是富 payload（rich 字段），不是把缓存键本身当文本贴进去
    expect(editable.textContent).toContain('富内容');
    expect(editable.textContent).not.toContain('cache-key');
  });

  it('全选：选中输入区全部内容', () => {
    const host = mountComposer();
    const editable = editableOf(host);
    setEditableText(editable, '全都选中');
    rightClick(editable);

    click(menuItem('全选'));

    expect(window.getSelection()?.toString()).toBe('全都选中');
  });
});
