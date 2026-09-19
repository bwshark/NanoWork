/**
 * 工作空间展示名的解析。
 *
 * 这里锁的是同一件事的两种名字：**默认工作空间**是一个语义分组（内容是设置里那个
 * 默认路径下的任务），它显示「默认工作空间」；其余目录显示自己的名字。判定「是不是
 * 默认工作空间」不能拿字符串直接比——会话里的 `workdir` 是当时用户/目录选择器给的
 * 原始串，默认路径是主进程 `path.join` 拼出来的，两者常差一个大小写或一条尾部分隔符。
 * 比错的表现不是报错，而是侧边栏并排冒出两个组：一个「默认工作空间」、一个
 * 「NanoWork」，指向同一个地方。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LABEL,
  dirBasename,
  isSameWorkspacePath,
  resolveWorkspaceLabel,
} from '@/lib/workspaceLabel';

const DEFAULT_DIR = 'C:\\Users\\tester\\NanoWork';
const OTHER_DIR = 'D:\\work\\ranch';

describe('dirBasename', () => {
  it('取末级目录名，容忍尾部分隔符与两种分隔符', () => {
    expect(dirBasename('D:\\work\\ranch')).toBe('ranch');
    expect(dirBasename('D:\\work\\ranch\\')).toBe('ranch');
    expect(dirBasename('/home/me/ranch')).toBe('ranch');
    expect(dirBasename('D:\\work\\ranch\\\\')).toBe('ranch');
  });
});

describe('isSameWorkspacePath', () => {
  it('完全相同的路径为真；忽略尾部分隔符与分隔符形态', () => {
    expect(isSameWorkspacePath(DEFAULT_DIR, DEFAULT_DIR)).toBe(true);
    expect(isSameWorkspacePath(`${DEFAULT_DIR}\\`, DEFAULT_DIR)).toBe(true);
    expect(isSameWorkspacePath('D:/work/ranch', 'D:\\work\\ranch')).toBe(true);
  });

  it('Windows 盘符路径大小写不敏感，POSIX 路径敏感', () => {
    expect(isSameWorkspacePath('c:\\users\\tester\\nanowork', DEFAULT_DIR)).toBe(true);
    // POSIX 上 `Me` 与 `me` 是两个目录，不能一律折成小写
    expect(isSameWorkspacePath('/home/Me/ranch', '/home/me/ranch')).toBe(false);
  });

  it('任一侧为空一律为假：undefined 的语义是「未指定」，不是空目录', () => {
    expect(isSameWorkspacePath(undefined, DEFAULT_DIR)).toBe(false);
    expect(isSameWorkspacePath(DEFAULT_DIR, undefined)).toBe(false);
    expect(isSameWorkspacePath(undefined, undefined)).toBe(false);
    expect(isSameWorkspacePath('', DEFAULT_DIR)).toBe(false);
  });
});

describe('resolveWorkspaceLabel', () => {
  it('落在默认工作空间上的一律显示「默认工作空间」', () => {
    expect(resolveWorkspaceLabel(DEFAULT_DIR, undefined, DEFAULT_DIR)).toBe(
      DEFAULT_WORKSPACE_LABEL,
    );
    // 大小写不同、尾部分隔符不同，也算落在默认工作空间上
    expect(resolveWorkspaceLabel(`${DEFAULT_DIR}\\`, undefined, DEFAULT_DIR)).toBe(
      DEFAULT_WORKSPACE_LABEL,
    );
  });

  it('别名让位给默认工作空间：这个分组不参与重命名', () => {
    // 若别名压过默认名，用户改一个设置就会让分组名在「别名」与「默认名」之间漂移，
    // 而默认分组没有重命名入口，那条别名也就永远没有入口去维护
    const aliases = { [DEFAULT_DIR]: '我的项目' };
    expect(resolveWorkspaceLabel(DEFAULT_DIR, aliases, DEFAULT_DIR)).toBe(
      DEFAULT_WORKSPACE_LABEL,
    );
  });

  it('普通目录：别名优先，未设别名取末级目录名', () => {
    expect(resolveWorkspaceLabel(OTHER_DIR, undefined, DEFAULT_DIR)).toBe('ranch');
    expect(
      resolveWorkspaceLabel(OTHER_DIR, { [OTHER_DIR]: '牧场项目' }, DEFAULT_DIR),
    ).toBe('牧场项目');
  });

  it('不知道默认路径时退化为旧行为（只认别名与末级目录名）', () => {
    // 存储信息未取到（Web 端 / 启动第一帧）时走这条，不编造「默认工作空间」这个名字
    expect(resolveWorkspaceLabel(DEFAULT_DIR, undefined)).toBe('NanoWork');
  });
});
