/**
 * 渠道展示名（`@/lib/channelLabel`）——侧边栏机器人分组标题与结果推送的共用事实。
 *
 * 这组用例搬来这里（原先挂在 `taskDelivery.test.ts` 下）是因为**归属地即导出地**：
 * 它属于这个模块，就不该由别的模块的测试文件代测。
 */
import { describe, expect, it } from 'vitest';
import { channelLabel } from '@/lib/channelLabel';

describe('channelLabel：渠道展示名', () => {
  it('登记的渠道给中文名', () => {
    expect(channelLabel('wecom')).toBe('企业微信');
    expect(channelLabel('feishu')).toBe('飞书');
    expect(channelLabel('dingtalk')).toBe('钉钉');
    expect(channelLabel('weixin')).toBe('微信');
  });

  it('owner 限定名取首段（`feishu.feishu` 也是飞书）', () => {
    // 引擎多实例渠道的运行时名是 `owner.name`；按整串查表会落到英文原名
    expect(channelLabel('feishu.feishu')).toBe('飞书');
  });

  it('飞书与 Lark 是同一个渠道的两个域名，展示名刻意区分', () => {
    expect(channelLabel('lark')).toBe('飞书（Lark）');
  });

  it('未登记的渠道原样显示（加新渠道不必先改映射表）', () => {
    expect(channelLabel('mattermost')).toBe('mattermost');
  });

  it('未登记的 owner 限定名显示首段，而不是整串', () => {
    expect(channelLabel('matrix.matrix')).toBe('matrix');
  });
});
