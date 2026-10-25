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
import type { NanobotPathRule } from '@/platform/types';
import {
  DEFAULT_DENY_WRITE,
  DENY_WRITE_KEY,
  DENY_WRITE_KEY_SNAKE,
  fileToolsSignature,
  mergeDefaultDenyWrite,
  mergePathRules,
  parseFileToolsPolicy,
  parsePathRules,
} from '../../electron/toolsPolicyConfig';

/** 规则字面量的类型助手：不标的话 TS 把 `{write: 'deny'}` 推断成 `{write: string}` */
function rule(path: string, action: Record<string, 'allow' | 'deny'>): NanobotPathRule {
  return { path, action } as NanobotPathRule;
}

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

describe('FR-8.4 默认值：必须与引擎 schema 逐字一致', () => {
  /**
   * 2026-10-21 收口：引擎 `FileToolsConfig.default_deny_write` 从 `False` 改成
   * `True`（PRD §11.2「白名单制：不配即从严」）。
   *
   * 这个用例存在的理由是：常量在**两侧**各有一份（客户端 `src/lib/core/constants.ts`
   * 与引擎 `nanobot/agent/tools/filesystem.py`），两边不一致时界面显示的开关
   * 状态会与引擎的实际行为分叉——而分叉的表现是「界面说开着、引擎却在放行」，
   * **全程零报错**，靠任何运行期观察都发现不了。
   *
   * 所以这里显式钉住 `true`。改引擎默认值时**必须**同时改这里并同步更新 PRD。
   */
  it('DEFAULT_DENY_WRITE 必须是 true（不配即从严）', () => {
    expect(DEFAULT_DENY_WRITE).toBe(true);
  });

  it('「键没写」时回落到 true 而不是 false', () => {
    // 回落成 false 的症状：界面显示「关闭」，而引擎实际在拒绝写入——分叉且零报错
    const parsed = parseFileToolsPolicy({ file: { enable: true } });
    expect(parsed?.defaultDenyWrite).toBe(true);
  });
});

