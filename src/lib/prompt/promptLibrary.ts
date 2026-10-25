import { platform } from '@/platform';
import { PROMPT_KEY_PREFIX } from '@/lib/core/constants';
import { PROMPT_SLOTS, findSlot, slotsOfKind } from '@/lib/prompt/promptCatalog';
import type { PromptSlot, PromptSlotKind, PromptSlotState } from '@/types';

/**
 * 提示词模板库（design §13.4：改提示词不需要重新编译前端）。
 *
 * ## 为什么是「同步快照 + 显式刷新」
 *
 * 装配提示词发生在 `sessionsStore.streamAssistantReply`，而那条路径有一条硬性质：
 * **`send()` 必须同步进入流式态**（见该函数里关于记忆快照的注释）。在那里 `await`
 * 任何存储 IO 都会让出一个 microtask，破坏这条性质并有测试钉住。
 *
 * 所以本模块分两半：
 *
 * - **读盘**走 `loadAll()`（异步，显式调用：应用启动 / 打开提示词设置页 / 保存后）；
 * - **取用**走 `resolveSync()`（同步，读内存快照，未加载时**回退内置默认**）。
 *
 * 即便从未 `loadAll()`，`resolveSync` 也返回内置正文——这是「出厂默认可用」的保证，
 * 不能让存储异常把提示词变成空串。
 *
 * ## 覆盖语义
 *
 * `覆盖存在且非空` → 用覆盖；`无覆盖 / 覆盖为空` → 用内置。因此「恢复默认」=
 * 删掉磁盘文件（`reset`），而不是写一份空文件——后者会让磁盘上留下一个看起来
 * 像「用户自定义过」的文件。
 */
class PromptLibraryImpl {
  /** 内存快照：`<kind>.<key>` → 覆盖正文（只存非空缺省值） */
  private overrides = new Map<string, string>();

  /** 是否已完成过一次读盘（仅供 UI 区分「空」与「还没读」） */
  private loaded = false;

  private static idOf(kind: PromptSlotKind, key: string): string {
    return `${kind}.${key}`;
  }

  /**
   * storage key：`nanowork.prompt.<kind>.<key>`
   * → 由主进程路由到 `~/.nanowork/prompts/<kind>/<key>.md`（见 electron/storageRoutes.ts）
   */
  storageKeyOf(kind: PromptSlotKind, key: string): string {
    return `${PROMPT_KEY_PREFIX}${kind}.${key}`;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * 从磁盘读入全部槽位覆盖，刷新内存快照。
   *
   * 单个槽位读取失败不影响其余槽位（`try/catch` 收敛为「无覆盖」）：提示词库
   * 是增强能力，任何一项坏掉都不该让会话发不出去。
   */
  async loadAll(): Promise<void> {
    const results = await Promise.all(
      PROMPT_SLOTS.map(async (slot): Promise<[PromptSlot, string]> => {
        try {
          const raw = await platform.storage.get<string>(
            PromptLibrary.storageKeyOf(slot.kind, slot.key),
          );
          return [slot, typeof raw === 'string' ? raw.trim() : ''];
        } catch {
          return [slot, ''];
        }
      }),
    );

    this.overrides.clear();
    for (const [slot, text] of results) {
      if (text !== '') this.overrides.set(PromptLibraryImpl.idOf(slot.kind, slot.key), text);
    }
    this.loaded = true;
  }

  /**
   * 同步取某个槽位**最终生效**的正文。
   *
   * 槽位 id 未知（例如设置里留着一个已被移除的旧风格值）时返回空串，
   * 由调用方跳过——不做「猜一个最接近的」这种静默替换。
   */
  resolveSync(kind: PromptSlotKind, key: string): string {
    const slot = findSlot(kind, key);
    if (!slot) return '';
    return this.overrides.get(PromptLibraryImpl.idOf(kind, key)) ?? slot.builtin;
  }

  /** 同步取磁盘覆盖正文（无覆盖为 null）；UI 用它区分「已自定义」 */
  overrideSync(kind: PromptSlotKind, key: string): string | null {
    return this.overrides.get(PromptLibraryImpl.idOf(kind, key)) ?? null;
  }

  /** 是否已被用户外置覆盖 */
  isCustomized(kind: PromptSlotKind, key: string): boolean {
    return this.overrides.has(PromptLibraryImpl.idOf(kind, key));
  }

  /** 同步快照（UI 列表用，含内置正文与覆盖态） */
  statesSync(kind?: PromptSlotKind): PromptSlotState[] {
    const slots = kind ? slotsOfKind(kind) : [...PROMPT_SLOTS];
    return slots.map((slot) => {
      const override = this.overrideSync(slot.kind, slot.key);
      return { slot, override, effective: override ?? slot.builtin };
    });
  }

  /**
   * 写入覆盖。**空白正文等价于恢复默认**（删文件），而不是写一份空文件——
   * 否则磁盘上会出现一个「看起来被自定义过、实际什么都没改」的文件。
   */
  async save(kind: PromptSlotKind, key: string, text: string): Promise<void> {
    if (!findSlot(kind, key)) {
      throw new Error(`未知的提示词槽位：${kind}.${key}`);
    }
    const trimmed = (text ?? '').trim();
    if (trimmed === '') {
      await this.reset(kind, key);
      return;
    }
    await platform.storage.set(PromptLibrary.storageKeyOf(kind, key), trimmed);
    this.overrides.set(PromptLibraryImpl.idOf(kind, key), trimmed);
  }

  /** 恢复默认：删除磁盘覆盖文件并清掉快照 */
  async reset(kind: PromptSlotKind, key: string): Promise<void> {
    await platform.storage.remove(PromptLibrary.storageKeyOf(kind, key));
    this.overrides.delete(PromptLibraryImpl.idOf(kind, key));
  }

  /** 批量读取磁盘原文（UI 编辑框打开时用，避免依赖快照新鲜度） */
  async readRaw(kind: PromptSlotKind, key: string): Promise<string | null> {
    try {
      const raw = await platform.storage.get<string>(
        PromptLibrary.storageKeyOf(kind, key),
      );
      return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
    } catch {
      return null;
    }
  }

  /** 测试用：清空内存快照 */
  __resetForTest(): void {
    this.overrides.clear();
    this.loaded = false;
  }
}

/** PromptLibrary 单例（UI / store 一律用这个实例，禁止 new） */
export const PromptLibrary = new PromptLibraryImpl();
