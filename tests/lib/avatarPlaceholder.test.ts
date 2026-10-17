/**
 * 专家头像的**占位确定性**（FR-3.9 ② 的本期口径）。
 *
 * 云端头像资产（账户级 CDN）尚未接入，所以界面上的头像是「名称派生的占位」：
 * 首字 + 按名称哈希出的色相。这一批不新增任何网络请求，只锁两件事：
 *
 * 1. **同名同色同字**——两台设备看同一个专家必须是同一个头像，
 *    否则用户在 A 上认人的依据到 B 上就失效了；
 * 2. **同一进程内多次调用结果一致**——不能掺 `Math.random()` / 索引下标。
 *
 * ⚠️ 这是**锁定现状**而不是新功能：`entityAvatarSx` / `avatarGlyph` 早已是纯函数，
 * 但此前没有任何用例钉住「确定性」。这类约定一旦被下一个人改成随机配色，
 * 表现只是「头像颜色变了」，没有任何测试会红。
 */

import { describe, expect, it } from 'vitest';
import { avatarGlyph, entityAvatarSx, hashHue } from '@/lib/cardSx';

describe('hashHue：色相只由名称决定', () => {
  it('同名恒等、异名基本不同（取几个明显不同的样本）', () => {
    expect(hashHue('投研专家')).toBe(hashHue('投研专家'));
    const hues = new Set(['投研专家', '法务专家', '写作专家', '招聘专家'].map(hashHue));
    expect(hues.size).toBeGreaterThan(1);
  });

  it('落点是 0–359 的整数（能直接喂 hsl）', () => {
    for (const name of ['', '?', 'a', '投研专家', 'x'.repeat(64)]) {
      const hue = hashHue(name);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe('entityAvatarSx：占位样式确定', () => {
  it('同一名称两次调用逐字段相等（同色渐变）', () => {
    expect(entityAvatarSx('投研专家')).toEqual(entityAvatarSx('投研专家'));
  });

  it('不同名称给出不同渐变（不是所有人一个颜色）', () => {
    const a = entityAvatarSx('投研专家').backgroundImage;
    const b = entityAvatarSx('法务专家').backgroundImage;
    expect(a).not.toBe(b);
  });

  it('emoji 头像用更大字号（emoji 视觉上比汉字小）', () => {
    expect(entityAvatarSx('投研专家', true).fontSize).toBeGreaterThan(
      entityAvatarSx('投研专家', false).fontSize as number,
    );
  });
});

describe('avatarGlyph：占位字形', () => {
  it('没有头像 → 取名称首字', () => {
    expect(avatarGlyph(undefined, '投研专家')).toEqual({ glyph: '投', isEmoji: false });
  });

  it('头像是 emoji → 原样用（不受名称影响）', () => {
    expect(avatarGlyph('🧪', '投研专家')).toEqual({ glyph: '🧪', isEmoji: true });
  });

  it('头像是 URL / 普通文本 → 退回名称首字（别把 url 的第一个字符画上去）', () => {
    expect(avatarGlyph('https://cdn.example/avatar.png', '法务专家')).toEqual({
      glyph: '法',
      isEmoji: false,
    });
  });

  it('什么都没有 → 问号兜底', () => {
    expect(avatarGlyph(undefined, undefined)).toEqual({ glyph: '?', isEmoji: false });
    expect(avatarGlyph('   ', '  ')).toEqual({ glyph: '?', isEmoji: false });
  });
});
