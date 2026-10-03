/**
 * FR-5.6 结果推送：客户端侧「会话 key ⇄ 投递目标」的纯映射与文案。
 *
 * 这一层存在的意义是把**路由身份**这件事钉在一处：投递按 `(channel, chatId)` 走，
 * 而它俩只能从引擎的会话 key `<channel>:<chatId>` 里来。key 拆错 = 推不出去，
 * 且失败是静默的（引擎只打一行 `Unknown channel`），所以判据必须可单测。
 */
import { describe, expect, it } from 'vitest';
import {
  deliveryOptionLabel,
  deliveryTargetFromSession,
  deliveryTargetKey,
  describeDelivery,
  hasDeliveryTarget,
} from '@/lib/taskDelivery';
import type { NanobotChannelSessionSummary } from '@/platform/types';
import type { TaskDelivery } from '@/types';

function summary(
  key: string,
  extra: Partial<NanobotChannelSessionSummary> = {},
): NanobotChannelSessionSummary {
  return {
    key,
    channel: key.split(':')[0] ?? key,
    title: '',
    preview: '',
    messageCount: 1,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    ...extra,
  };
}

describe('deliveryTargetFromSession：会话 key → 投递目标', () => {
  it('按**第一个**冒号拆分渠道与会话', () => {
    expect(deliveryTargetFromSession(summary('wecom:chat-1'))).toEqual({
      channel: 'wecom',
      chatId: 'chat-1',
    });
  });

  it('会话 id 自身含冒号时整段留给 chatId（Discord 线程键就是这种形态）', () => {
    // 按冒号全拆会得到 chatId='456'，路由到错误的会话
    expect(deliveryTargetFromSession(summary('discord:456:thread:777'))).toEqual({
      channel: 'discord',
      chatId: '456:thread:777',
    });
  });

  it('渠道名可带 owner 限定（引擎侧真实形态 `feishu.feishu`）', () => {
    expect(deliveryTargetFromSession(summary('feishu.feishu:ou_abc'))).toEqual({
      channel: 'feishu.feishu',
      chatId: 'ou_abc',
    });
  });

  it('统一会话键给不出目标（它的前缀不是渠道名）', () => {
    // nanobot/session/keys.py 的 UNIFIED_SESSION_KEY；真实路由那时只在
    // 会话元数据的 last_channel 里，渲染层拿不到 → 只能不列为可选项
    expect(deliveryTargetFromSession(summary('unified:default'))).toBeNull();
  });

  it('不成形的键给不出目标（没有冒号 / 冒号在首尾）', () => {
    expect(deliveryTargetFromSession(summary('wecom'))).toBeNull();
    expect(deliveryTargetFromSession(summary(':chat-1'))).toBeNull();
    expect(deliveryTargetFromSession(summary('wecom:'))).toBeNull();
  });
});

describe('deliveryOptionLabel：下拉选项文案', () => {
  it('优先用标题', () => {
    expect(deliveryOptionLabel(summary('wecom:c1', { title: '研发群' }))).toBe('企业微信 · 研发群');
  });

  it('没有标题退到首条消息预览', () => {
    expect(deliveryOptionLabel(summary('wecom:c1', { preview: '帮我看下这个报错' }))).toBe(
      '企业微信 · 帮我看下这个报错',
    );
  });

  it('标题过长截断（Ctrl 组控件里撑长会把下拉拉爆）', () => {
    const label = deliveryOptionLabel(summary('wecom:c1', { title: 'A'.repeat(40) }));
    expect(label).toBe(`企业微信 · ${'A'.repeat(24)}…`);
  });

  it('标题与预览都空时退到会话 id —— 不能出现「企业微信 · 」这种半截文案', () => {
    expect(deliveryOptionLabel(summary('wecom:chat-9'))).toBe('企业微信 · chat-9');
  });

  it('标题里的换行被压成空格（多行标题会让菜单项串行）', () => {
    expect(deliveryOptionLabel(summary('wecom:c1', { title: '研发\n群' }))).toBe('企业微信 · 研发 群');
  });
});

describe('hasDeliveryTarget：按 (channel, chatId) 判在不在列表里', () => {
  it('两种字段都相同才算命中', () => {
    const list = [{ channel: 'wecom', chatId: 'c1' }];
    expect(hasDeliveryTarget(list, { channel: 'wecom', chatId: 'c1' })).toBe(true);
    expect(hasDeliveryTarget(list, { channel: 'wecom', chatId: 'c2' })).toBe(false);
    expect(hasDeliveryTarget(list, { channel: 'feishu', chatId: 'c1' })).toBe(false);
  });

  it('空列表恒 false', () => {
    expect(hasDeliveryTarget([], { channel: 'wecom', chatId: 'c1' })).toBe(false);
  });

  it('比较键含渠道，避免「同 id 不同渠道」被误判为同一个', () => {
    expect(deliveryTargetKey({ channel: 'wecom', chatId: 'x' })).toBe('wecom:x');
  });
});

describe('describeDelivery：任务卡片上的摘要', () => {
  it('未配置 / 空目标都不出这一行', () => {
    expect(describeDelivery(undefined)).toBeNull();
    expect(describeDelivery({ targets: [], on: 'complete' })).toBeNull();
  });

  it('同一渠道的多个会话只报一次渠道名', () => {
    const delivery: TaskDelivery = {
      targets: [
        { channel: 'wecom', chatId: 'c1' },
        { channel: 'wecom', chatId: 'c2' },
      ],
      on: 'complete',
    };
    expect(describeDelivery(delivery)).toBe('推送：企业微信（2 个会话）· 每次执行后');
  });

  it('多渠道并列，并说清推送时机', () => {
    const delivery: TaskDelivery = {
      targets: [
        { channel: 'wecom', chatId: 'c1' },
        { channel: 'feishu.feishu', chatId: 'ou_1' },
      ],
      on: 'error',
    };
    expect(describeDelivery(delivery)).toBe('推送：企业微信、飞书（2 个会话）· 仅失败时');
  });
});
