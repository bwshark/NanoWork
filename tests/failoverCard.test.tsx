/**
 * 设置「模型 → 故障转移」卡片（FR-9.4）。
 *
 * 锁三类**不会报错、只会让人做错事**的地方：
 *
 * 1. **草稿语义**：链的编辑必须先攒着，点了没保存就不该写盘。逐次落盘会一
 *    重启一次网关（`syncNanobotModels` 写完就重启 serve），而且用户改到一半
 *    想反悔时没有「整体放弃」的出口。
 * 2. **顺序即语义**：上移 / 下移真的改的是重试次序，写出去的数组顺序必须是
 *    屏幕上看到的那个顺序。顺序错了不会报错，只会「回退到不是用户想要的那个模型」。
 * 3. **必须挡住的那一类**：链里引用了已不存在的预设时，保存会写出一份**引擎
 *    拒绝加载**的配置（网关起不来）。这条只能靠界面拦，且要让用户看得见原因。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { FailoverCard } from '@/components/settings/FailoverCard';
import { platform } from '@/platform';
import { useModelsStore, type ManagedModel } from '@/stores/modelsStore';
import type { ModelsSyncResult, NanobotFallbackCandidate } from '@/platform/types';
import { byAria, click, flush, mount, unmount } from './helpers/reactMount';

const syncModels = vi.fn<(json: string) => Promise<ModelsSyncResult>>();

function preset(name: string, over: Partial<ManagedModel> = {}): ManagedModel {
  return {
    name,
    model: `${name}-model`,
    provider: 'customgateway',
    providerKey: 'customgateway',
    providerLabel: '自定义网关',
    apiKey: '',
    apiBase: 'https://example.test/v1',
    hasKey: true,
    isDefault: false,
    custom: true,
    contextWindowTokens: null,
    maxTokens: null,
    reasoningEffort: null,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    customProtocol: false,
    pricing: null,
    temperature: 0.1,
    ...over,
  };
}

const PRESETS = [
  preset('primary', { isDefault: true }),
  preset('backup-a'),
  preset('backup-b'),
];

/** 行序：按 DOM 顺序读回显的链（屏幕上看到什么就是什么） */
function chainRows(): { index: string; text: string }[] {
  return Array.from(document.querySelectorAll('[data-fallback-index]')).map((el) => ({
    index: el.getAttribute('data-fallback-index') ?? '',
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

function bodyText(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ');
}

function saveButton(): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === '保存',
  );
  expect(el, '找不到「保存」按钮').toBeTruthy();
  return el as HTMLButtonElement;
}

/** MUI Select 的显示层：`aria-label` 落在隐藏 input 上，从它往上找触发器 */
function selectTrigger(ariaLabel: string): HTMLElement {
  const input = byAria(ariaLabel);
  expect(input, `找不到下拉框「${ariaLabel}」`).toBeTruthy();
  const trigger = input!.closest('.MuiInputBase-root')?.querySelector('.MuiSelect-select');
  expect(trigger, `下拉框「${ariaLabel}」没有显示层`).toBeTruthy();
  return trigger as HTMLElement;
}

/**
 * 展开 MUI 的下拉。
 *
 * ⚠️ 必须是 `mousedown`：MUI 的 Select 在 mousedown 上开菜单（它 hijack 掉了
 * 原生 focus 行为），派发 `click` 只会落空——表现是「点了没反应」。
 */
async function openSelect(ariaLabel: string): Promise<void> {
  await act(async () => {
    selectTrigger(ariaLabel).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0 }),
    );
  });
  await flush();
}

/** 在已展开的菜单里按文案点一项 */
async function pickOption(text: string): Promise<void> {
  const option = Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
    (li.textContent ?? '').includes(text),
  );
  expect(option, `下拉里没有「${text}」`).toBeTruthy();
  await act(async () => {
    click(option);
  });
  await flush();
}

async function addToChain(presetName: string): Promise<void> {
  await openSelect('添加到回退链');
  await pickOption(presetName);
}

beforeEach(() => {
  vi.restoreAllMocks();
  syncModels.mockReset();
  syncModels.mockResolvedValue({ ok: true, changed: true, message: '已写入' });
  vi.spyOn(platform, 'syncNanobotModels').mockImplementation((json) => syncModels(json));

  useModelsStore.setState({
    models: [],
    managed: PRESETS,
    managedAvailable: true,
    managedLoading: false,
    managedFallbacks: [],
    providerRetryMode: 'standard',
  });
});

afterEach(() => {
  unmount();
});

