/**
 * 文档阅读抽屉的**左边缘拖宽**。
 *
 * 为什么要单独钉住：原来宽度是写死的 `860`，所以「拖一下能变宽」这条一旦被
 * 改回去（比如某人为了省事把 `width` 换回常量），界面上不会有任何报错 ——
 * 只是抓手还在、拖了没反应。这里断言的是 `aria-valuenow`，它是抓手自己报出来
 * 的真实宽度，比读样式（sx 生成的是 class，不是 inline style）可靠。
 *
 * ⚠️ jsdom 没有布局：`getBoundingClientRect().width` 恒为 0，抓手会退回 `width`
 * 当起点 —— 所以断言里的算术是按「起点 = 860」写的，真机上起点取实际渲染宽度。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { DocViewerDrawer } from '@/components/knowledge/DocViewerDrawer';
import type { KbDocument } from '@/lib/kb/kbClient';
import { byAria, click, dialogRoot, mount, unmount } from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
});

const DOC: KbDocument = {
  id: 'd1',
  kbId: 'k1',
  title: '说明文档',
  chars: 5,
  chunkCount: 1,
  createdAt: '2026-10-27T12:00:00Z',
  kind: 'docx',
};

function renderDrawer() {
  mount(
    <DocViewerDrawer
      open
      doc={DOC}
      detail={{ ...DOC, content: 'hello' }}
      loading={false}
      error=""
      onRetry={() => {}}
      onClose={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      canEdit={false}
      saving={false}
      onSave={async () => true}
      // 不传预览接口：抽屉停在「正文」，这条用例只关心宽度，不牵扯转 PDF
    />,
  );
}

const handle = () =>
  dialogRoot().querySelector('[data-testid="edge-resize-handle"]') as HTMLElement | null;
const widthNow = () => Number(handle()?.getAttribute('aria-valuenow'));

/** jsdom 没有 PointerEvent：事件类型才是 React 分发时看的东西，用 MouseEvent 顶上 */
const drag = (type: string, clientX: number) => {
  act(() => {
    handle()!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
  });
};

describe('文档抽屉：左边缘拖宽', () => {
  it('默认仍是 860，指针左移变宽、右移变窄，松手后不再跟随', () => {
    renderDrawer();

    expect(handle()).toBeTruthy();
    expect(widthNow()).toBe(860);

    drag('pointerdown', 1000);
    drag('pointermove', 900); // 左移 100 → 变宽 100
    expect(widthNow()).toBe(960);

    drag('pointermove', 1100); // 右移 100（相对起点）→ 变窄 100
    expect(widthNow()).toBe(760);

    drag('pointerup', 1100);
    // 松手后 dragRef 已清空：再怎么移动都不该改宽度
    drag('pointermove', 400);
    expect(widthNow()).toBe(760);
  });

  it('拖过头夹在上下限内（下限 480，上限是窗口宽）', () => {
    renderDrawer();

    drag('pointerdown', 100);
    drag('pointermove', 5000); // 一路往右，抽屉会缩到看不见
    expect(widthNow()).toBe(480);

    drag('pointermove', -5000); // 一路往左，超出屏幕
    expect(widthNow()).toBe(Math.max(480, window.innerWidth));

    drag('pointerup', -5000);
  });

  it('双击复位到默认宽度', () => {
    renderDrawer();

    drag('pointerdown', 1000);
    drag('pointermove', 700); // 左移 300 → 期望 1160，但上限是窗口宽
    drag('pointerup', 700);
    expect(widthNow()).toBe(Math.min(1160, Math.max(480, window.innerWidth)));

    act(() => {
      handle()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(widthNow()).toBe(860);
  });

  it('方向键也能调（左 = 变宽），且是全宽时撤掉抓手', () => {
    renderDrawer();

    const press = (key: string) => {
      act(() => {
        handle()!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
      });
    };

    press('ArrowLeft');
    expect(widthNow()).toBe(884);
    press('ArrowRight');
    press('ArrowRight');
    expect(widthNow()).toBe(836);

    // 全宽没有「边缘」可拖：抓手撤掉，避免出现一条拖不动的热区
    click(byAria('全宽'));
    expect(handle()).toBeNull();
    click(byAria('还原宽度'));
    // 退出全宽后仍是用户调过的宽度，不是默认值
    expect(widthNow()).toBe(836);
  });
});
