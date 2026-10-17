import { describe, expect, it } from 'vitest';
import {
  agentBlocksTool,
  computePluginToolGaps,
  type PluginToolGap,
} from '../src/lib/pluginToolGaps';

describe('agentBlocksTool', () => {
  it('allow=undefined（未声明限制）→ 放行全部，包括任何声明工具', () => {
    expect(agentBlocksTool(undefined, undefined, 'read_file')).toBeNull();
    expect(agentBlocksTool(undefined, [], 'shell')).toBeNull();
  });

  it('allow=[]（显式空集）→ 全拒：不在白名单内', () => {
    expect(agentBlocksTool([], undefined, 'read_file')).toBe('not-allowed');
    expect(agentBlocksTool([], ['x'], 'read_file')).toBe('not-allowed');
  });

  it('allow 列了子集 → 不在其中的声明工具被收窄', () => {
    expect(agentBlocksTool(['read_file', 'write_file'], undefined, 'shell')).toBe(
      'not-allowed',
    );
    expect(
      agentBlocksTool(['read_file', 'write_file'], undefined, 'read_file'),
    ).toBeNull();
  });

  it('deny 命中 → 拦截，且优先级高于 allow（盖过白名单）', () => {
    // 即使 allow 明确放行，deny 仍拦截
    expect(agentBlocksTool(['shell'], ['shell'], 'shell')).toBe('denied');
    // deny 命中 + 不在 allow：仍是 denied（不是 not-allowed）
    expect(agentBlocksTool(['read_file'], ['shell'], 'shell')).toBe('denied');
  });

  it('deny 未命中、allow 放行 → 放行', () => {
    expect(agentBlocksTool(['shell'], ['other'], 'shell')).toBeNull();
  });

  it('空白/空工具名不参与（返回 null，不误判）', () => {
    expect(agentBlocksTool(['read_file'], undefined, '   ')).toBeNull();
    expect(agentBlocksTool([], undefined, '')).toBeNull();
  });

  it('工具名前后空白按 trim 后匹配', () => {
    expect(agentBlocksTool(['read_file'], undefined, '  read_file ')).toBeNull();
    expect(agentBlocksTool(['read_file'], undefined, ' shell ')).toBe(
      'not-allowed',
    );
  });
});

describe('computePluginToolGaps', () => {
  it('无任何收窄 → 空数组', () => {
    expect(
      computePluginToolGaps(['read_file', 'shell'], undefined, undefined),
    ).toEqual([]);
  });

  it('allow 子集 → 只收被收窄的声明工具', () => {
    const gaps = computePluginToolGaps(
      ['read_file', 'shell', 'write_file'],
      ['read_file', 'write_file'],
      undefined,
    );
    expect(gaps).toEqual<PluginToolGap[]>([
      { tool: 'shell', reason: 'not-allowed' },
    ]);
  });

  it('allow=[] → 全部声明工具被收窄', () => {
    const gaps = computePluginToolGaps(['read_file', 'shell'], [], undefined);
    expect(gaps).toEqual<PluginToolGap[]>([
      { tool: 'read_file', reason: 'not-allowed' },
      { tool: 'shell', reason: 'not-allowed' },
    ]);
  });

  it('deny 命中 → 标记为 denied，且盖过 allow 放行', () => {
    const gaps = computePluginToolGaps(
      ['shell', 'read_file'],
      ['shell', 'read_file'],
      ['shell'],
    );
    expect(gaps).toEqual<PluginToolGap[]>([
      { tool: 'shell', reason: 'denied' },
    ]);
  });

  it('结果与声明工具集合无关，只收被收窄的；多工具按名排序', () => {
    const gaps = computePluginToolGaps(
      ['zeta', 'alpha', 'mids'],
      ['alpha'],
      undefined,
    );
    expect(gaps.map((g) => g.tool)).toEqual(['mids', 'zeta']);
    expect(gaps.every((g) => g.reason === 'not-allowed')).toBe(true);
  });

  it('声明工具为空 → 空数组（没有声明就没有落差）', () => {
    expect(computePluginToolGaps([], ['read_file'], undefined)).toEqual([]);
  });
});
