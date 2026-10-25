import type { ExecutionMode } from './event';

/**
 * 提示词模板外置与身份文件的类型契约（design §13 / §14、FR-4.3）。
 *
 * 约定：本文件只描述数据形状；磁盘读写一律由 `src/lib/prompt/promptLibrary.ts` 与
 * `src/lib/agent/identity.ts` 封装（渲染层不直接碰 `platform.storage` 的 key）。
 */

/** 提示词模板的三个维度（§13.1 矩阵：模式 × 领域 × 风格） */
export type PromptSlotKind = 'mode' | 'domain' | 'style';

/** 领域维度取值（§13.1） */
export type PromptDomain = 'general' | 'code' | 'design';

/** 模式维度的取值复用会话执行模式，避免两套枚举漂移 */
export type PromptMode = ExecutionMode;

/**
 * 一个可外置的提示词槽位。
 *
 * `builtin` 是**打包在源码里的默认正文**，磁盘没有覆盖时用它。这条回退链是
 * 「改提示词不重编译」能成立的前提：没覆盖 = 用内置，覆盖了 = 用覆盖，
 * 删掉覆盖 = 又回内置。
 */
export interface PromptSlot {
  kind: PromptSlotKind;
  /** 槽位 id：mode → ask/plan/craft；domain → general/code/design；style → style-xxx */
  key: string;
  /** 展示名 */
  label: string;
  /** 一句话说明（UI 提示用） */
  description: string;
  /** 内置默认正文 */
  builtin: string;
}

/** 槽位的运行态：磁盘覆盖 + 最终生效正文 */
export interface PromptSlotState {
  slot: PromptSlot;
  /** 磁盘上的覆盖正文；未被覆盖为 null */
  override: string | null;
  /** 实际生效的正文（`override ?? builtin`），已 trim */
  effective: string;
}

/** 身份文件种类（L4，FR-4.3） */
export type IdentityFileKind = 'soul' | 'identity' | 'user' | 'bootstrap';

/** 身份文件的运行态 */
export interface IdentityFileState {
  kind: IdentityFileKind;
  /** 磁盘文件名（如 SOUL.md），即用户可见的名字 */
  filename: string;
  label: string;
  description: string;
  /** 当前正文；未写过为空串 */
  content: string;
  /**
   * 磁盘上是否存在该文件。
   * 与 `content !== ''` **不等价**：空文件（exists=true, content=''）与
   * 从未写过（exists=false）在 UI 上是两种状态，前者是「用户故意清空了」。
   */
  exists: boolean;
}

/** 装配一段注入内容的结果（供装配器与测试共用） */
export interface AssembledSection {
  /** 段落标识，便于测试与调试定位 */
  id:
    | 'agent-persona'
    | 'identity'
    | 'product-identity'
    | 'tone-style'
    | 'mode'
    | 'domain'
    | 'user-instructions'
    | 'memory'
    | 'memory-write'
    | 'knowledge'
    | 'skills'
    | 'local-time';
  content: string;
}
