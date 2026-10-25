/**
 * 模型 preset 的数值档位与引擎默认值。
 *
 * 锁三类**不会报错、只会悄悄错位**的问题：
 *
 * 1. `ENGINE_DEFAULT_*` 与引擎 `config/schema.py::ModelPresetConfig` 的字段默认值漂移
 *    ——用户在界面上点「使用提供商默认值」，我们写下一个引擎并不认为默认的数字，
 *    于是「默认」变成一次静默的覆盖；
 * 2. 档位列表里出现与引擎默认值相同的数——该按钮点完落盘 32768、回读又被归一成
 *    `null`，永远无法保持选中，是个点了没反应的按钮；
 * 3. 回读归一把用户特意设过的值也吞掉——`262144` 必须原样回显。
 *
 * 还有两条 2026-09-21 对话框改版新增的口径：输入框文本 → 数字的解析
 * （`parseTokenLimitInput`，写错必须报错而不是静默当成"使用默认值"），以及
 * 能力声明的缺省值（`ENGINE_DEFAULT_CAPABILITIES`，与引擎字段默认值同源）。
 *
 * 引擎默认值的出处：`nanobot/nanobot/config/schema.py`
 * （`max_tokens: int = 32_768`、`context_window_tokens: int = 200_000`、
 * `supports_tools: bool = True`、`supports_vision: bool = False`、
 * `supports_reasoning: bool = True`、`custom_protocol: bool = False`）。
 */

import { describe, expect, it } from 'vitest';
import {
  CONTEXT_WINDOW_OPTIONS,
  DEFAULT_REASONING_EFFORT,
  ENGINE_DEFAULT_CAPABILITIES,
  ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS,
  ENGINE_DEFAULT_MAX_TOKENS,
  ENGINE_DEFAULT_TEMPERATURE,
  MAX_TOKENS_OPTIONS,
  TOKEN_DEFAULT_LABEL,
  formatTokenLimit,
  normalizeTokenLimit,
  parseTokenLimitInput,
} from '@/lib/model/modelOptions';

describe('引擎默认值常量：必须与 config/schema.py::ModelPresetConfig 逐字一致', () => {
  it('三个默认值', () => {
    expect(ENGINE_DEFAULT_MAX_TOKENS).toBe(32_768);
    expect(ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(200_000);
    expect(ENGINE_DEFAULT_TEMPERATURE).toBe(0.1);
  });

  it('思考档位落在引擎承认的取值里（schema.py 的注释即为全集）', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max', 'adaptive', 'none']).toContain(
      DEFAULT_REASONING_EFFORT,
    );
  });
});