describe('parseFileToolsPolicy：tools 段 → 写策略', () => {
  it('段存在但没有这个键 → 引擎默认（开启）且 supported', () => {
    expect(parseFileToolsPolicy(sampleConfig().tools)).toEqual({
      defaultDenyWrite: DEFAULT_DENY_WRITE,
      supported: true,
      // FR-8.13：规则缺省就是空数组（引擎默认值）。快照**总是**带着这个字段，
      // 界面才不必区分「没配规则」与「配置里没这个键」——两者语义相同。
      pathRules: [],
    });
  });

  it('camelCase 与 snake_case 都认（引擎 Base 两种都收）', () => {
    for (const key of ['defaultDenyWrite', 'default_deny_write']) {
      expect(
        parseFileToolsPolicy({ file: { enable: true, [key]: true } }),
      ).toEqual({ defaultDenyWrite: true, supported: true, pathRules: [] });
    }
  });

  it('显式 false 与「键没写」都算 supported（前者是关，后者是引擎默认开）', () => {
    expect(parseFileToolsPolicy({ file: { [DENY_WRITE_KEY]: false } })).toEqual({
      defaultDenyWrite: false,
      supported: true,
      pathRules: [],
    });
    expect(parseFileToolsPolicy({ file: { enable: true } })).toEqual({
      defaultDenyWrite: DEFAULT_DENY_WRITE,
      supported: true,
      pathRules: [],
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
      pathRules: [],
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

/**
 * 路径规则（FR-8.13）在 config.json 里的读写转换。
 *
 * 盯的是同一类「不会报错、只会静默改坏配置」的错，只是换了个形状：
 * 规则是**数组**，所以「整体替换 `tools` 段」会连别人的键一起吞掉，而
 * 「幂等比错字段」会让「删掉一条规则再保存」被判成「没有变更」—— 用户看到的是
 * 「保存成功」，磁盘上那条规则还在。
 */
describe('parsePathRules：tools.file.pathRules → 规则表', () => {
  it('camel 与 snake 两种键都由 parseFileToolsPolicy 认（parsePathRules 只接数组）', () => {
    for (const key of ['pathRules', 'path_rules']) {
      expect(
        parseFileToolsPolicy({ file: { [key]: [{ path: '/a', action: { write: 'deny' } }] } })
          ?.pathRules,
      ).toEqual([{ path: '/a', action: { write: 'deny' } }]);
    }
    expect(parsePathRules([{ path: '/a', action: { write: 'deny' } }])).toEqual([
      { path: '/a', action: { write: 'deny' } },
    ]);
  });

  it('坏条目丢掉、其余照常（一条写错不该让整张表消失）', () => {
    expect(
      parsePathRules([
        { path: '/a', action: { write: 'deny' } },
        { action: { read: 'deny' } },
        { path: '   ', action: { read: 'deny' } },
        { path: '/b', action: { read: 'dney' } },
        { path: '/c', action: { chmod: 'deny' } },
        { path: '/d', action: {} },
        'not-an-object',
      ]),
    ).toEqual([{ path: '/a', action: { write: 'deny' } }]);
  });

  it('不是数组 → 空表（不是抛错）', () => {
    expect(parsePathRules(undefined)).toEqual([]);
    expect(parsePathRules('nope')).toEqual([]);
    expect(parsePathRules({ path: '/a' })).toEqual([]);
  });

  it('解析出的形状与界面 / 引擎同构（三种动作各自独立）', () => {
    const [rule] = parsePathRules([
      { path: '/a', action: { read: 'deny', write: 'allow', delete: 'deny' } },
    ]);
    expect(Object.keys(rule.action).sort()).toEqual(['delete', 'read', 'write']);
  });
});

describe('mergePathRules：只动 tools.file.pathRules', () => {
  it('保留 mcpServers / defaultDenyWrite / 其它 file 键', () => {
    const base = sampleConfig();
    (base.tools as Record<string, unknown>).file = {
      enable: true,
      defaultDenyWrite: true,
      safeDeleteReportPath: 'x',
    };
    const { data, changed } = mergePathRules(base, [
      { path: '/a', action: { write: 'deny' } },
    ]);
    expect(changed).toBe(true);
    const file = (data.tools as Record<string, unknown>).file as Record<string, unknown>;
    expect(file.defaultDenyWrite).toBe(true);
    expect(file.safeDeleteReportPath).toBe('x');
    expect(file.pathRules).toEqual([{ path: '/a', action: { write: 'deny' } }]);
    expect((data.tools as Record<string, unknown>).mcpServers).toBeDefined();
    expect(data.agents).toEqual(base.agents);
  });

  it('动作键序固定（read / write / delete），同一份规则两次保存 diff 为空', () => {
    const rules = [rule('/a', { delete: 'deny', read: 'allow', write: 'deny' })];
    const first = mergePathRules(sampleConfig(), [...rules]).data;
    const second = mergePathRules(sampleConfig(), [...rules]).data;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('空数组 = 清空所有规则（整表替换语义）', () => {
    const base = mergePathRules(sampleConfig(), [rule('/a', { write: 'deny' })]).data;
    const { data } = mergePathRules(base, []);
    expect(((data.tools as Record<string, unknown>).file as Record<string, unknown>).pathRules).toEqual([]);
  });

  it('整份 data 不是对象 → 拒绝合并（fail-closed）', () => {
    // 运行期会拿到手写坏的配置（`tools` 被写成字符串），所以这条形状是真实输入
    expect(mergePathRules('nope' as unknown as Record<string, unknown>, []).changed).toBe(false);
  });

  it('往返：写进去的规则能被 parse 回来', () => {
    const rules = [
      rule('/a', { write: 'deny' }),
      rule('/b', { read: 'allow', delete: 'deny' }),
    ];
    const { data } = mergePathRules(sampleConfig(), rules);
    expect(parsePathRules(((data.tools as Record<string, unknown>).file as Record<string, unknown>).pathRules)).toEqual(rules);
  });
});

describe('fileToolsSignature：规则也进幂等签名', () => {
  it('⭐ 删掉一条规则 → 签名必须变（否则保存被判成「没有变更」而不写盘）', () => {
    const before = mergePathRules(sampleConfig(), [
      rule('/a', { write: 'deny' }),
      rule('/b', { read: 'deny' }),
    ]).data;
    const after = mergePathRules(before, [rule('/a', { write: 'deny' })]).data;
    expect(fileToolsSignature(before)).not.toBe(fileToolsSignature(after));
  });

  it('同一份规则 → 签名相同（点两次保存不会第二次报「已修改」）', () => {
    const rules = [rule('/a', { write: 'deny' })];
    expect(fileToolsSignature(mergePathRules(sampleConfig(), rules).data)).toBe(
      fileToolsSignature(mergePathRules(sampleConfig(), rules).data),
    );
  });

  it('规则的书写顺序不影响签名（换顺序不该触发多余的重启）', () => {
    const a = mergePathRules(sampleConfig(), [
      rule('/a', { write: 'deny' }),
      rule('/b', { read: 'deny' }),
    ]).data;
    const b = mergePathRules(sampleConfig(), [
      rule('/b', { read: 'deny' }),
      rule('/a', { write: 'deny' }),
    ]).data;
    expect(fileToolsSignature(a)).toBe(fileToolsSignature(b));
  });

  it('外部改动（mcpServers 变了）仍然不算「本次有变更」', () => {
    // 两份都必须带**同一批**规则：否则差异来自规则本身，断言就偏了
    const rules = [rule('/a', { write: 'deny' })];
    const before = mergePathRules(sampleConfig(), rules).data;
    const after = mergePathRules(sampleConfig(), rules).data;
    (after.tools as Record<string, unknown>).mcpServers = { other: {} };
    expect(fileToolsSignature(before)).toBe(fileToolsSignature(after));
  });
});
