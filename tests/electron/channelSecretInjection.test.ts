import { describe, expect, it, vi } from 'vitest';
import {
  carryOverChannelSecrets,
  injectChannelSecrets,
  type SecretReader,
} from '../../electron/channelSecretInjection';

/**
 * 渠道密钥回补 / 兜底保留的用例。
 *
 * 这两个函数守的是同一条不变量：**渲染层提交的片段不带密钥，不得因此抹掉
 * 引擎 config.json 里已有的密钥**。回补负责「保险库有值时补上」，兜底负责
 * 「保险库没值时别删」。只测其中一个都会漏掉另一种失效方式。
 */

/** 造一个按名字取值的读取器（模拟 credentialVault.read） */
function readerFrom(map: Record<string, Record<string, string>>): SecretReader {
  return async (name: string) => map[name] ?? {};
}

describe('injectChannelSecrets: 从保险库回补', () => {
  it('平铺渠道按 kind 取保险库条目并合入', async () => {
    const out = await injectChannelSecrets(
      {
        dingtalk: { enabled: true, clientId: 'cid' },
        weixin: { enabled: true },
      },
      readerFrom({
        'channel:dingtalk': { clientSecret: 'cs' },
        'channel:weixin': { token: 'tk' },
      }),
    );
    expect(out.dingtalk).toEqual({ enabled: true, clientId: 'cid', clientSecret: 'cs' });
    expect(out.weixin).toEqual({ enabled: true, token: 'tk' });
  });

  it('保险库的值覆盖条目自带的同名字段（保险库是权威来源）', async () => {
    const out = await injectChannelSecrets(
      { dingtalk: { clientId: 'cid', clientSecret: 'stale' } },
      readerFrom({ 'channel:dingtalk': { clientSecret: 'fresh' } }),
    );
    expect((out.dingtalk as Record<string, unknown>).clientSecret).toBe('fresh');
  });

  it('飞书段按实例 domain 分别回补（feishu / lark 各有条目）', async () => {
    const out = await injectChannelSecrets(
      {
        feishu: {
          instances: [
            { id: 'feishu', instanceId: 'feishu', domain: 'feishu', appId: 'fa' },
            { id: 'lark', instanceId: 'lark', domain: 'lark', appId: 'la' },
          ],
        },
      },
      readerFrom({
        'channel:feishu': { appSecret: 'fs' },
        'channel:lark': { appSecret: 'ls' },
      }),
    );
    const section = out.feishu as { instances: Array<Record<string, unknown>> };
    expect(section.instances[0].appSecret).toBe('fs');
    expect(section.instances[1].appSecret).toBe('ls');
  });

  it('无 domain 的飞书实例按 feishu 处理（老数据）', async () => {
    const out = await injectChannelSecrets(
      { feishu: { instances: [{ id: 'x', appId: 'a' }] } },
      readerFrom({ 'channel:feishu': { appSecret: 'fs' } }),
    );
    const section = out.feishu as { instances: Array<Record<string, unknown>> };
    expect(section.instances[0].appSecret).toBe('fs');
  });

  it('保险库无该条目时原样返回（交给兜底保留）', async () => {
    const out = await injectChannelSecrets(
      { wecom: { enabled: true, botId: 'bid' } },
      readerFrom({}),
    );
    expect(out.wecom).toEqual({ enabled: true, botId: 'bid' });
  });

  it('保险库读取抛错不阻断同步：当作没有密钥', async () => {
    const reader = vi.fn().mockRejectedValue(new Error('no keyring'));
    const out = await injectChannelSecrets({ dingtalk: { clientId: 'cid' } }, reader);
    expect(out.dingtalk).toEqual({ clientId: 'cid' });
  });

  it('非对象条目 / 非托管键原样带过，不被破坏', async () => {
    const out = await injectChannelSecrets(
      { dingtalk: 'oops', websocket: { tokenIssueSecret: 'keep' }, extra: 1 },
      readerFrom({ 'channel:dingtalk': { clientSecret: 'cs' } }),
    );
    expect(out.dingtalk).toBe('oops');
    expect(out.websocket).toEqual({ tokenIssueSecret: 'keep' });
    expect(out.extra).toBe(1);
  });

  it('不改入参（纯函数）', async () => {
    const input = { weixin: { enabled: true } };
    await injectChannelSecrets(input, readerFrom({ 'channel:weixin': { token: 'tk' } }));
    expect(input.weixin).toEqual({ enabled: true });
  });
});

