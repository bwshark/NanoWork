/**
 * 「在目录里打开终端」的命令转义与目录校验。
 *
 * 这里只测**不会真的拉起终端**的那部分：转义规则与失败路径。
 * 成功路径（真开一个 cmd）不适合单测——它会在测试机上弹出窗口。
 *
 * 断言落在"错了也不报错"的地方：
 * 1. `& | < >` 在 cmd 里是命令分隔符，不转义就会让路径后半截被当成另一条命令；
 * 2. `%` 在 cmd 里会展开成变量（`%USERPROFILE%`），双写抵消；
 * 3. `^` 本身是转义符，必须**先**转义它，否则会把后插进去的 `^` 再转义一遍；
 * 4. 目录不存在必须**拒绝**而不是照样开一个终端（终端会落在别处，用户以为在那儿）。
 */

import { describe, expect, it } from 'vitest';
import { escapeForCmd, openTerminalAt } from '../../electron/openTerminal';

describe('escapeForCmd', () => {
  it('转义命令分隔符', () => {
    expect(escapeForCmd('a&b')).toBe('a^&b');
    expect(escapeForCmd('a|b')).toBe('a^|b');
    expect(escapeForCmd('a<b>c')).toBe('a^<b^>c');
  });

  it('百分号双写（cmd 的变量展开）', () => {
    expect(escapeForCmd('%USERPROFILE%')).toBe('%%USERPROFILE%%');
  });

  it('先转义 ^ 本身（否则会把它后面插进去的转义符再转义一遍）', () => {
    expect(escapeForCmd('a^b')).toBe('a^^b');
    expect(escapeForCmd('a^b&c')).toBe('a^^b^&c');
  });

  it('普通路径原样保留', () => {
    expect(escapeForCmd('C:\\Users\\u\\NanoWork')).toBe('C:\\Users\\u\\NanoWork');
  });
});

describe('openTerminalAt 的校验', () => {
  it('目录不存在时拒绝（不弹终端）', async () => {
    const result = await openTerminalAt('C:\\definitely-not-here-123456');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不存在');
  });

  it('空路径拒绝', async () => {
    const result = await openTerminalAt('');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未指定目录');
  });

  it('文件（不是目录）拒绝', async () => {
    const result = await openTerminalAt(__filename);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不是目录');
  });
});
