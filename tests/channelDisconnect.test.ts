import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { disconnectChannelInConfig, resolveWeixinAccountPath } from '../electron/channelDisconnect';

/**
 * 渠道断开连接清洗纯函数测试。
 *
 * 背景：nanobot 引擎无 disconnect/logout action，断开由应用侧在配置层完成：
 * - weixin：清 token / baseUrl 并置 enabled=false，保留 allowFrom 等策略字段；
 * - feishu / lark：在 channels.feishu.instances[] 中按 domain 定位实例，
 *   清 appId / appSecret / identityKey 并置 enabled=false，不得误伤另一 domain 实例。
 */

describe('resolveWeixinAccountPath: 微信状态文件定位（stateDir 兼容）', () => {
  it('无 stateDir：回落默认 <config 目录>/weixin/account.json', () => {
    expect(resolveWeixinAccountPath('/cfg', { enabled: true, token: 'tk' })).toBe(
      join('/cfg', 'weixin', 'account.json'),
    );
    // weixin 段缺失 / 非对象同样回落默认路径（容错不抛错）
    expect(resolveWeixinAccountPath('/cfg', undefined)).toBe(
      join('/cfg', 'weixin', 'account.json'),
    );
    expect(resolveWeixinAccountPath('/cfg', 'bad')).toBe(
      join('/cfg', 'weixin', 'account.json'),
    );
  });

  it('stateDir 非空：按自定义状态目录定位（对齐引擎 state.py 语义）', () => {
    expect(resolveWeixinAccountPath('/cfg', { stateDir: '/custom/state' })).toBe(
      join('/custom/state', 'account.json'),
    );
  });

  it('兼容 snake_case state_dir；空白值视为未配置回落默认', () => {
    expect(resolveWeixinAccountPath('/cfg', { state_dir: '/snake/dir' })).toBe(
      join('/snake/dir', 'account.json'),
    );
    expect(resolveWeixinAccountPath('/cfg', { stateDir: '   ' })).toBe(
      join('/cfg', 'weixin', 'account.json'),
    );
  });
});

describe('disconnectChannelInConfig: weixin', () => {
  it('清 token / baseUrl 并置 enabled=false，保留 allowFrom 等策略字段', () => {
    const channels: Record<string, unknown> = {
      weixin: {
        enabled: true,
        token: 'wx-token',
        baseUrl: 'https://ilink.example.com',
        allowFrom: ['wx_user1'],
      },
    };
    expect(disconnectChannelInConfig(channels, 'weixin')).toBe(true);
    const weixin = channels.weixin as Record<string, unknown>;
    expect(weixin.token).toBeUndefined();
    expect(weixin.baseUrl).toBeUndefined();
    expect(weixin.enabled).toBe(false);
    // 策略字段保留：重连后沿用，无需重新配置
    expect(weixin.allowFrom).toEqual(['wx_user1']);
  });

  it('缺少 baseUrl 只清 token 同样报告变更', () => {
    const channels: Record<string, unknown> = {
      weixin: { enabled: true, token: 'tk' },
    };
    expect(disconnectChannelInConfig(channels, 'weixin')).toBe(true);
    expect((channels.weixin as Record<string, unknown>).token).toBeUndefined();
    expect((channels.weixin as Record<string, unknown>).enabled).toBe(false);
  });

  it('幂等：已断开的微信再次调用无变更（返回 false）', () => {
    const channels: Record<string, unknown> = {
      weixin: { enabled: false, allowFrom: ['*'] },
    };
    expect(disconnectChannelInConfig(channels, 'weixin')).toBe(false);
    expect((channels.weixin as Record<string, unknown>).allowFrom).toEqual(['*']);
  });

  it('weixin 段缺失 / 非对象（字符串 / 数组 / null）→ 无变更不报错', () => {
    expect(disconnectChannelInConfig({}, 'weixin')).toBe(false);
    expect(disconnectChannelInConfig({ weixin: 'bad' }, 'weixin')).toBe(false);
    expect(disconnectChannelInConfig({ weixin: [] }, 'weixin')).toBe(false);
    expect(disconnectChannelInConfig({ weixin: null }, 'weixin')).toBe(false);
  });
});

