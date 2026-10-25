/**
 * 提示词模板库（design §13.4）：外置覆盖的读、写、恢复默认。
 *
 * 这个模块的**核心契约**是那条回退链：`有覆盖且非空 → 用覆盖`，
 * `无覆盖 / 空覆盖 / 读失败 → 用内置`。链上任何一环破了，表现都不是报错，
 * 而是「用户改了提示词但没生效」或「提示词变成空串」——两种都很难查。
 *
 * 另一条必须钉住的是 **`resolveSync` 不得触发 IO**：它被用在
 * `streamAssistantReply` 的同步段里，那里 `await` 会破坏「send 同步进入流式态」。
 * 下面的用例通过「先写盘、不 loadAll、断言仍是内置」来证明它是纯内存读取。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptLibrary } from '@/lib/prompt/promptLibrary';
import { DEFAULT_PROMPT_STYLE, findSlot, slotsOfKind } from '@/lib/prompt/promptCatalog';
import type { PromptSlotKind } from '@/types';

const MODE_ASK: [PromptSlotKind, string] = ['mode', 'ask'];

function builtinOf(kind: PromptSlotKind, key: string): string {
  const slot = findSlot(kind, key);
  if (!slot) throw new Error(`测试引用了不存在的槽位：${kind}.${key}`);
  return slot.builtin;
}

beforeEach(() => {
  window.localStorage.clear();
  PromptLibrary.__resetForTest();
});

describe('PromptLibrary：回退链', () => {
  it('无覆盖时 resolveSync 返回内置正文', () => {
    expect(PromptLibrary.resolveSync(...MODE_ASK)).toBe(builtinOf(...MODE_ASK));
  });

  it('写入覆盖后生效', async () => {
    await PromptLibrary.save('mode', 'ask', '自定义问答模式');
    await PromptLibrary.loadAll();
    expect(PromptLibrary.resolveSync('mode', 'ask')).toBe('自定义问答模式');
  });

  it('reset 后回到内置', async () => {
    await PromptLibrary.save('mode', 'ask', '自定义');
    await PromptLibrary.loadAll();
    await PromptLibrary.reset('mode', 'ask');
    await PromptLibrary.loadAll();
    expect(PromptLibrary.resolveSync('mode', 'ask')).toBe(builtinOf('mode', 'ask'));
    expect(PromptLibrary.isCustomized('mode', 'ask')).toBe(false);
  });

  it('空白正文等价于恢复默认（不留下「看起来自定义过」的空文件）', async () => {
    await PromptLibrary.save('mode', 'ask', '先写点东西');
    await PromptLibrary.loadAll();
    expect(PromptLibrary.isCustomized('mode', 'ask')).toBe(true);

    await PromptLibrary.save('mode', 'ask', '   \n  ');
    await PromptLibrary.loadAll();
    expect(PromptLibrary.isCustomized('mode', 'ask')).toBe(false);
    expect(PromptLibrary.resolveSync('mode', 'ask')).toBe(builtinOf('mode', 'ask'));
  });

  it('空白正文不会在存储里留下键', async () => {
    await PromptLibrary.save('mode', 'ask', '');
    const raw = await window.localStorage.getItem(PromptLibrary.storageKeyOf('mode', 'ask'));
    expect(raw).toBeNull();
  });

  it('外部直接写入空白值时，loadAll 把它视为「无覆盖」', async () => {
    await window.localStorage.setItem(
      PromptLibrary.storageKeyOf('mode', 'ask'),
      JSON.stringify('   '),
    );
    await PromptLibrary.loadAll();
    expect(PromptLibrary.isCustomized('mode', 'ask')).toBe(false);
    expect(PromptLibrary.resolveSync('mode', 'ask')).toBe(builtinOf('mode', 'ask'));
  });
});

describe('PromptLibrary：同步取值不触发 IO', () => {
  it('写盘后未 loadAll，resolveSync 仍返回内置（证明读的是内存快照）', async () => {
    await window.localStorage.setItem(
      PromptLibrary.storageKeyOf('mode', 'ask'),
      JSON.stringify('磁盘上的内容'),
    );
    expect(PromptLibrary.isLoaded).toBe(false);
    expect(PromptLibrary.resolveSync('mode', 'ask')).toBe(builtinOf('mode', 'ask'));
  });

  it('loadAll 之后才反映磁盘内容', async () => {
    await window.localStorage.setItem(
      PromptLibrary.storageKeyOf('mode', 'ask'),
      JSON.stringify('磁盘上的内容'),
    );
    await PromptLibrary.loadAll();
    expect(PromptLibrary.resolveSync('mode', 'ask')).toBe('磁盘上的内容');
  });
});

describe('PromptLibrary：健壮性', () => {
  it('未知槽位返回空串（调用方跳过），不抛错也不猜近似值', () => {
    expect(PromptLibrary.resolveSync('style', 'style-does-not-exist')).toBe('');
  });

  it('未知槽位拒绝写入', async () => {
    await expect(PromptLibrary.save('style', 'style-nope', 'x')).rejects.toThrow(/未知的提示词槽位/);
  });

  it('单个槽位存储异常不影响其余槽位', async () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation((key) => {
      if (String(key).includes('mode.ask')) throw new Error('boom');
      return null;
    });
    await expect(PromptLibrary.loadAll()).resolves.toBeUndefined();
    spy.mockRestore();
    expect(PromptLibrary.resolveSync('mode', 'ask')).toBe(builtinOf('mode', 'ask'));
  });

  it('readRaw 返回磁盘原文；无覆盖返回 null', async () => {
    expect(await PromptLibrary.readRaw('mode', 'ask')).toBeNull();
    await PromptLibrary.save('mode', 'ask', '原文');
    expect(await PromptLibrary.readRaw('mode', 'ask')).toBe('原文');
  });
});

describe('PromptLibrary：快照与自定义标记', () => {
  it('statesSync 反映覆盖态与生效正文', async () => {
    await PromptLibrary.save('style', DEFAULT_PROMPT_STYLE, '我的风格');
    await PromptLibrary.loadAll();
    const states = PromptLibrary.statesSync('style');
    const target = states.find((s) => s.slot.key === DEFAULT_PROMPT_STYLE);
    expect(target?.override).toBe('我的风格');
    expect(target?.effective).toBe('我的风格');

    const untouched = states.find((s) => s.slot.key !== DEFAULT_PROMPT_STYLE);
    expect(untouched?.override).toBeNull();
    expect(untouched?.effective).toBe(untouched?.slot.builtin);
  });

  it('statesSync 无参时覆盖全部槽位', () => {
    expect(PromptLibrary.statesSync()).toHaveLength(
      slotsOfKind('mode').length + slotsOfKind('domain').length + slotsOfKind('style').length,
    );
  });

  it('storage key 形状与主进程路由约定一致', () => {
    expect(PromptLibrary.storageKeyOf('mode', 'ask')).toBe('nanowork.prompt.mode.ask');
    expect(PromptLibrary.storageKeyOf('style', 'style-professional')).toBe(
      'nanowork.prompt.style.style-professional',
    );
  });
});
