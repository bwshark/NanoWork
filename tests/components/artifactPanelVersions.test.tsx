/**
 * 产物面板的版本历史 / 预览 / 对比 / 回退（FR-7.4 的 UI 侧）。
 *
 * 为什么专门补这一组：这组交互在 2026-09-29 就落地了，但 `artifactsUi.test.tsx`
 * 只覆盖到「多版本徽章 / 仅编辑过」那一层 —— 版本历史区里的三个按钮**一直没有测试**。
 * 后果很具体：PRD 从 2026-10-04 起一直写着「版本对比与回退入口未做」，
 * 而它们就在面板里（`ArtifactPanel.tsx:694/304/933`）。
 * **覆盖率不足会让「已实现」和「没实现」在文档上分不清**，所以这组测试同时是文档的锚点。
 *
 * 数据一律走 **store 的真实升版路径**（`recordArtifact` 两次同 id 不同内容），
 * 不手写 `versions[]`：手写的话，`bumpVersion` 那套「同内容不升版 / 链指针 / 正文进 bodies」
 * 的规则一旦坏掉，这组测试照样绿。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { click, mount, unmount } from '../helpers/reactMount';
import { ArtifactPanel } from '@/components/artifacts/ArtifactPanel';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { fileArtifactId } from '@/lib/artifact/fileArtifact';
import { platform } from '@/platform';

const SESSION = 's1';
const PATH = 'D:/aa/report.md';

/** 登记一版；同 id 第二次调用内容不同 → 升一版 */
function record(content: string, change: 'created' | 'modified' = 'created') {
  const id = fileArtifactId(SESSION, PATH);
  useArtifactsStore.getState().recordArtifact(SESSION, 'm1', {
    id,
    type: 'file',
    title: 'report.md',
    path: PATH,
    content,
    change,
    createdAt: '2026-09-29T00:00:00.000Z',
  });
  return id;
}

/**
 * 打开面板并把该产物设为当前标签（版本历史区只在「预览」里，列表态看不到）。
 *
 * ⚠️ tab 的形状是 `{ id, kind: 'artifact' }`，**不是**直接塞一个 Artifact 对象；
 * 传错形状不会报错，面板会安静地退回列表态（症状是「找不到版本历史标题」）。
 */
function openPanel(id: string) {
  useSessionUiStore.setState({
    artifactPanelOpen: true,
    artifactPanelSessionId: SESSION,
    artifactPanelTabs: [{ id, kind: 'artifact' as const }],
    artifactPanelActiveTabId: id,
  });
}

/**
 * 展开「版本历史 (N)」折叠区。
 *
 * ⚠️ 标题不是 `button` 也不是 `[role="button"]`（`GroupHeader` 是个带 onClick 的 Box），
 * 所以按**文本**找最内层那个元素再点——事件会冒泡到拥有 onClick 的祖先。
 * 用「最内层」（`pop()`）而不是第一个，是因为外层容器也含这段文本，
 * 点外层等于点整块区域，命中与否取决于它有没有接 onClick。
 */
function expandVersions(host: HTMLElement) {
  const hits = Array.from(host.querySelectorAll('*')).filter((e) =>
    (e.textContent ?? '').includes('版本历史'),
  );
  const header = hits.at(-1);
  expect(header, `没找到「版本历史」标题，正文：${host.textContent?.slice(0, 160)}`).toBeTruthy();
  act(() => {
    click(header);
  });
}

/**
 * 按 Tooltip 的 aria-label 找控件（MUI 会把 title 复制成 aria-label）。
 *
 * ⚠️ **别限定 `button`**：Tooltip 直接包 IconButton 时 aria-label 落在 button 上，
 * 而包了一层 `<span>`（源码里给「可能 disabled 的按钮」垫的那层）时，它会落在 span 上
 * ——两种写法在同一段代码里并存。限定 button 会让其中一半静默查不到（长度 0），
 * 症状是「按钮没渲染」，实际是选择器挑食。
 */
const iconBtn = (host: HTMLElement, label: string): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)).map((n) =>
    // ⚠️ 命中 span 时必须**向下**取它里面的 button 再点：那层 span 是 button 的**父**，
    // 点击 span 只会从 span 向上冒泡，**永远不会经过 button**，onClick 自然不触发
    // （症状是「按钮找到了但点了没反应」，很容易误判成功能坏了）。
    n.tagName === 'BUTTON' ? n : (n.querySelector('button') ?? n),
  );

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

afterEach(async () => {
  unmount();
  // 面板里有 Tooltip / Collapse 的过渡定时器，不等它们跑完会「全绿但 exit=1」
  await new Promise((r) => setTimeout(r, 400));
});

