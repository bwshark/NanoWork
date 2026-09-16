/**
 * 工作区文件记忆（MEMORY.md）类型契约。
 * 对应设计文档 docs/architecture-memory.md §3.1。
 * 注意：这里只描述数据形状，跨端读写一律由 src/lib/memory.ts 的 MemoryService 封装。
 */

/** 单条记忆块的轻量元信息（仅用于计数/展示，不强制持久化） */
export interface MemoryMeta {
  /** 估算条数（按二级标题或空行切分） */
  entries: number;
  /** 字符长度 */
  chars: number;
  /** 最后写入 ISO 时间（从文件内容最后时间戳推断，无则 null） */
  lastWrittenAt: string | null;
}

/** 记忆注入运行时状态（存于 sessionsStore，不持久化） */
export interface MemoryState {
  /** 当前会话是否注入了记忆 */
  injected: boolean;
  /** 注入的记忆条数 */
  count: number;
  /** 用户是否临时关闭了提示条 */
  dismissed: boolean;
}

/**
 * 记忆作用域（design §14.1 四层里的 L2 / L3）。
 *
 * - `user`：用户级长期记忆，落 `~/.nanowork/MEMORY.md`（跨项目生效，L2）；
 *   按 FR-4.2「用户显式要求才写」——**只有用户在记忆页亲手写**才会落盘，
 *   会话结束的自动沉淀不走这一层。
 * - `workspace`：工作区长期记忆，落 `~/.nanowork/memory/<workspaceKey>.md`（L3）。
 */
export type MemoryScope = 'user' | 'workspace';

/** 某个作用域的记忆概览（记忆页的作用域切换用） */
export interface MemoryScopeSummary {
  scope: MemoryScope;
  label: string;
  description: string;
  chars: number;
  entries: number;
  lastWrittenAt: string | null;
}

/** 记忆写入选项 */
export interface MemoryAppendOptions {
  /** 引用源（如会话标题/消息片段），用于生成引用块 */
  source?: string;
  /** 显式时间戳，默认 now */
  at?: string;
}