describe('disconnectChannelInConfig: feishu / lark 实例隔离', () => {
  it('断开 feishu 只清 domain=feishu 实例，lark 实例原样保留', () => {
    const channels: Record<string, unknown> = {
      feishu: {
        instances: [
          {
            id: 'feishu',
            instanceId: 'feishu',
            domain: 'feishu',
            enabled: true,
            appId: 'cli_a',
            appSecret: 'secret_a',
            identityKey: 'ik_a',
            allowFrom: ['ou_1'],
            groupPolicy: 'mention',
          },
          {
            id: 'lark',
            instanceId: 'lark',
            domain: 'lark',
            enabled: true,
            appId: 'cli_b',
            appSecret: 'secret_b',
          },
        ],
      },
    };
    expect(disconnectChannelInConfig(channels, 'feishu')).toBe(true);
    const instances = (channels.feishu as { instances: Array<Record<string, unknown>> }).instances;
    // feishu 实例：凭证清除 + 停用；策略字段（allowFrom / groupPolicy）保留
    expect(instances[0].appId).toBeUndefined();
    expect(instances[0].appSecret).toBeUndefined();
    expect(instances[0].identityKey).toBeUndefined();
    expect(instances[0].enabled).toBe(false);
    expect(instances[0].allowFrom).toEqual(['ou_1']);
    expect(instances[0].groupPolicy).toBe('mention');
    // lark 实例：不得误伤
    expect(instances[1].appId).toBe('cli_b');
    expect(instances[1].appSecret).toBe('secret_b');
    expect(instances[1].enabled).toBe(true);
  });

  it('断开 lark 只清 domain=lark 实例，feishu 实例原样保留', () => {
    const channels: Record<string, unknown> = {
      feishu: {
        instances: [
          { domain: 'feishu', enabled: true, appId: 'cli_a', appSecret: 's_a' },
          { domain: 'lark', enabled: true, appId: 'cli_b', appSecret: 's_b', identityKey: 'ik_b' },
        ],
      },
    };
    expect(disconnectChannelInConfig(channels, 'lark')).toBe(true);
    const instances = (channels.feishu as { instances: Array<Record<string, unknown>> }).instances;
    expect(instances[0].appId).toBe('cli_a');
    expect(instances[0].enabled).toBe(true);
    expect(instances[1].appId).toBeUndefined();
    expect(instances[1].appSecret).toBeUndefined();
    expect(instances[1].identityKey).toBeUndefined();
    expect(instances[1].enabled).toBe(false);
  });

  it('缺省 domain 的实例视为 feishu（与反向映射 fromNanobotChannels 一致）', () => {
    const channels: Record<string, unknown> = {
      feishu: {
        instances: [{ enabled: true, appId: 'cli_x', appSecret: 'sx' }],
      },
    };
    expect(disconnectChannelInConfig(channels, 'feishu')).toBe(true);
    const inst = (channels.feishu as { instances: Array<Record<string, unknown>> }).instances[0];
    expect(inst.appId).toBeUndefined();
    expect(inst.enabled).toBe(false);
    // lark 视角则匹配不到该实例
    expect(disconnectChannelInConfig(channels, 'lark')).toBe(false);
  });

  it('幂等：已断开实例再次调用无变更（返回 false）', () => {
    const channels: Record<string, unknown> = {
      feishu: {
        instances: [{ domain: 'feishu', enabled: false, allowFrom: ['*'] }],
      },
    };
    expect(disconnectChannelInConfig(channels, 'feishu')).toBe(false);
  });

  it('instances 缺失 / feishu 段非对象 → 无变更不报错', () => {
    expect(disconnectChannelInConfig({ feishu: {} }, 'feishu')).toBe(false);
    expect(disconnectChannelInConfig({ feishu: 'bad' }, 'feishu')).toBe(false);
    expect(disconnectChannelInConfig({ feishu: [] }, 'lark')).toBe(false);
    expect(disconnectChannelInConfig({}, 'lark')).toBe(false);
  });

  it('instances 含脏元素（null / 字符串 / 数组）跳过，合法元素正常清洗', () => {
    const channels: Record<string, unknown> = {
      feishu: {
        instances: [null, 'bad', [], { domain: 'feishu', enabled: true, appId: 'cli_ok' }],
      },
    };
    expect(disconnectChannelInConfig(channels, 'feishu')).toBe(true);
    const instances = (channels.feishu as { instances: Array<Record<string, unknown>> }).instances;
    expect(instances).toHaveLength(4); // 脏元素不移除，仅跳过
    expect(instances[3].appId).toBeUndefined();
    expect(instances[3].enabled).toBe(false);
  });

  it('无匹配 domain 的实例（只有 lark 却断开 feishu）→ 无变更', () => {
    const channels: Record<string, unknown> = {
      feishu: { instances: [{ domain: 'lark', enabled: true, appId: 'cli_b' }] },
    };
    expect(disconnectChannelInConfig(channels, 'feishu')).toBe(false);
    expect(
      ((channels.feishu as { instances: Array<Record<string, unknown>> }).instances[0]).appId,
    ).toBe('cli_b');
  });
});

describe('disconnectChannelInConfig: 其他渠道不受影响', () => {
  it('断开微信不影响钉钉 / 企微 / 飞书段', () => {
    const channels: Record<string, unknown> = {
      weixin: { enabled: true, token: 'tk' },
      dingtalk: { enabled: true, clientId: 'cid' },
      wecom: { enabled: true, botId: 'bid' },
      feishu: { instances: [{ domain: 'feishu', enabled: true, appId: 'cli_a' }] },
    };
    expect(disconnectChannelInConfig(channels, 'weixin')).toBe(true);
    expect((channels.dingtalk as Record<string, unknown>).clientId).toBe('cid');
    expect((channels.wecom as Record<string, unknown>).botId).toBe('bid');
    expect(
      ((channels.feishu as { instances: Array<Record<string, unknown>> }).instances[0]).appId,
    ).toBe('cli_a');
  });
});
