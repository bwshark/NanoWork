import { describe, expect, it } from 'vitest';
import {
  describePluginHookEvents,
  describePluginHookTooltip,
  pluginHookChip,
  pluginHookEventLabel,
} from '@/lib/agent/pluginHooks';
import type { PluginHookStats } from '@/types/plugin';

/**
 * 插件钩子的界面文案（FR-3.6）。
 *
 * 这组用例守的是**信息优先级**：卡片上只有一个位置，而「有声明被忽略」比
 * 「有几个生效」更急——作者写了却没跑，是他需要立刻知道的事；生效几条只是常态。
 * 两者同时成立时若先报「2 个生效」，用户就会以为一切正常。
 */

function stats(overrides: Partial<PluginHookStats> = {}): PluginHookStats {
  return { active: 0, events: {}, dropped: 0, ...overrides };
}

describe('pluginHookChip', () => {
  it('没声明 / 没启用 → 不占位（不显示「0 个钩子」的噪声）', () => {
    expect(pluginHookChip(stats())).toBeNull();
  });

  it('有生效 → 报条数', () => {
    expect(pluginHookChip(stats({ active: 3 }))).toEqual({ label: '3 个钩子生效', tone: 'ok' });
  });

  it('同时有丢弃时**优先**报丢弃（写了没跑比跑了几条更急）', () => {
    expect(pluginHookChip(stats({ active: 2, dropped: 1 }))).toEqual({
      label: '1 条钩子声明被忽略',
      tone: 'warn',
    });
  });

  it('只有丢弃没有生效 → 仍然是警告（最典型的形态：整份 JSON 写坏了）', () => {
    expect(pluginHookChip(stats({ dropped: 2 }))?.tone).toBe('warn');
  });
});

describe('describePluginHookEvents', () => {
  it('按固定顺序摊平，不随对象键序漂移', () => {
    const lines = describePluginHookEvents(
      stats({ events: { session_end: 1, before_tool: 2, session_start: 1 } }),
    );
    expect(lines).toEqual(['会话开始 ×1', '工具调用前 ×2', '会话结束 ×1']);
  });

  it('未知事件原样追加在末尾（引擎加了事件，界面也不至于空白）', () => {
    const lines = describePluginHookEvents(stats({ events: { future_event: 1, before_tool: 1 } }));
    expect(lines).toEqual(['工具调用前 ×1', 'future_event ×1']);
  });

  it('计数为 0 的事件不显示', () => {
    expect(describePluginHookEvents(stats({ events: { before_tool: 0 } }))).toEqual([]);
  });

  it('未知事件名直接透传（不做「猜一个中文名」）', () => {
    expect(pluginHookEventLabel('on_boot')).toBe('on_boot');
  });
});

describe('describePluginHookTooltip', () => {
  it('说清条数、分布与「只收窄」的边界', () => {
    const lines = describePluginHookTooltip(
      stats({ active: 1, events: { before_tool: 1 }, dropped: 0 }),
    );
    expect(lines[0]).toContain('1 个');
    expect(lines).toContain('· 工具调用前 ×1');
    // 这条边界必须出现：用户最容易误解成「插件能靠钩子给自己提权」
    expect(lines.join('\n')).toContain('只收窄能力');
  });

  it('有丢弃时给出「去哪看」而不是编一个原因', () => {
    const lines = describePluginHookTooltip(stats({ active: 1, dropped: 2 }));
    const text = lines.join('\n');
    expect(text).toContain('2 条声明被引擎忽略');
    expect(text).toContain('引擎日志');
  });

  it('全 0 时仍给边界说明（卡片不会走到这里，但函数不该返回空数组）', () => {
    expect(describePluginHookTooltip(stats()).length).toBeGreaterThan(0);
  });
});
