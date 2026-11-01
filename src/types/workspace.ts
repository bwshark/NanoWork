/**
 * 右侧边栏「工作空间 / 变更」两个标签页的数据契约（主进程与渲染层**共用**）。
 *
 * 抽成独立文件而不各写一份的理由与 `src/types/extension.ts` 一致：这些形状是
 * 跨进程的同一个事实。两边各声明一遍，改字段时必然漏掉一侧，症状是
 * 「界面能渲染、主进程字段名对不上」——最难查的那类。
 *
 * 纯类型文件（无运行期 import），因此 main 进程可以相对路径 import 它而不用担心
 * 打包期的别名解析（见 electron 侧 import 约定）。
 */

/** 文件树里的一项 */
export interface WorkspaceEntry {
  /** 文件 / 目录名（不含父路径） */
  name: string;
  /** 是否目录（决定点它是展开还是预览） */
  dir: boolean;
  /** 字节数；目录恒为 undefined */
  size?: number;
}

/** 列目录的结果 */
export interface WorkspaceListResult {
  ok: boolean;
  entries: WorkspaceEntry[];
  /** 条目数超过上限被截断（界面上要如实说出来，否则用户以为目录只有这些） */
  truncated?: boolean;
  error?: string;
}

/** 只读读取一个文本文件的结果 */
export interface WorkspaceReadResult {
  ok: boolean;
  content?: string;
  /** 实际字节数（可能大于 content 的字节数：超大文件被截断） */
  size?: number;
  /** 命中二进制特征（前 8KB 有 NUL）：界面应改为「无法预览」而不是画一堆方块 */
  binary?: boolean;
  /** 内容超过上限被截断 */
  truncated?: boolean;
  error?: string;
}

/**
 * 一条改动。
 *
 * `status` 刻意是归一后的枚举而不是 git 的 `XY` 两字母：界面要画的是
 * 「新增 / 修改 / 删除」三种色块，直接把 `MR`、`AM`、`??` 这些组合态漏给
 * 渲染层，等于让它再实现一遍 git 的状态模型。
 */
export type GitFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

/** 一个被改动的文件（含与 HEAD 相比的增删行数） */
export interface GitFileChange {
  /** 相对工作目录的路径 */
  path: string;
  status: GitFileStatus;
  /** 新增行数（二进制 / 未跟踪未知时为 0） */
  added: number;
  /** 删除行数 */
  removed: number;
}

/** 工作区改动列表 */
export interface GitStatusResult {
  ok: boolean;
  /** 是否是一个 git 工作区（false 时 files 恒空，界面显示「不是 git 仓库」） */
  isRepo: boolean;
  files: GitFileChange[];
  /** 汇总（表头「文件变更 +N -M」用） */
  added: number;
  removed: number;
  error?: string;
}

/** 单个文件的 unified diff */
export interface GitDiffResult {
  ok: boolean;
  /** 原始 patch 文本（渲染层负责画行颜色；主进程不解析 hunk） */
  patch: string;
  error?: string;
}

/** 创建一个终端会话的结果 */
export interface PtyCreateResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** 终端输出（按 id 区分会话） */
export interface PtyDataEvent {
  id: string;
  data: string;
}

/** 终端退出 */
export interface PtyExitEvent {
  id: string;
  code: number;
}
