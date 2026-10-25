import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_LENGTH,
  detectTrigger,
  type TriggerState,
} from '@/lib/editor/composerTrigger';

/**
 * Composer 触发符（`/` 与 `@`）边界判定的表驱动用例。
 *
 * 这张表是「输入 URL 时误弹斜杠浮层」这个 Bug 的回归防线：
 * 斜杠在 URL / 路径 / and-or 里都是常规字符，边界必须收得比 @ 更紧；
 * 而 @ 要照顾中文语境下的「看一下@报表」，不能一并收紧。
 */

/** 一行用例：给定文本与光标，断言判定结果 */
interface Case {
  /** 用例说明（失败时直接能看到场景） */
  name: string;
  /** 输入框文本 */
  value: string;
  /** 光标位置；省略则取文本末尾（最常见的「正在输入」状态） */
  caret?: number;
  /** 期望结果：null 表示不触发 */
  expected: TriggerState | null;
}

/** 便捷构造：期望触发 */
function trigger(
  type: TriggerState['type'],
  index: number,
  query: string,
): TriggerState {
  return { type, index, query };
}

/** —— 不触发表：URL / 路径 / 邮箱 / and-or 等常规文本 —— */
const NOT_TRIGGERED: Case[] = [
  {
    // 本 Bug 的原型：第二个斜杠前是斜杠，曾因「非词内字符即触发」被判为 slash
    name: 'URL 完整 https://example.com',
    value: 'https://example.com',
    expected: null,
  },
  {
    // 过滤词 e 会命中内置指令 /clear，是最容易被误弹的一种输入瞬间
    name: 'URL 输入到 https://e（曾误弹 /clear）',
    value: 'https://e',
    expected: null,
  },
  { name: 'URL 输入到 https:/', value: 'https:/', expected: null },
  {
    name: 'URL 带端口 http://127.0.0.1:8900',
    value: 'http://127.0.0.1:8900',
    expected: null,
  },
  {
    name: 'URL 后接空格再输入',
    value: '见 https://example.com 说',
    expected: null,
  },
  { name: '文件路径 src/app.ts', value: 'src/app.ts', expected: null },
  { name: '深层路径 a/b/c.txt', value: 'a/b/c.txt', expected: null },
  { name: 'and/or 连词', value: 'and/or', expected: null },
  { name: '邮箱 a@b.com', value: 'a@b.com', expected: null },
  { name: '邮箱 user@example', value: 'user@example', expected: null },
  { name: '变量名 handle@click', value: 'handle@click', expected: null },
  { name: '中文后紧跟 /（/ 边界收紧后不再触发）', value: '看一下/报表', expected: null },
  { name: '纯文本无触发符', value: '今天天气不错', expected: null },
  { name: '空输入', value: '', caret: 0, expected: null },
  { name: '触发词中出现空格（已断开）', value: '/my cmd', expected: null },
  { name: '@ 后接空格（已断开）', value: '@报表 请', expected: null },
  { name: '触发符前是字母数字', value: 'abc/x', expected: null },
];

/** —— 触发表：行首 / 空白 / 换行 / 中文边界 —— */
const TRIGGERED: Case[] = [
  { name: '行首 /', value: '/', caret: 1, expected: trigger('slash', 0, '') },
  { name: '行首 /c', value: '/c', caret: 2, expected: trigger('slash', 0, 'c') },
  {
    name: '行首 /compact',
    value: '/compact',
    caret: 8,
    expected: trigger('slash', 0, 'compact'),
  },
  { name: '空格后 /x', value: '你好 /x', caret: 5, expected: trigger('slash', 3, 'x') },
  { name: '换行后 /x', value: '你好\n/x', caret: 5, expected: trigger('slash', 3, 'x') },
  {
    // 前一个斜杠（and/or 里的）被判否后要继续往前找，不能整体放弃
    name: 'and/or 之后的 /clear 仍可触发',
    value: 'and/or /clear',
    caret: 13,
    expected: trigger('slash', 7, 'clear'),
  },
  { name: '行首 @', value: '@', caret: 1, expected: trigger('at', 0, '') },
  {
    name: '中文后 @报表',
    value: '看一下@报表',
    caret: 6,
    expected: trigger('at', 3, '报表'),
  },
  {
    name: '中文后 @ 未输入过滤词',
    value: '看一下@',
    caret: 4,
    expected: trigger('at', 3, ''),
  },
  {
    name: '行首 @报表',
    value: '@报表',
    caret: 3,
    expected: trigger('at', 0, '报表'),
  },
  { name: '空格后 @x', value: '你好 @x', caret: 5, expected: trigger('at', 3, 'x') },
  { name: '换行后 @x', value: '你好\n@x', caret: 5, expected: trigger('at', 3, 'x') },
  {
    // @ 的边界比 / 宽松：标点之后也算，这是刻意保留的差异
    name: '全角括号后 @x（@ 比 / 宽松）',
    value: '见（@x',
    caret: 4,
    expected: trigger('at', 2, 'x'),
  },
  {
    name: '光标不在末尾：只取光标前的过滤词',
    value: '请 /comp 后面还有字',
    caret: 7,
    expected: trigger('slash', 2, 'comp'),
  },
];

describe('detectTrigger 边界判定', () => {
  it.each(NOT_TRIGGERED)('不触发：$name', ({ value, caret, expected }) => {
    expect(detectTrigger(value, caret ?? value.length)).toEqual(expected);
  });

  it.each(TRIGGERED)('触发：$name', ({ value, caret, expected }) => {
    expect(detectTrigger(value, caret ?? value.length)).toEqual(expected);
  });
});

describe('detectTrigger 通用规则', () => {
  it('过滤词恰好等于 MAX_QUERY_LENGTH 时仍触发', () => {
    const query = 'a'.repeat(MAX_QUERY_LENGTH);
    expect(detectTrigger(`/${query}`, query.length + 1)).toEqual(
      trigger('slash', 0, query),
    );
  });

  it('过滤词超过 MAX_QUERY_LENGTH 时放弃', () => {
    const query = `${'a'.repeat(MAX_QUERY_LENGTH)}b`;
    expect(detectTrigger(`/${query}`, query.length + 1)).toBeNull();
  });

  it('MAX_QUERY_LENGTH 为 40', () => {
    expect(MAX_QUERY_LENGTH).toBe(40);
  });

  it('光标落在触发符之前时不触发', () => {
    // 光标在 @ 左侧，右侧的 @abc 不属于「正在输入」的触发
    expect(detectTrigger('@abc', 0)).toBeNull();
  });

  it('多个触发符时取离光标最近的那个', () => {
    expect(detectTrigger('/a @b', 5)).toEqual(trigger('at', 3, 'b'));
  });

  it('URL 判否后，其后的空格 + /clear 仍可触发', () => {
    expect(detectTrigger('https://example.com /clear', 26)).toEqual(
      trigger('slash', 20, 'clear'),
    );
  });

  it('制表符与回车视为空白边界', () => {
    expect(detectTrigger('a\t/x', 4)).toEqual(trigger('slash', 2, 'x'));
    expect(detectTrigger('a\r/x', 4)).toEqual(trigger('slash', 2, 'x'));
  });

  it('触发词中遇到换行立即中断', () => {
    expect(detectTrigger('/ab\ncd', 6)).toBeNull();
  });
});
