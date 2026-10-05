/**
 * IM 频道会话的来源判定与文案（FR-6.4）。
 *
 * 这一层的价值全在「判据只有一处」：此前 id 前缀写在 store 里、`session.channel`
 * 的判空散在列表过滤与会话头部，改一处另一处不会报错。所以用例重点钉**边界值**
 * ——空串 / 只有前缀 / owner 限定形态 / 未知渠道：这些都是真实数据里会出现、
 * 而「靠类型系统看不出来」的形态。
 */

import { describe, expect, it } from 'vitest';
import {
  CHANNEL_SESSION_ID_PREFIX,
  channelGroupKey,
  channelIconKind,
  channelSessionKey,
  externalSourceHint,
  externalSourceLabel,
  isExternalSession,
} from '@/lib/channelSession';

describe('isExternalSession', () => {
  it('channel 有值即外部来源', () => {
    expect(isExternalSession({ channel: 'weixin' })).toBe(true);
  });

  it('空串 / 全空白不算 —— 半截数据不该被标记成外部来源', () => {
    expect(isExternalSession({ channel: '' })).toBe(false);
    expect(isExternalSession({ channel: '   ' })).toBe(false);
  });

  it('缺字段 / null / undefined 不算', () => {
    expect(isExternalSession({})).toBe(false);
    expect(isExternalSession(null)).toBe(false);
    expect(isExternalSession(undefined)).toBe(false);
  });
});

describe('channelSessionKey', () => {
  it('剥掉 nb: 前缀得到 nanobot session key', () => {
    expect(channelSessionKey('nb:weixin:wxid_abc')).toBe('weixin:wxid_abc');
  });

  it('本地会话 id 返回 null', () => {
    expect(channelSessionKey('sess-1')).toBeNull();
  });

  it('只有前缀（键被截断）返回空串而不是 null', () => {
    // 「不是频道会话」（null）与「是频道会话但键为空」（''）是两件事：
    // 合成一类会让调用方的 `if (!key) return` 读起来像「这条不是频道会话」，
    // 而实际是「数据半截」——两者的排查方向完全不同。
    expect(channelSessionKey(CHANNEL_SESSION_ID_PREFIX)).toBe('');
  });
});

describe('channelGroupKey', () => {
  it('owner 限定形态取首段', () => {
    expect(channelGroupKey('feishu.feishu')).toBe('feishu');
    expect(channelGroupKey('wecom.corpA')).toBe('wecom');
  });

  it('未知渠道原样返回，不自作主张并进已有渠道', () => {
    // 这是本批修掉的缺陷：分组键若走 `ChannelKind`（只有 5 个成员），
    // telegram / slack 会被图标回退规则悄悄并进「钉钉」组。
    expect(channelGroupKey('telegram')).toBe('telegram');
    expect(channelGroupKey('slack.team1')).toBe('slack');
  });

  it('空 / 缺失落到 unknown，而不是空串', () => {
    // 空串会让 Map 里出现一个「无名字」分组，界面上是一行没有标题的会话。
    expect(channelGroupKey('')).toBe('unknown');
    expect(channelGroupKey('   ')).toBe('unknown');
    expect(channelGroupKey(undefined)).toBe('unknown');
  });
});

describe('channelIconKind', () => {
  it('有专属图形的渠道原样返回', () => {
    expect(channelIconKind('weixin')).toBe('weixin');
    expect(channelIconKind('feishu.feishu')).toBe('feishu');
  });

  it('未知渠道回退 dingtalk —— 正因如此它绝不能当分组键', () => {
    expect(channelIconKind('telegram')).toBe('dingtalk');
    expect(channelIconKind(undefined)).toBe('dingtalk');
  });
});

describe('来源文案', () => {
  it('标记用渠道展示名', () => {
    expect(externalSourceLabel('wecom')).toBe('来自 企业微信');
    expect(externalSourceLabel('feishu.feishu')).toBe('来自 飞书');
  });

  it('未登记渠道原样显示，不显示成「未知」', () => {
    expect(externalSourceLabel('telegram')).toBe('来自 Telegram');
  });

  it('说明同时写清「只读」与「会投递回去」两个方向', () => {
    const hint = externalSourceHint('weixin');
    expect(hint).toContain('微信');
    expect(hint).toContain('只读');
    expect(hint).toContain('投递回');
  });
});
