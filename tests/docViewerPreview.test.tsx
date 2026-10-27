/**
 * 「原文 / 正文」两个视图的编排（DocViewerDrawer）。
 *
 * 这一层守的是**四种状态各说各的话**：
 *
 * - `ready`/`pending` → 默认进原文（这就是"上传后以对应文档类型打开"）；
 * - `failed` → 别让用户停在空白页：落到正文，但错误要能看见、能重试；
 * - `unavailable` → 连切换都不出现（早期文档没有原文件，摆个点不动的标签更糟）。
 *
 * ⚠️ 这里**不覆盖 pdf.js 本身的渲染**：画布要 canvas，jsdom 没有实现。
 * 那条路由真机验（`/preview.pdf` 的服务端契约在 `cloud/tests/test_kb_files.py` 里钉住）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocViewerDrawer } from '@/components/knowledge/DocViewerDrawer';
import type { KbDocument, KbFilePreview } from '@/lib/kb/kbClient';
import { dialogRoot, flush, mount, unmount, waitForSettled } from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
});

const DOC: KbDocument = {
  id: 'd1',
  kbId: 'k1',
  title: '大模型的本地部署和微调',
  chars: 10004,
  chunkCount: 15,
  createdAt: '2026-10-26T12:00:00Z',
};

function preview(overrides: Partial<KbFilePreview> = {}): KbFilePreview {
  return {
    fileName: '大模型的本地部署和微调.pptx',
    bytesLen: 695954,
    suffix: '.pptx',
    previewState: 'ready',
    previewError: '',
    renderMs: 0,
    ...overrides,
  };
}

function renderDrawer(options: {
  info: KbFilePreview;
  built?: KbFilePreview;
  canEdit?: boolean;
}) {
  const loadFilePreview = vi.fn().mockResolvedValue({ ok: true, data: options.info });
  const buildFilePreview = vi
    .fn()
    .mockResolvedValue({ ok: true, data: options.built ?? options.info });
  // 真的走 pdf.js 会在 jsdom 里抛（没有 canvas）：这里只给一个空 blob，
  // 断言点全在「视图切换与提示」上，不在画布
  const loadPreviewPdf = vi.fn().mockResolvedValue({ ok: true, data: new Blob(['%PDF-1.4']) });

  mount(
    <DocViewerDrawer
      open
      doc={DOC}
      detail={{ ...DOC, content: '第一页的正文\n\n第二页的正文' }}
      loading={false}
      error=""
      onRetry={() => {}}
      onClose={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      canEdit={options.canEdit ?? false}
      saving={false}
      onSave={async () => true}
      loadFilePreview={loadFilePreview}
      buildFilePreview={buildFilePreview}
      loadPreviewPdf={loadPreviewPdf}
    />,
  );
  return { loadFilePreview, buildFilePreview, loadPreviewPdf };
}

describe('原文视图', () => {
  it('有原文件时出现「原文 / 正文」切换，且默认进原文', async () => {
    const api = renderDrawer({ info: preview({ previewState: 'pending', renderMs: 0 }) });

    await waitForSettled(() => dialogRoot().querySelector('[data-testid="kb-doc-view-switch"]') !== null);

    const root = dialogRoot();
    expect(root.querySelector('[data-testid="kb-doc-view-original"]')).toBeTruthy();
    // pending → 自动触发一次转换
    expect(api.buildFilePreview).toHaveBeenCalledTimes(1);
    // 正文此刻不该同时渲染（两套视图叠在一起 = 滚轮打架）
    expect(root.querySelector('[data-testid="kb-editor"]')).toBeNull();
  });

  it('点「正文」能回到 Markdown 正文（原文只是默认，不是唯一）', async () => {
    renderDrawer({ info: preview() });
    // 等切换条出现（ready 之后才渲染），**不等** pdf.js —— 画布在 jsdom 里没有实现
    await waitForSettled(
      () => dialogRoot().querySelector('[data-testid="kb-doc-view-tab-body"]') !== null,
      { timeoutMs: 2000 },
    );

    const bodyTab = dialogRoot().querySelector('[data-testid="kb-doc-view-tab-body"]');
    expect(bodyTab).toBeTruthy();
    bodyTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    await waitForSettled(() => dialogRoot().textContent?.includes('第一页的正文') === true);
    expect(dialogRoot().textContent).toContain('第一页的正文');
  });

  it('没有原文件的早期文档：不出现切换，直接看正文', async () => {
    renderDrawer({
      info: preview({
        fileName: '',
        suffix: '',
        previewState: 'unavailable',
        previewError: '这篇是早期入库的，没有留原文件',
      }),
    });

    await flush();

    const root = dialogRoot();
    expect(root.querySelector('[data-testid="kb-doc-view-switch"]')).toBeNull();
    expect(root.textContent).toContain('第一页的正文');
    // 原因要说出来（否则用户只会觉得"这文档怎么没有原文"）
    expect(root.querySelector('[data-testid="kb-preview-note"]')?.textContent).toContain('早期入库');
  });

  it('转换失败：落到正文，但错误与「重试」都在，不装作正常', async () => {
    const api = renderDrawer({
      info: preview({ previewState: 'pending' }),
      built: preview({ previewState: 'failed', previewError: 'com_error: 文件可能已经损坏' }),
    });

    await waitForSettled(() => dialogRoot().textContent?.includes('文件可能已经损坏') === true);
    const root = dialogRoot();

    // 停在原文视图：错误原样显示 + 重试入口就在旁边
    expect(root.querySelector('[data-testid="kb-preview-retry"]')).toBeTruthy();
    const retry = root.querySelector('[data-testid="kb-preview-retry"]')!;
    retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(api.buildFilePreview).toHaveBeenCalledTimes(2);

    // 「先看正文」是逃生门：内容照样能读
    const [escape] = Array.from(dialogRoot().querySelectorAll('button')).filter(
      (item) => item.textContent === '先看正文',
    );
    expect(escape).toBeTruthy();
    escape.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitForSettled(() => dialogRoot().textContent?.includes('第一页的正文') === true);
    expect(dialogRoot().textContent).toContain('第一页的正文');
  });
});