describe('故障转移卡片 · 展示', () => {
  it('主模型指向默认预设，并说明短路行为', async () => {
    mount(<FailoverCard />);
    await flush();

    const text = bodyText();
    expect(text).toContain('当前主模型：「primary」');
    expect(text).toContain('primary-model');
    expect(text).toContain('连续 3 次失败后短路 60 秒');
  });

  it('没有默认预设时说明主模型来自引擎隐式 default（不是编一个名字出来）', async () => {
    useModelsStore.setState({ managed: [preset('only-one')] });
    mount(<FailoverCard />);
    await flush();

    expect(bodyText()).toContain('引擎隐式 default 预设');
  });

  it('空链给一句「主模型失败会直接报错」，而不是留一块空白', async () => {
    mount(<FailoverCard />);
    await flush();

    expect(bodyText()).toContain('还没有配回退');
  });

  it('两档重试模式的说明都在（两档唯一的实质差别是「什么时候放弃」）', async () => {
    mount(<FailoverCard />);
    await flush();

    // 默认 standard → 显示它的说明
    expect(bodyText()).toContain('1s / 2s / 4s');
  });

  it('读不到引擎配置（Web 端）时给出原因且不能保存', async () => {
    useModelsStore.setState({ managedAvailable: false, managed: [] });
    mount(<FailoverCard />);
    await flush();

    expect(bodyText()).toContain('无法管理故障转移');
    expect(saveButton().disabled).toBe(true);
  });
});

describe('故障转移卡片 · 链的编辑（草稿语义）', () => {
  it('⭐ 添加只改本地：出现「未保存」标记，但**不写盘**', async () => {
    mount(<FailoverCard />);
    await flush();

    await addToChain('backup-a');

    expect(chainRows()).toHaveLength(1);
    expect(chainRows()[0]?.text).toContain('backup-a');
    expect(bodyText()).toContain('有未保存的改动');
    // 逐次落盘 = 逐次重启网关；这条断言就是「编辑先攒着」这个决定的守卫
    expect(syncModels).not.toHaveBeenCalled();
  });

  it('已加入的预设不再出现在「添加」下拉里（从源头不产生重复项）', async () => {
    mount(<FailoverCard />);
    await flush();

    await addToChain('backup-a');
    await openSelect('添加到回退链');

    const options = Array.from(document.querySelectorAll('li[role="option"]')).map((li) =>
      (li.textContent ?? '').trim(),
    );
    expect(options.some((t) => t.startsWith('backup-a'))).toBe(false);
    expect(options.some((t) => t.startsWith('backup-b'))).toBe(true);
  });

  it('⭐ 上移 / 下移真的改次序（屏幕上看到的顺序就是落盘的顺序）', async () => {
    mount(<FailoverCard />);
    await flush();
    await addToChain('backup-a');
    await addToChain('backup-b');
    expect(chainRows().map((r) => r.text)).toEqual([
      expect.stringContaining('backup-a'),
      expect.stringContaining('backup-b'),
    ]);

    click(byAria('下移第1环'));
    await flush();

    expect(chainRows().map((r) => r.text)).toEqual([
      expect.stringContaining('backup-b'),
      expect.stringContaining('backup-a'),
    ]);
    // 位置标签跟着变（它是渲染出来的序号，不是数组下标残留）
    expect(byAria('上移第1环')).toBeTruthy();
    expect(byAria('下移第2环')).toBeTruthy();
  });

  it('第一环的上移与末环的下移被禁用（不做环绕）', async () => {
    useModelsStore.setState({
      managedFallbacks: [
        { kind: 'preset', preset: 'backup-a' },
        { kind: 'preset', preset: 'backup-b' },
      ],
    });
    mount(<FailoverCard />);
    await flush();

    expect((byAria('上移第1环') as HTMLButtonElement).disabled).toBe(true);
    expect((byAria('下移第2环') as HTMLButtonElement).disabled).toBe(true);
    expect((byAria('上移第2环') as HTMLButtonElement).disabled).toBe(false);
  });

  it('移除一环', async () => {
    useModelsStore.setState({
      managedFallbacks: [
        { kind: 'preset', preset: 'backup-a' },
        { kind: 'preset', preset: 'backup-b' },
      ],
    });
    mount(<FailoverCard />);
    await flush();

    click(byAria('移除第1环'));
    await flush();

    expect(chainRows()).toHaveLength(1);
    expect(chainRows()[0]?.text).toContain('backup-b');
  });

  it('「放弃修改」回到磁盘上的样子', async () => {
    useModelsStore.setState({
      managedFallbacks: [{ kind: 'preset', preset: 'backup-a' }],
    });
    mount(<FailoverCard />);
    await flush();

    await addToChain('backup-b');
    expect(chainRows()).toHaveLength(2);

    click(
      Array.from(document.querySelectorAll('button')).find(
        (b) => (b.textContent ?? '').trim() === '放弃修改',
      ),
    );
    await flush();

    expect(chainRows()).toHaveLength(1);
    expect(chainRows()[0]?.text).toContain('backup-a');
    expect(bodyText()).not.toContain('有未保存的改动');
    expect(syncModels).not.toHaveBeenCalled();
  });

  it('内联项保真回显（不因为界面上不能新建就把已有的一条抹掉）', async () => {
    const inline: NanobotFallbackCandidate = {
      kind: 'inline',
      model: 'gpt-4o',
      provider: 'openai',
      maxTokens: 4096,
    };
    useModelsStore.setState({ managedFallbacks: [inline] });
    mount(<FailoverCard />);
    await flush();

    expect(chainRows()[0]?.text).toContain('gpt-4o');
    expect(chainRows()[0]?.text).toContain('内联配置');
  });
});