describe('carryOverChannelSecrets: 回补不到时保留磁盘值', () => {
  it('待写条目缺密钥字段而磁盘有值时保留（防一次同步抹掉引擎侧凭据）', () => {
    const out = carryOverChannelSecrets(
      { dingtalk: { enabled: true, clientId: 'cid' } },
      { dingtalk: { enabled: true, clientId: 'cid', clientSecret: 'on-disk' } },
    );
    expect((out.dingtalk as Record<string, unknown>).clientSecret).toBe('on-disk');
  });

  it('空串等同于缺失：仍取磁盘值', () => {
    const out = carryOverChannelSecrets(
      { weixin: { enabled: true, token: '' } },
      { weixin: { enabled: true, token: 'on-disk' } },
    );
    expect((out.weixin as Record<string, unknown>).token).toBe('on-disk');
  });

  it('待写条目自带非空密钥时以它为准（用户改了就用新的）', () => {
    const out = carryOverChannelSecrets(
      { weixin: { enabled: true, token: 'new' } },
      { weixin: { enabled: true, token: 'old' } },
    );
    expect((out.weixin as Record<string, unknown>).token).toBe('new');
  });

  it('整条不在待写片段里 = 用户删了它：不复活', () => {
    const out = carryOverChannelSecrets(
      {},
      { weixin: { enabled: true, token: 'on-disk' } },
    );
    expect(out).not.toHaveProperty('weixin');
  });

  it('磁盘本就没有该渠道时不凭空造字段', () => {
    const out = carryOverChannelSecrets({ wecom: { botId: 'bid' } }, {});
    expect(out.wecom).toEqual({ botId: 'bid' });
  });

  it('飞书段按 instanceId 匹配后保留 appSecret', () => {
    const out = carryOverChannelSecrets(
      { feishu: { instances: [{ instanceId: 'feishu', domain: 'feishu', appId: 'a' }] } },
      {
        feishu: {
          instances: [{ instanceId: 'feishu', domain: 'feishu', appId: 'a', appSecret: 'disk' }],
        },
      },
    );
    const section = out.feishu as { instances: Array<Record<string, unknown>> };
    expect(section.instances[0].appSecret).toBe('disk');
  });

  it('飞书实例匹配不上时不串味（宁可不保留，也不把别人的密钥塞过来）', () => {
    const out = carryOverChannelSecrets(
      { feishu: { instances: [{ instanceId: 'lark', domain: 'lark', appId: 'la' }] } },
      {
        feishu: {
          instances: [{ instanceId: 'feishu', domain: 'feishu', appId: 'fa', appSecret: 'fs' }],
        },
      },
    );
    const section = out.feishu as { instances: Array<Record<string, unknown>> };
    expect(section.instances[0]).not.toHaveProperty('appSecret');
  });

  it('缺失 instanceId 时退回 domain 匹配', () => {
    const out = carryOverChannelSecrets(
      { feishu: { instances: [{ domain: 'lark', appId: 'la' }] } },
      { feishu: { instances: [{ domain: 'lark', appId: 'la', appSecret: 'ls' }] } },
    );
    const section = out.feishu as { instances: Array<Record<string, unknown>> };
    expect(section.instances[0].appSecret).toBe('ls');
  });

  it('不改入参（纯函数）', () => {
    const incoming = { weixin: { enabled: true } };
    carryOverChannelSecrets(incoming, { weixin: { token: 'on-disk' } });
    expect(incoming.weixin).toEqual({ enabled: true });
  });
});

describe('inject + carryOver 组合：两种失效方式都不会丢凭据', () => {
  it('保险库可用 → 回补；保险库不可用 → 保留磁盘值', async () => {
    const existing = { dingtalk: { enabled: true, clientId: 'cid', clientSecret: 'on-disk' } };
    const incoming = { dingtalk: { enabled: true, clientId: 'cid' } };

    // 保险库可用
    const injected = await injectChannelSecrets(
      incoming,
      readerFrom({ 'channel:dingtalk': { clientSecret: 'from-vault' } }),
    );
    const ok = carryOverChannelSecrets(injected, existing);
    expect((ok.dingtalk as Record<string, unknown>).clientSecret).toBe('from-vault');

    // 保险库不可用（读不到）
    const empty = await injectChannelSecrets(incoming, readerFrom({}));
    const fallback = carryOverChannelSecrets(empty, existing);
    expect((fallback.dingtalk as Record<string, unknown>).clientSecret).toBe('on-disk');
  });
});
