import { describe, it, expect } from 'vitest';
import { CHANNEL_METAS } from '@/lib/channelMeta';
import {
  CHANNEL_SECRET_FIELD_KEYS,
  CHANNEL_VAULT_PREFIX,
  channelKindOfVaultName,
  channelSecretKeys,
  channelSecretKeysByKind,
  channelVaultName,
  isChannelVaultName,
  pickChannelSecrets,
  stripChannelSecrets,
} from '@/lib/channelSecrets';

/**
 * 渠道凭据归属表的用例。
 *
 * 最重要的一条是**一致性护栏**：`channelMeta` 里标了 `kind: 'secret'` 的字段，
 * 与保险库归属表必须逐字相同。两处漏一个的后果是**静默**的——
 * 表单里新加一个密钥字段而忘了登记，它就仍然明文落 `channels.json`
 * （没有任何报错，也没有任何界面提示），而「没登记」这件事在别处看不出来。
 */

describe('channelSecrets: 与 channelMeta 的一致性护栏', () => {
  it('每个渠道的 secret 字段集合与 channelMeta 逐字一致（双向）', () => {
    for (const meta of CHANNEL_METAS) {
      const fromMeta = meta.fields
        .filter((f) => f.kind === 'secret')
        .map((f) => f.key)
        .sort();
      const fromTable = [...channelSecretKeys(meta.kind)].sort();
      expect(fromTable, `${meta.kind} 的密钥字段与 channelMeta 不一致`).toEqual(fromMeta);
    }
  });

  it('归属表没有多登记 channelMeta 之外的 kind', () => {
    const tableKinds = Object.keys(CHANNEL_SECRET_FIELD_KEYS).sort();
    const metaKinds = CHANNEL_METAS.map((m) => m.kind).sort();
    expect(tableKinds).toEqual(metaKinds);
  });
});

describe('channelSecrets: 保险库命名', () => {
  it('带 channel: 前缀，且能从条目名反解 kind', () => {
    expect(channelVaultName('weixin')).toBe(`${CHANNEL_VAULT_PREFIX}weixin`);
    expect(isChannelVaultName(channelVaultName('feishu'))).toBe(true);
    expect(channelKindOfVaultName(channelVaultName('lark'))).toBe('lark');
  });

  it('MCP 的条目名（无前缀）不被认作渠道条目', () => {
    expect(isChannelVaultName('dingtalk')).toBe(false);
    expect(isChannelVaultName('my-mcp-server')).toBe(false);
    expect(channelKindOfVaultName('my-mcp-server')).toBe('');
  });

  it('与同名 MCP 服务器不共用条目（前缀的意义）', () => {
    // 若不加前缀，名叫 dingtalk 的 MCP 服务器会与钉钉渠道撞在同一条上
    expect(channelVaultName('dingtalk')).not.toBe('dingtalk');
  });
});

describe('channelSecrets: pick / strip / split', () => {
  it('pick 只取非空密钥字段（id 类字段不算密钥）', () => {
    expect(
      pickChannelSecrets({ kind: 'dingtalk', clientId: 'cid', clientSecret: 'cs' }),
    ).toEqual({ clientSecret: 'cs' });
    // 空串不写：避免把「用户没填」当成「用户清空了」
    expect(pickChannelSecrets({ kind: 'weixin', token: '' })).toEqual({});
    // 未知 kind 一律空对象，不猜字段名
    expect(pickChannelSecrets({ kind: 'nope', token: 'x' })).toEqual({});
    expect(pickChannelSecrets({ token: 'x' })).toEqual({});
  });

  it('strip 剥掉密钥字段、保留 id 与策略字段，且不改原对象', () => {
    const cfg = {
      kind: 'feishu',
      appId: 'cli_a',
      appSecret: 'sec',
      allowFrom: ['*'],
      enabled: true,
    };
    const stripped = stripChannelSecrets(cfg);
    expect(stripped).not.toHaveProperty('appSecret');
    expect(stripped.appId).toBe('cli_a');
    expect(stripped.allowFrom).toEqual(['*']);
    // 原对象不动
    expect(cfg.appSecret).toBe('sec');
  });

  it('strip 对拿不准的输入原样返回（宁可不剥，也不删掉用户填的东西）', () => {
    const noKind = { token: 'x' };
    expect(stripChannelSecrets(noKind)).toBe(noKind);
    expect(stripChannelSecrets(null)).toBeNull();
    expect(stripChannelSecrets('oops')).toBe('oops');
  });

  it('pick 对拿不准的输入返回空对象（不猜字段名）', () => {
    expect(pickChannelSecrets(null)).toEqual({});
    expect(pickChannelSecrets([])).toEqual({});
    expect(pickChannelSecrets('oops')).toEqual({});
    expect(pickChannelSecrets({ kind: 42, token: 'x' })).toEqual({});
  });
});

describe('channelSecrets: 保险库 key 名清单收敛', () => {
  it('只留 channel: 前缀的条目并去掉前缀，MCP 条目原样不认', () => {
    const mapped = channelSecretKeysByKind({
      'channel:feishu': ['appSecret'],
      'channel:weixin': ['token'],
      'my-mcp-server': ['token', 'Authorization'],
    });
    expect(mapped).toEqual({ feishu: ['appSecret'], weixin: ['token'] });
    expect(mapped).not.toHaveProperty('my-mcp-server');
  });

  it('空清单收敛为空对象（不返回带 undefined 的键）', () => {
    expect(channelSecretKeysByKind({})).toEqual({});
  });
});
