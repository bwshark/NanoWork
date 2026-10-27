/**
 * `.xlsx` 默认进**表格视图**（DocViewerDrawer 的分支）。
 *
 * 这条判据是这次改动的核心，也是最容易被改回去的一条：
 *
 * > 打开一张表时**不该**去拉 Office 转 PDF。
 *
 * PDF 是打印抽象 —— 单元格点不中、列宽拖不动、sheet 标签不存在。所以断言不只是
 * 「表格出现了」，还包括「`buildFilePreview` 一次都没被调用」：否则功能看着对，
 * 每开一张表却仍要等 3–10 秒，用户会以为界面卡了。
 *
 * ⚠️ 这里不覆盖 PDF 本身（要 canvas）与虚拟化（jsdom 没有布局）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocViewerDrawer } from '@/components/knowledge/DocViewerDrawer';
import type { KbDocument, KbFilePreview } from '@/lib/kb/kbClient';
import type { KbWorkbook } from '@/lib/kb/workbook';
import { dialogRoot, flush, mount, unmount, waitForSettled } from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
});

const DOC: KbDocument = {
  id: 'd9',
  kbId: 'k1',
  title: '银行信息列表',
  chars: 96,
  chunkCount: 2,
  createdAt: '2026-10-27T12:00:00Z',
  kind: 'xlsx',
};

function info(overrides: Partial<KbFilePreview> = {}): KbFilePreview {
  return {
    fileName: '银行信息列表.xlsx',
    bytesLen: 12000,
    suffix: '.xlsx',
    previewState: 'pending',
    previewError: '',
    renderMs: 0,
    previewKind: 'grid',
    gridState: 'ready',
    gridError: '',
    gridMs: 12,
    gridSheets: 1,
    gridCells: 3,
    ...overrides,
  };
}

function book(): KbWorkbook {
  return {
    version: 1,
    activeSheet: 0,
    totalCells: 3,
    warnings: [],
    sheets: [
      {
        id: 'sheet-1',
        name: 'Sheet1',
        row: 5,
        column: 3,
        celldata: [
          { r: 0, c: 0, v: { v: 'ID', m: 'ID', bl: 1 } },
          { r: 0, c: 1, v: { v: '银行名称', m: '银行名称', bl: 1 } },
          { r: 1, c: 0, v: { v: 'dc89911ac', m: 'dc89911ac' } },
          { r: 1, c: 1, v: { v: '未知银行', m: '未知银行' } },
        ],
      },
    ],
  };
}

function renderDrawer(options: { info: KbFilePreview; built?: KbFilePreview }) {
  const loadFilePreview = vi.fn().mockResolvedValue({ ok: true, data: options.info });
  const buildFilePreview = vi
    .fn()
    .mockResolvedValue({ ok: true, data: info({ previewState: 'ready' }) });
  const loadPreviewPdf = vi.fn();
  const buildWorkbook = vi
    .fn()
    .mockResolvedValue({ ok: true, data: options.built ?? info({ gridState: 'ready' }) });
  const loadWorkbook = vi.fn().mockResolvedValue({ ok: true, data: book() });

  mount(
    <DocViewerDrawer
      open
      doc={DOC}
      detail={{ ...DOC, content: 'ID\t银行名称\n dc89911ac\t未知银行' }}
      loading={false}
      error=""
      onRetry={() => {}}
      onClose={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      canEdit={false}
      saving={false}
      onSave={async () => true}
      loadFilePreview={loadFilePreview}
      buildFilePreview={buildFilePreview}
      loadPreviewPdf={loadPreviewPdf}
      buildWorkbook={buildWorkbook}
      loadWorkbook={loadWorkbook}
    />,
  );
  return { loadFilePreview, buildFilePreview, loadPreviewPdf, buildWorkbook, loadWorkbook };
}

describe('xlsx 的表格视图', () => {
  it('直接进表格（不转 PDF），标签是「表格 / 正文」', async () => {
    const api = renderDrawer({ info: info() });

    await waitForSettled(() => dialogRoot().querySelector('[data-testid="kb-grid"]') !== null, {
      timeoutMs: 4000,
    });

    const root = dialogRoot();
    expect(root.querySelector('[data-testid="kb-doc-view-grid"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="kb-grid-cell-1-0"]')?.textContent).toContain(
      'dc89911ac',
    );
    // ⚠️ 这条是重点：打开表格不该触发 Office 转 PDF
    expect(api.buildFilePreview).not.toHaveBeenCalled();
    expect(api.loadPreviewPdf).not.toHaveBeenCalled();
    // 标签换成「表格」而不是「原文」
    expect(root.querySelector('[data-testid="kb-doc-view-tab-grid"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="kb-doc-view-tab-original"]')).toBeNull();
  });

  it('还没解析过（pending）就先解析再取 JSON，两步都要发生', async () => {
    const api = renderDrawer({
      info: info({ gridState: 'pending' }),
      built: info({ gridState: 'ready' }),
    });

    await waitForSettled(() => dialogRoot().querySelector('[data-testid="kb-grid"]') !== null, {
      timeoutMs: 4000,
    });

    expect(api.buildWorkbook).toHaveBeenCalledTimes(1);
    expect(api.loadWorkbook).toHaveBeenCalledTimes(1);
  });

  it('解析失败：把服务端那句原话摆出来，并给「看打印版式」这条退路', async () => {
    renderDrawer({
      info: info({ gridState: 'pending' }),
      built: info({ gridState: 'failed', gridError: '这个 .xlsx 加了密码，无法解析' }),
    });

    await waitForSettled(
      () => dialogRoot().textContent?.includes('加了密码') === true,
      { timeoutMs: 4000 },
    );

    const root = dialogRoot();
    expect(root.querySelector('[data-testid="kb-grid-retry"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="kb-grid-open-pdf"]')).toBeTruthy();
    // 正文是最后的逃生门（表格读不了不代表这篇文档没内容）
    expect(root.querySelector('[data-testid="kb-doc-view-tab-body"]')).toBeTruthy();
  });

  it('切到「正文」看拼回来的文本，再切回表格不重新解析', async () => {
    const api = renderDrawer({ info: info() });
    await waitForSettled(() => dialogRoot().querySelector('[data-testid="kb-grid"]') !== null, {
      timeoutMs: 4000,
    });

    const bodyTab = dialogRoot().querySelector('[data-testid="kb-doc-view-tab-body"]');
    expect(bodyTab).toBeTruthy();
    bodyTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForSettled(() => dialogRoot().textContent?.includes('dc89911ac') === true);
    expect(dialogRoot().querySelector('[data-testid="kb-grid"]')).toBeNull();

    const gridTab = dialogRoot().querySelector('[data-testid="kb-doc-view-tab-grid"]');
    gridTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(dialogRoot().querySelector('[data-testid="kb-grid"]')).toBeTruthy();
    // 切标签是纯前端切换：不该再打一次接口
    expect(api.loadWorkbook).toHaveBeenCalledTimes(1);
  });
});
