import { describe, expect, it } from 'vitest';
import {
  PERMISSIVE_CAPABILITIES,
  degradedNotice,
  resolveModelCapabilities,
  visionNotice,
  type CapabilitySource,
} from '@/lib/model/modelCapability';

function src(over: Partial<CapabilitySource> & { name: string }): CapabilitySource {
  return {
    isDefault: false,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    ...over,
  };
}

const presets: CapabilitySource[] = [
  src({ name: 'qwen3.8-flash' }),
  src({
    name: 'local-chat',
    isDefault: true,
    supportsTools: false,
    supportsReasoning: false,
    supportsVision: true,
  }),
];

describe('resolveModelCapabilities', () => {
  it('按预设名精确命中', () => {
    const r = resolveModelCapabilities(presets, 'qwen3.8-flash');
    expect(r.origin).toBe('preset');
    expect(r.presetName).toBe('qwen3.8-flash');
    expect(r.capabilities).toEqual({ toolCall: true, vision: false, reasoning: true });
  });

  it('Auto（undefined / null / 空串）解析到**默认预设**，而不是「查不到」', () => {
    for (const id of [undefined, null, '', '   ']) {
      const r = resolveModelCapabilities(presets, id);
      expect(r.origin, String(id)).toBe('default-preset');
      expect(r.presetName).toBe('local-chat');
      // 默认预设恰恰最可能被显式取消勾选；漏掉它等于门控形同虚设
      expect(r.capabilities.toolCall).toBe(false);
      expect(r.capabilities.reasoning).toBe(false);
    }
  });

  it('⭐ 查不到元数据一律**宽松**（查不到 ≠ 不支持）', () => {
    // Web 端 / 引擎离线 / 用户手填的模型名三种都落到这里。读成 false 会让每个升级
    // 上来的用户在元数据到达前丢掉技能挂载，且毫无报错。
    for (const [sources, id] of [
      [[], 'anything'],
      [presets, 'not-in-presets'],
      [[src({ name: 'a' })], undefined], // 没有 isDefault 条目
    ] as const) {
      const r = resolveModelCapabilities(sources as CapabilitySource[], id as string);
      expect(r.origin).toBe('unknown');
      expect(r.presetName).toBeNull();
      expect(r.capabilities).toEqual(PERMISSIVE_CAPABILITIES);
    }
  });

  it('宽松常量是独立的副本（调用方改它不该污染下一次解析）', () => {
    const r = resolveModelCapabilities([], 'x');
    r.capabilities.toolCall = false;
    expect(PERMISSIVE_CAPABILITIES.toolCall).toBe(true);
  });

  it('模型名两侧空白不算差异（会话元数据可能被手改过）', () => {
    expect(resolveModelCapabilities(presets, ' qwen3.8-flash ').presetName).toBe('qwen3.8-flash');
  });
});

describe('提示文案', () => {
  it('能调工具时不提示降级', () => {
    expect(degradedNotice({ toolCall: true, vision: true, reasoning: true })).toBeNull();
  });

  it('降级提示要说清「不能做什么」与「去哪儿改」', () => {
    const text = degradedNotice({ toolCall: false, vision: true, reasoning: true })!;
    expect(text).toContain('技能挂载');
    expect(text).toContain('工具审批');
    // 只写「当前模型不支持工具调用」等于把用户扔在原地：他得知道去设置里勾哪一项
    expect(text).toContain('设置 → 模型');
    expect(text).toContain('工具调用');
  });

  it('视觉能力**只提醒不阻止**（默认值是 false，硬门禁会把所有历史预设一并禁掉）', () => {
    expect(visionNotice({ toolCall: true, vision: true, reasoning: true })).toBeNull();
    const text = visionNotice({ toolCall: true, vision: false, reasoning: true })!;
    expect(text).toContain('未声明图片输入能力');
    // 措辞必须是「可能无法识别」而不是「不能添加」——判断权留给人
    expect(text).toContain('可能');
  });
});
