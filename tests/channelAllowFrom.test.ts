import { describe, it, expect } from 'vitest';
import {
  normalizeChannelAllowFrom,
  normalizeEngineChannelAllowFrom,
} from '../electron/channelAllowFrom';

/**
 * 渠道白名单（allowFrom）归一化纯函数测试。
 *
 * 背景：nanobot 空白名单 = 纯配对码模式，扫码接入用户发消息会被
 * 配对审批墙拦截；引擎扫码回写从不写 allowFrom（飞书甚至主动清空），
 * 主进程在扫码成功后的重启前兜底归一为 ["*"]（与前端手动路径一致）。
 */

describe('normalizeChannelAllowFrom: 单条目归一', () => {
  it('allowFrom 缺失 → 归一为 ["*"] 并报告变更', () => {
    const cfg: Record<string, unknown> = { enabled: true, token: 'tk' };
    expect(normalizeChannelAllowFrom(cfg)).toBe(true);
    expect(cfg.allowFrom).toEqual(['*']);
  });

  it('allowFrom 为空数组 → 归一为 ["*"]', () => {
    const cfg: Record<string, unknown> = { allowFrom: [] };
    expect(normalizeChannelAllowFrom(cfg)).toBe(true);
    expect(cfg.allowFrom).toEqual(['*']);
  });

  it('snake_case allow_from 为空同样触发归一（写回 camelCase 键）', () => {
    const cfg: Record<string, unknown> = { allow_from: [] };
    expect(normalizeChannelAllowFrom(cfg)).toBe(true);
    expect(cfg.allowFrom).toEqual(['*']);
  });

  it('已是 ["*"] → 不变更不落盘语义（返回 false）', () => {
    const cfg: Record<string, unknown> = { allowFrom: ['*'] };
    expect(normalizeChannelAllowFrom(cfg)).toBe(false);
    expect(cfg.allowFrom).toEqual(['*']);
  });

  it('用户显式配置的非空精确名单 → 绝不覆盖', () => {
    const cfg: Record<string, unknown> = { allowFrom: ['ou_user1', 'ou_user2'] };
    expect(normalizeChannelAllowFrom(cfg)).toBe(false);
    expect(cfg.allowFrom).toEqual(['ou_user1', 'ou_user2']);
  });

  it('snake_case 非空名单同样不覆盖', () => {
    const cfg: Record<string, unknown> = { allow_from: ['u1'] };
    expect(normalizeChannelAllowFrom(cfg)).toBe(false);
    expect(cfg.allowFrom).toBeUndefined();
  });

  it('非数组 allowFrom（字符串 / null / 对象）均视为空 → 归一为 ["*"]', () => {
    for (const bad of ['oops', null, {}]) {
      const cfg: Record<string, unknown> = { allowFrom: bad };
      expect(normalizeChannelAllowFrom(cfg)).toBe(true);
      expect(cfg.allowFrom).toEqual(['*']);
    }
  });

  it('双键并存：allowFrom 空数组 + 非空 allow_from → 任一非空即已配置，不覆盖', () => {
    const cfg: Record<string, unknown> = { allowFrom: [], allow_from: ['u1'] };
    expect(normalizeChannelAllowFrom(cfg)).toBe(false);
    expect(cfg.allowFrom).toEqual([]);
    expect(cfg.allow_from).toEqual(['u1']);
  });

  it('双键并存且皆空 → 归一为 ["*"]', () => {
    const cfg: Record<string, unknown> = { allowFrom: [], allow_from: [] };
    expect(normalizeChannelAllowFrom(cfg)).toBe(true);
    expect(cfg.allowFrom).toEqual(['*']);
  });
});

describe('normalizeEngineChannelAllowFrom: weixin 渠道段', () => {
  it('weixin.allowFrom 缺失 → 归一并报告变更', () => {
    const channels: Record<string, unknown> = {
      weixin: { enabled: true, token: 'tk' },
    };
    expect(normalizeEngineChannelAllowFrom(channels, 'weixin')).toBe(true);
    expect((channels.weixin as Record<string, unknown>).allowFrom).toEqual(['*']);
  });

  it('weixin.allowFrom 已有精确名单 → 不覆盖且无变更', () => {
    const channels: Record<string, unknown> = {
      weixin: { enabled: true, allowFrom: ['wx_user'] },
    };
    expect(normalizeEngineChannelAllowFrom(channels, 'weixin')).toBe(false);
    expect((channels.weixin as Record<string, unknown>).allowFrom).toEqual(['wx_user']);
  });

  it('weixin 段缺失 / 非对象 → 无变更不报错', () => {
    expect(normalizeEngineChannelAllowFrom({}, 'weixin')).toBe(false);
    expect(normalizeEngineChannelAllowFrom({ weixin: 'bad' }, 'weixin')).toBe(false);
  });
});

describe('normalizeEngineChannelAllowFrom: feishu 多实例段', () => {
  it('逐实例归一空 allowFrom（含引擎主动清空场景）', () => {
    const channels: Record<string, unknown> = {
      feishu: {
        instances: [
          { id: 'feishu', enabled: true, appId: 'cli_a', allowFrom: [] },
          { id: 'lark', enabled: true, appId: 'cli_b' },
        ],
      },
    };
    expect(normalizeEngineChannelAllowFrom(channels, 'feishu')).toBe(true);
    const instances = (channels.feishu as { instances: Array<Record<string, unknown>> }).instances;
    expect(instances[0].allowFrom).toEqual(['*']);
    expect(instances[1].allowFrom).toEqual(['*']);
  });

  it('非空实例名单不覆盖，混合场景只归一空者', () => {
    const channels: Record<string, unknown> = {
      feishu: {
        instances: [
          { id: 'feishu', allowFrom: ['ou_1'] },
          { id: 'lark', allowFrom: [] },
        ],
      },
    };
    expect(normalizeEngineChannelAllowFrom(channels, 'feishu')).toBe(true);
    const instances = (channels.feishu as { instances: Array<Record<string, unknown>> }).instances;
    expect(instances[0].allowFrom).toEqual(['ou_1']);
    expect(instances[1].allowFrom).toEqual(['*']);
  });

  it('全部实例已非空 → 无变更（不落盘语义）', () => {
    const channels: Record<string, unknown> = {
      feishu: { instances: [{ id: 'feishu', allowFrom: ['*'] }] },
    };
    expect(normalizeEngineChannelAllowFrom(channels, 'feishu')).toBe(false);
  });

  it('instances 缺失 / 含脏元素 → 无变更不报错', () => {
    expect(normalizeEngineChannelAllowFrom({ feishu: {} }, 'feishu')).toBe(false);
    const channels: Record<string, unknown> = {
      feishu: { instances: [null, 'bad', { id: 'x', allowFrom: [] }] },
    };
    expect(normalizeEngineChannelAllowFrom(channels, 'feishu')).toBe(true);
    expect(((channels.feishu as { instances: unknown[] }).instances[2] as Record<string, unknown>).allowFrom).toEqual(['*']);
  });
});

describe('normalizeEngineChannelAllowFrom: 其余渠道不处理', () => {
  it('dingtalk / wecom 等非扫码渠道不注入白名单', () => {
    const channels: Record<string, unknown> = {
      dingtalk: { enabled: true },
      wecom: { enabled: true },
    };
    expect(normalizeEngineChannelAllowFrom(channels, 'dingtalk')).toBe(false);
    expect(normalizeEngineChannelAllowFrom(channels, 'wecom')).toBe(false);
    expect((channels.dingtalk as Record<string, unknown>).allowFrom).toBeUndefined();
  });
});
