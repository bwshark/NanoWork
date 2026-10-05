/**
 * 写策略（FR-8.4）在 config.json 里的读写转换。
 *
 * 锁的是两类**不会报错、只会静默改坏配置**的错误：
 *
 * 1. **整体替换 `tools` 段**：那会把 MCP 服务器（`tools.mcpServers`）、沙箱开关、
 *    SSRF 白名单一起吞掉。界面上只剩「MCP 服务器列表空了」，没有任何报错，
 *    而这件事是**已经发生过**的（主进程早期就是整段替换 mcpServers 的写法）。
 * 2. **幂等比错字段**：拿整份配置做「有没有变化」的判定，任何外部改动
 *    （用户在别处改了 MCP）都会被算成「本次有变更」，于是「再点一次保存」
 *    永远报「已修改」，而实际上什么都没写盘。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DENY_WRITE,
  DENY_WRITE_KEY,
  DENY_WRITE_KEY_SNAKE,
  fileToolsSignature,
  mergeDefaultDenyWrite,
  parseFileToolsPolicy,
} from '../../electron/toolsPolicyConfig';

/** 一份「像真的」配置：tools 段里既有 file 也有别人在维护的键 */
function sampleConfig(): Record<string, unknown> {
  return {
    agents: { defaults: { modelPreset: 'deepseek' } },
    tools: {
      restrictToWorkspace: true,
      ssrfWhitelist: ['example.com'],
      mcpServers: { github: { command: 'npx', args: ['-y', '@mcp/github'] } },
      file: { enable: true },
    },
  };
}

describe('parseFileToolsPolicy：tools 段 → 写策略', () => {
  it('段存在但没有这个键 → 引擎默认（关闭）且 supported', () => {
    expect(parseFileToolsPolicy(sampleConfig().tools)).toEqual({
      defaultDenyWrite: DEFAULT_DENY_WRITE,
      supported: true,
    });
  });

  it('camelCase 与 snake_case 都认（引擎 Base 两种都收）', () => {
    for (const key of ['defaultDenyWrite', 'default_deny_write']) {
      expect(
        parseFileToolsPolicy({ file: { enable: true, [key]: true } }),
      ).toEqual({ defaultDenyWrite: true, supported: true });
    }
  });

  it('显式 false 与「键没写」都算 supported（前者是关，后者是引擎默认关）', () => {
    expect(parseFileToolsPolicy({ file: { [DENY_WRITE_KEY]: false } })).toEqual({
      defaultDenyWrite: false,
      supported: true,
    });
    expect(parseFileToolsPolicy({ file: { enable: true } })).toEqual({
      defaultDenyWrite: DEFAULT_DENY_WRITE,
      supported: true,
    });
  });

  it('段缺失 / 段在但值非布尔 → null，不猜默认值顶上去', () => {
    expect(parseFileToolsPolicy(undefined)).toBeNull();
    expect(parseFileToolsPolicy({})).toBeNull();
    expect(parseFileToolsPolicy({ file: { [DENY_WRITE_KEY]: 'true' } })).toBeNull();
    expect(parseFileToolsPolicy({ file: { [DENY_WRITE_KEY]: 'true' } })).toBeNull();
    expect(parseFileToolsPolicy({ file: { [DENY_WRITE_KEY]: 1 } })).toBeNull();
    expect(parseFileToolsPolicy('not-an-object')).toBeNull();
  });
});

describe('mergeDefaultDenyWrite：只动 tools.file 那一个键', () => {
  it('保留 mcpServers / restrictToWorkspace / ssrfWhitelist（整体替换会吞掉它们）', () => {
    const { data, changed } = mergeDefaultDenyWrite(sampleConfig(), true);
    expect(changed).toBe(true);
    const tools = (data.tools ?? {}) as Record<string, unknown>;
    expect(tools.mcpServers).toEqual({
      github: { command: 'npx', args: ['-y', '@mcp/github'] },
    });
    expect(tools.restrictToWorkspace).toBe(true);
    expect(tools.ssrfWhitelist).toEqual(['example.com']);
    // file 段里原有的 enable 也要留着
    expect((tools.file ?? {}) as Record<string, unknown>).toEqual({
      enable: true,
      defaultDenyWrite: true,
    });
  });

  it('不动其它顶层段（agents.defaults 等原样带过去）', () => {
    const { data } = mergeDefaultDenyWrite(sampleConfig(), true);
    expect(data.agents).toEqual({ defaults: { modelPreset: 'deepseek' } });
  });

  it('tools 段整个不存在 → 补一棵只带这一个字段的空壳段，而不是放弃', () => {
    const { data } = mergeDefaultDenyWrite({ providers: { p: {} } }, true);
    expect(data.tools).toEqual({ file: { defaultDenyWrite: true } });
    expect(data.providers).toEqual({ p: {} });
  });

  it('整份 data 不是对象 → 拒绝合并（fail-closed，绝不把原样数据写回盘）', () => {
    expect(mergeDefaultDenyWrite('nope' as unknown as Record<string, unknown>, true)).toEqual({
      data: 'nope',
      changed: false,
    });
  });

  it('往返：写进去的值能被 parse 回来', () => {
    const { data } = mergeDefaultDenyWrite(sampleConfig(), true);
    expect(parseFileToolsPolicy(data.tools)).toEqual({
      defaultDenyWrite: true,
      supported: true,
    });
  });
});

describe('fileToolsSignature：幂等比对只看 tools.file', () => {
  it('值相同 → 签名相同（点两次保存不会第二次报「已变更」）', () => {
    const a = mergeDefaultDenyWrite(sampleConfig(), true).data;
    const b = mergeDefaultDenyWrite(sampleConfig(), true).data;
    expect(fileToolsSignature(a)).toBe(fileToolsSignature(b));
  });

  it('tools.file 段缺失时签名也稳定（不会每次都判成「有变更」）', () => {
    const a = fileToolsSignature({ tools: {} });
    const b = fileToolsSignature({ tools: { file: { enable: true } } });
    expect(a).toBe(b);
  });

  it('外部改动（mcpServers 变了）不算「本次有变更」', () => {
    const before = sampleConfig();
    const after = mergeDefaultDenyWrite(sampleConfig(), true).data;
    (after.tools as Record<string, unknown>).mcpServers = { other: {} };
    expect(fileToolsSignature(before)).not.toBe(fileToolsSignature(after));
  });
});
