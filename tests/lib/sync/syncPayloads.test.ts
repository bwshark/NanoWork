/**
 * 云端同步负载的裁剪（architecture-syncmeta §5.2 / §5.3）。
 *
 * 这条判据是**定案的可证伪形式**：渠道凭据「不上行」如果只写在文档里，
 * 下一个人照样可能把 `ChannelConfig` 整对象丢给同步层。所以用一条会红的用例钉住。
 *
 * 同时守一条容易被「顺手优化」掉的边界：**引擎负载与云端负载不是同一份**——
 * 引擎要凭据才能连 IM，云端要的只有用户意图。
 */

import { describe, expect, it } from 'vitest';
import { toNanobotChannels } from '@/ai/runtime/nanobotHttp/channels';
import { CHANNEL_SYNC_OMIT_KEYS, toChannelSyncPayload } from '@/lib/sync/syncPayloads';
import type { ChannelConfig } from '@/types';

/** 一条「什么都有」的渠道配置：凭据、运行时事实、意图全占满 */
function fullChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'ch-1',
    kind: 'feishu',
    enabled: true,
    createdAt: '2026-09-25T00:00:00.000Z',
    clientId: 'dingtalk-client-id',
    clientSecret: 'dingtalk-client-secret',
    appId: 'feishu-app-id',
    appSecret: 'feishu-app-secret',
    botId: 'wecom-bot-id',
    botSecret: 'wecom-bot-secret',
    token: 'weixin-token',
    allowFrom: ['alice'],
    groupPolicy: 'mention',
    topicIsolation: true,
    lastSyncAt: '2026-09-25T01:00:00.000Z',
    syncStatus: 'synced',
    rev: 3,
    updatedAt: '2026-09-25T00:30:00.000Z',
    updatedBy: 'device-a',
    deletedAt: null,
    ...overrides,
  };
}

describe('toChannelSyncPayload：凭据与运行时事实都不上行', () => {
  it('§5.3 定案的四个密钥一律不在负载里', () => {
    const payload = toChannelSyncPayload(fullChannel());

    for (const secret of ['clientSecret', 'appSecret', 'botSecret', 'token']) {
      expect(payload, `凭据字段 ${secret} 不能进同步负载`).not.toHaveProperty(secret);
    }
  });

  it('凭据对的 id 一起剔除（只留 id 会同步出一条永远连不上的渠道）', () => {
    const payload = toChannelSyncPayload(fullChannel());

    for (const id of ['clientId', 'appId', 'botId']) {
      expect(payload, `${id} 与它对应的 secret 是同一个凭据对，必须一起剔`).not.toHaveProperty(id);
    }
  });

  it('运行时事实剔除：对端显示「已同步」会是本机从未发生过的假状态', () => {
    const payload = toChannelSyncPayload(fullChannel());

    expect(payload).not.toHaveProperty('syncStatus');
    expect(payload).not.toHaveProperty('lastSyncAt');
  });

  it('保留下来的是用户意图（渠道种类、开关、白名单、群策略）与同步元数据', () => {
    const payload = toChannelSyncPayload(fullChannel());

    expect(payload).toMatchObject({
      id: 'ch-1',
      kind: 'feishu',
      enabled: true,
      allowFrom: ['alice'],
      groupPolicy: 'mention',
      topicIsolation: true,
      rev: 3,
      updatedBy: 'device-a',
    });
  });

  it('排除表本身也要能被逐条核对（改一处漏一处会被这条抓到）', () => {
    const payload = toChannelSyncPayload(fullChannel());

    // 反向护栏：凡是排除表里的键，负载里一个都不能有
    for (const key of CHANNEL_SYNC_OMIT_KEYS) {
      expect(payload, `排除表列了 ${key}，负载里却还在`).not.toHaveProperty(key);
    }
    // 且排除表不能把所有字段都剔光（那样「同步」就变成了什么都不传）
    expect(Object.keys(payload).length).toBeGreaterThan(5);
  });
});

describe('引擎负载与云端负载是两份（别把裁剪套到引擎那一侧）', () => {
  it('提交给引擎的片段必须带凭据，否则渠道直接不可用', () => {
    const fragment = toNanobotChannels([fullChannel()]);
    const feishu = fragment.feishu as { instances: Array<Record<string, unknown>> };

    expect(feishu.instances[0].appId).toBe('feishu-app-id');
    expect(feishu.instances[0].appSecret).toBe('feishu-app-secret');
  });
});