describe('故障转移卡片 · 保存', () => {
  it('⭐ 落盘的顺序与重试模式就是屏幕上的那个（顺序即语义）', async () => {
    mount(<FailoverCard />);
    await flush();
    await addToChain('backup-a');
    await addToChain('backup-b');
    click(byAria('下移第1环'));
    await flush();
    // 换成「持久」档
    await openSelect('供应商重试模式');
    await pickOption('持久');

    click(saveButton());
    await flush();

    expect(syncModels).toHaveBeenCalledTimes(1);
    expect(JSON.parse(syncModels.mock.calls[0]![0])).toEqual({
      op: 'setFailover',
      fallbacks: [
        { kind: 'preset', preset: 'backup-b' },
        { kind: 'preset', preset: 'backup-a' },
      ],
      providerRetryMode: 'persistent',
    });
    // 保存成功后草稿清空（不再显示「未保存」）
    expect(bodyText()).not.toContain('有未保存的改动');
  });

  it('没有改动时保存按钮不可点（避免一次无意义的写盘 + 网关重启）', async () => {
    mount(<FailoverCard />);
    await flush();

    expect(saveButton().disabled).toBe(true);
  });

  it('桥拒绝时不装作成功：草稿留着（别把用户的编辑丢掉）', async () => {
    syncModels.mockResolvedValue({ ok: false, changed: false, message: '回退链格式非法' });
    mount(<FailoverCard />);
    await flush();
    await addToChain('backup-a');

    click(saveButton());
    await flush();

    expect(bodyText()).toContain('有未保存的改动');
    expect(chainRows()).toHaveLength(1);
  });
});

describe('故障转移卡片 · 问题的两档', () => {
  it('⭐⭐ 引用了不存在的预设 → **禁用保存**并说明原因（网关会起不来）', async () => {
    // 手改过 config.json、或别人在引擎 WebUI 里删掉了这个预设，
    // 都会留下这样一条记录。界面上不拦住它，用户点保存就写出一个加载不了的配置。
    useModelsStore.setState({
      managedFallbacks: [{ kind: 'preset', preset: 'ghost' }],
    });
    mount(<FailoverCard />);
    await flush();

    const text = bodyText();
    expect(text).toContain('已不存在');
    expect(text).toContain('拒绝整份配置');
    expect(saveButton().disabled).toBe(true);
    // 但仍然能把它移出去——否则用户被卡死在这张卡片上
    click(byAria('移除第1环'));
    await flush();
    expect(chainRows()).toHaveLength(0);
    expect(bodyText()).not.toContain('拒绝整份配置');
    // ⭐ 坏项一移除就立刻可保存：拦的是「那一份加载不了的配置」，不是把人锁死
    expect(saveButton().disabled).toBe(false);
  });

  it('回退到主模型本身 → 只提示，不挡保存（会话级模型覆盖会让「主模型」随会话变）', async () => {
    useModelsStore.setState({
      managedFallbacks: [{ kind: 'preset', preset: 'primary' }],
    });
    mount(<FailoverCard />);
    await flush();

    expect(bodyText()).toContain('就是默认模型');
    // 没有未保存改动，所以按钮仍是禁用的；关键是**没有**出现阻断提示
    expect(bodyText()).not.toContain('拒绝整份配置');
  });

  it('重复项 → 只提示', async () => {
    useModelsStore.setState({
      managedFallbacks: [
        { kind: 'preset', preset: 'backup-a' },
        { kind: 'preset', preset: 'backup-a' },
      ],
    });
    mount(<FailoverCard />);
    await flush();

    expect(bodyText()).toContain('重复');
    expect(bodyText()).not.toContain('拒绝整份配置');
  });
});