describe('档位列表：不许出现与引擎默认值相同的项', () => {
  it('输出档位不含引擎默认值 32K', () => {
    // 含了就会得到一个「永远无法保持选中」的档位：点它落盘 32768，回读归一成 null，
    // 下次打开显示「使用提供商默认值」——用户以为自己的选择被吞了
    expect(MAX_TOKENS_OPTIONS).not.toContain(ENGINE_DEFAULT_MAX_TOKENS);
  });

  it('上下文档位不含 200000', () => {
    expect(CONTEXT_WINDOW_OPTIONS).not.toContain(ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it('档位各自唯一且递增（重复项会让两个按钮共用同一个选中态）', () => {
    for (const list of [MAX_TOKENS_OPTIONS, CONTEXT_WINDOW_OPTIONS]) {
      expect(new Set(list).size).toBe(list.length);
      expect([...list]).toEqual([...list].sort((a, b) => a - b));
    }
  });

  it('两列共用的只有 64K / 128K 这两个量级（其余不许重复，否则容易串台）', () => {
    const overlap = MAX_TOKENS_OPTIONS.filter((v) =>
      (CONTEXT_WINDOW_OPTIONS as readonly number[]).includes(v),
    );
    // 64K / 128K 在两边都是有意的：窗口与输出是同一个量级上的两件事，
    // 但它们分属不同的 aria 分组（`tokenChips` 按组取），选中态互不影响。
    // 这条断言锁的是「共用的就是这几个已知项」，多出来就说明有人往列表里塞了东西。
    expect(overlap).toEqual([65_536, 131_072]);
  });
});

describe('normalizeTokenLimit: 回读归一', () => {
  it('等于引擎默认值 → null（＝界面上的「使用提供商默认值」）', () => {
    expect(normalizeTokenLimit(200_000, ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS)).toBeNull();
    expect(normalizeTokenLimit(32_768, ENGINE_DEFAULT_MAX_TOKENS)).toBeNull();
  });

  it('用户特意设过的值原样保留', () => {
    expect(normalizeTokenLimit(262_144, ENGINE_DEFAULT_CONTEXT_WINDOW_TOKENS)).toBe(262_144);
    expect(normalizeTokenLimit(65_536, ENGINE_DEFAULT_MAX_TOKENS)).toBe(65_536);
  });

  it('缺字段 / 非数 / 非正数一律折成 null（配置里可能是任何东西）', () => {
    for (const bad of [undefined, null, '16384', 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeTokenLimit(bad, ENGINE_DEFAULT_MAX_TOKENS)).toBeNull();
    }
  });
});

describe('formatTokenLimit: 展示文案', () => {
  it('1024 的整数倍一律写成 K（含用户自己填进去的、非档位的倍数）', () => {
    expect(formatTokenLimit(8_192)).toBe('8K');
    expect(formatTokenLimit(131_072)).toBe('128K');
    expect(formatTokenLimit(262_144)).toBe('256K');
    // 128000 不是常见的档位，但确实是 1024 的整数倍 → 125K 是它准确的名字
    expect(formatTokenLimit(128_000)).toBe('125K');
  });

  it('非整数倍原样带千分位（别把它显示成我们编出来的近似档位）', () => {
    // 200000 / 1024 = 195.3125：显示成「195K」会让人以为值被改过
    expect(formatTokenLimit(200_000)).toBe('200,000');
    expect(formatTokenLimit(100_000)).toBe('100,000');
  });

  it('null 写成「使用提供商默认值」，且与常量同源', () => {
    expect(formatTokenLimit(null)).toBe(TOKEN_DEFAULT_LABEL);
  });
});

describe('parseTokenLimitInput: 输入框文本 → token 数', () => {
  it('空串 = 使用提供商默认值（不是错误）', () => {
    // 占位符写着「使用提供商默认值」，所以空框是在表达「不覆盖」而不是漏填
    expect(parseTokenLimitInput('')).toEqual({ value: null, invalid: false });
    expect(parseTokenLimitInput('   ')).toEqual({ value: null, invalid: false });
  });

  it('纯数字与档位按钮上的写法都认（`128K` / 千分位 / 下划线）', () => {
    expect(parseTokenLimitInput('131072')).toEqual({ value: 131_072, invalid: false });
    // 档位按钮上印的就是 `128K`，照着敲进来却报错是自找的摩擦
    expect(parseTokenLimitInput('128k')).toEqual({ value: 131_072, invalid: false });
    expect(parseTokenLimitInput('128K')).toEqual({ value: 131_072, invalid: false });
    expect(parseTokenLimitInput('1M')).toEqual({ value: 1_048_576, invalid: false });
    expect(parseTokenLimitInput(' 262,144 ')).toEqual({ value: 262_144, invalid: false });
    expect(parseTokenLimitInput('200_000')).toEqual({ value: 200_000, invalid: false });
  });

  it('写错的东西报 invalid，**不**静默当成「使用默认值」', () => {
    // 静默吞掉用户的输入比报错严重得多：他会以为 12x 被记住了
    for (const bad of ['12x', 'K', '128KK', '-5', '0', '1.5K']) {
      expect(parseTokenLimitInput(bad).invalid, `${bad} 应判为非法`).toBe(true);
    }
  });

  it('往返：每个档位按钮的文案都能解析回它自己（按钮与框共用一个读数）', () => {
    for (const option of [...MAX_TOKENS_OPTIONS, ...CONTEXT_WINDOW_OPTIONS]) {
      expect(parseTokenLimitInput(formatTokenLimit(option))).toEqual({
        value: option,
        invalid: false,
      });
    }
  });
});

describe('ENGINE_DEFAULT_CAPABILITIES: 与引擎字段默认值同源', () => {
  it('默认值逐项与引擎同源（schema.py::ModelPresetConfig）', () => {
    // ⚠️ 两个方向相反是**有意**的，别「统一」成同一个：
    // `supportsTools` / `supportsReasoning` 默认 true —— 客户端拿它们做硬门禁
    // （技能挂载、注入思考强度），默认保守会把所有历史预设一升级就禁掉；
    // `supportsVision` 默认 false —— 正因如此视觉能力只做提醒、不做门禁
    // （否则同样是一升级就禁掉所有人的贴图功能）。
    expect(ENGINE_DEFAULT_CAPABILITIES).toEqual({
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: true,
      customProtocol: false,
    });
  });
});
