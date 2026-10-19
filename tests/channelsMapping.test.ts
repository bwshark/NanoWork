import { describe, expect, it } from 'vitest';
import {
  fromNanobotChannels,
  toNanobotChannels,
} from '../src/ai/runtime/nanobotHttp/channels';
import type { ChannelConfig, ChannelKind } from '../src/types';

/** 造一条最小 ChannelConfig（共用字段） */
function cfg(kind: ChannelKind, over: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: `${kind}-1`,
    kind,
    enabled: true,
    allowFrom: [],
    syncStatus: 'synced',
    lastSyncAt: new Date().toISOString(),
    ...over,
  };
}

describe('toNanobotChannels: tool_approval 写入', () => {
  it('平铺渠道（dingtalk）把 tool_approval 写到条目级', () => {
    const out = toNanobotChannels([cfg('dingtalk', { toolApproval: 'ask' })]);
    expect((out.dingtalk as Record<string, unknown>).tool_approval).toBe('ask');
  });

  it('平铺渠道缺 tool_approval 时不写键（回落引擎默认 auto）', () => {
    const out = toNanobotChannels([cfg('dingtalk')]);
    expect(out.dingtalk).not.toHaveProperty('tool_approval');
  });

  it('feishu 段：tool_approval 写到段级、不进 instances 实例', () => {
    const out = toNanobotChannels([
      cfg('feishu', { toolApproval: 'ask' }),
      cfg('lark', { toolApproval: 'ask' }),
    ]);
    const section = out.feishu as Record<string, unknown>;
    expect(section.tool_approval).toBe('ask');
    for (const inst of section.instances as Array<Record<string, unknown>>) {
      expect(inst).not.toHaveProperty('tool_approval');
    }
  });

  it('feishu / lark 共用段：feishu 优先、lark 缺失时退回 lark', () => {
    const onlyLark = toNanobotChannels([cfg('lark', { toolApproval: 'ask' })]);
    expect((onlyLark.feishu as Record<string, unknown>).tool_approval).toBe('ask');

    const both = toNanobotChannels([
      cfg('feishu', { toolApproval: 'auto' }),
      cfg('lark', { toolApproval: 'ask' }),
    ]);
    expect((both.feishu as Record<string, unknown>).tool_approval).toBe('auto');
  });
});

describe('fromNanobotChannels: tool_approval 回显', () => {
  it('平铺渠道读回条目级 tool_approval', () => {
    const list = fromNanobotChannels({
      dingtalk: { enabled: true, tool_approval: 'ask' },
    } as never);
    const d = list.find((c) => c.kind === 'dingtalk');
    expect(d?.toolApproval).toBe('ask');
  });

  it('feishu 段级 tool_approval 回显到 feishu 与 lark 实例配置', () => {
    const list = fromNanobotChannels({
      feishu: {
        tool_approval: 'ask',
        instances: [
          { domain: 'feishu', appId: 'fa' },
          { domain: 'lark', appId: 'la' },
        ],
      },
    } as never);
    const feishu = list.find((c) => c.kind === 'feishu');
    const lark = list.find((c) => c.kind === 'lark');
    expect(feishu?.toolApproval).toBe('ask');
    expect(lark?.toolApproval).toBe('ask');
  });

  it('feishu 段级缺失时从实例兜底回收（引擎历史泄漏形态）', () => {
    const list = fromNanobotChannels({
      feishu: {
        instances: [{ domain: 'feishu', appId: 'fa', tool_approval: 'ask' }],
      },
    } as never);
    expect(list.find((c) => c.kind === 'feishu')?.toolApproval).toBe('ask');
  });

  it('未知 / 缺省值忽略（不写非法 mode）', () => {
    const list = fromNanobotChannels({
      dingtalk: { enabled: true, tool_approval: 'bogus' },
    } as never);
    expect(list[0].toolApproval).toBeUndefined();
  });

  it('写入后再读回应保持一致（round-trip）', () => {
    const source = [cfg('feishu', { toolApproval: 'ask' }), cfg('weixin', { toolApproval: 'auto' })];
    const fragment = toNanobotChannels(source);
    const back = fromNanobotChannels(fragment as never);
    expect(back.find((c) => c.kind === 'feishu')?.toolApproval).toBe('ask');
    expect(back.find((c) => c.kind === 'weixin')?.toolApproval).toBe('auto');
  });
});