describe('产物面板：版本历史列表', () => {
  it('只有一个版本时不出现版本历史区（没有可选择的东西）', () => {
    const id = record('唯一版本');
    openPanel(id);

    const host = mount(<ArtifactPanel />);
    expect(host.textContent).not.toContain('版本历史');
  });

  it('两个版本时显示计数；展开后逐版列出并标出「当前」', () => {
    const id = record('第一版正文');
    record('第二版正文', 'modified');
    openPanel(id);

    const host = mount(<ArtifactPanel />);
    expect(host.textContent).toContain('版本历史 (2)');

    expandVersions(host);
    const text = host.textContent ?? '';
    expect(text).toContain('v1');
    expect(text).toContain('v2');
    // 「当前」标签只应出现在最新那一版上
    expect(text).toContain('当前');
  });
});

describe('产物面板：预览历史版本', () => {
  it('点「预览此版本」→ 正文切到那一版（不是当前版）', () => {
    const id = record('第一版正文');
    record('第二版正文', 'modified');
    openPanel(id);

    const host = mount(<ArtifactPanel />);
    // 默认显示当前版（v2）
    expect(host.textContent).toContain('第二版正文');

    expandVersions(host);
    // 列表是原序：第 0 行 = v1 → 它的「预览此版本」就是回看第一版
    const previews = iconBtn(host, '预览此版本');
    expect(previews.length).toBe(2);

    act(() => {
      click(previews[0]);
    });
    expect(host.textContent).toContain('第一版正文');
  });
});

describe('产物面板：版本对比', () => {
  it('点「与当前版本对比」→ 出现对比弹窗', () => {
    const id = record('第一版正文');
    record('第二版正文', 'modified');
    openPanel(id);

    const host = mount(<ArtifactPanel />);
    expandVersions(host);

    const compares = iconBtn(host, '与当前版本对比');
    expect(compares.length).toBe(2);

    act(() => {
      click(compares[0]);
    });

    // 弹窗渲染到 Portal（body 下），不在 host 内
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog, '对比弹窗应已挂载').toBeTruthy();
    expect(dialog?.textContent).toContain('版本对比');
  });
});

describe('产物面板：回退到历史版本', () => {
  it('回退 = 新开一版：版本号 +1，当前正文变成旧版，历史版本全部保留', () => {
    const id = record('第一版正文');
    record('第二版正文', 'modified');
    openPanel(id);

    const host = mount(<ArtifactPanel />);
    expandVersions(host);

    const before = useArtifactsStore.getState().index[id];
    expect(before.version).toBe(2);

    const rollbacks = iconBtn(host, '回退到此版本');
    expect(rollbacks.length).toBe(2);
    act(() => {
      click(rollbacks[0]); // 第 0 行 = v1
    });

    const after = useArtifactsStore.getState().index[id];
    // 「新开一版不覆盖历史」：回退本身也是一次版本推进
    expect(after.version).toBe(3);
    expect(useArtifactsStore.getState().bodies[after.contentHash]).toBe('第一版正文');
    // 历史不丢：v1 / v2 都还在链上，又多了这一版
    expect(after.versions?.map((v) => v.version)).toEqual([1, 2, 3]);
    // 被回退掉的那一版正文必须仍可读到（否则「历史不丢」是空话）
    const v2 = after.versions?.find((v) => v.version === 2);
    expect(useArtifactsStore.getState().bodies[v2?.contentHash ?? '']).toBe('第二版正文');
  });

  /**
   * FR-8.9 接线：回退必须留痕。
   *
   * 为什么单独立一条：版本号是**向前**涨的（回退 = 新开一版），所以事后翻版本历史
   * 只会看到「又有了一版」，完全看不出「有人把正文换回了旧版」——而这恰恰是最该
   * 追查的一类动作。审计是唯一能回答它的地方，漏接则整件事静默消失。
   */
  it('回退会写一条 artifact.rollback 审计（版本历史本身说不出「有人回到旧版」）', () => {
    const append = vi.spyOn(platform, 'auditAppendApp').mockResolvedValue({ ok: true });
    const id = record('旧正文');
    record('新正文', 'modified');
    openPanel(id);

    const host = mount(<ArtifactPanel />);
    expandVersions(host);
    act(() => {
      click(iconBtn(host, '回退到此版本')[0]);
    });

    const lines = append.mock.calls.flatMap((call) => call[0]);
    const rollback = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.action === 'artifact.rollback');
    expect(rollback, '回退没有写审计').toBeTruthy();
    expect(rollback?.targetId).toBe(id);
    // 只留哈希前 8 位：全文哈希对读日志的人没有信息量，前 8 位足够对上版本条目
    expect(String((rollback?.detail as Record<string, unknown>)?.version)).toHaveLength(8);
  });
});
