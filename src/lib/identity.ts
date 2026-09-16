import { platform } from '@/platform';
import { IDENTITY_FILENAMES, IDENTITY_STORAGE_KEYS } from '@/lib/constants';
import type { IdentityFileKind, IdentityFileState } from '@/types';

/**
 * 身份文件服务（design §14.1 的 L4、FR-4.3）。
 *
 * 四个文件落在 ① `~/.nanowork/` 根目录，文件名即用户可见的名字：
 *
 * | 文件 | 回答的问题 | 写入方 |
 * |---|---|---|
 * | `SOUL.md` | 我怎么做事（原则、语气、边界） | 引导生成 + 用户编辑 |
 * | `IDENTITY.md` | **我是谁**（名字、角色、专长） | 引导生成 + 用户编辑 |
 * | `USER.md` | 用户是谁（偏好、背景） | 引导生成 + 用户编辑 |
 * | `BOOTSTRAP.md` | 一次性引导种子；引导完成后**删除** | 出厂预置 |
 *
 * ## 同步快照与 `PromptLibrary` 同构
 *
 * 身份文件每轮都要注入，而注入点在 `streamAssistantReply` 的**同步**段里
 * （那里不能 `await`，见 PromptLibrary 的模块注释）。所以这里同样是
 * 「异步 `loadAll()` 读盘 + 同步 `getSync()` 取用」，且未加载时退化为
 * 「没有身份文件」而不是抛错。
 *
 * ## 为什么 `exists` 与 `content !== ''` 要分开
 *
 * 「空文件」和「没写过」在 UI 上是两种状态：前者是用户**故意清空**（例如想把
 * 出厂脚手架去掉），后者是还没开始。合并成一个 `content` 会让前者的「恢复默认」
 * 按钮语义错乱——分不清是恢复出厂还是恢复上次清空的结果。
 */
class IdentityServiceImpl {
  private snapshot = new Map<IdentityFileKind, { content: string; exists: boolean }>();

  /** 是否已完成过一次读盘 */
  private loaded = false;

  get isLoaded(): boolean {
    return this.loaded;
  }

  private static storageKeyOf(kind: IdentityFileKind): string {
    return IDENTITY_STORAGE_KEYS[kind];
  }

  /**
   * 从磁盘读入全部身份文件，刷新内存快照。
   * 单个文件读取失败收敛为「不存在」，不影响其余文件。
   */
  async loadAll(): Promise<void> {
    const kinds = Object.keys(IDENTITY_FILENAMES) as IdentityFileKind[];
    const results = await Promise.all(
      kinds.map(async (kind): Promise<[IdentityFileKind, { content: string; exists: boolean }]> => {
        try {
          const raw = await platform.storage.get<string>(
            IdentityServiceImpl.storageKeyOf(kind),
          );
          if (typeof raw === 'string') return [kind, { content: raw, exists: true }];
          return [kind, { content: '', exists: false }];
        } catch {
          return [kind, { content: '', exists: false }];
        }
      }),
    );

    this.snapshot.clear();
    for (const [kind, state] of results) this.snapshot.set(kind, state);
    this.loaded = true;
  }

  /** 同步取某个身份文件的状态（未加载 → 视为不存在） */
  getSync(kind: IdentityFileKind): { content: string; exists: boolean } {
    return this.snapshot.get(kind) ?? { content: '', exists: false };
  }

  /** 同步取正文（未写过为空串） */
  contentSync(kind: IdentityFileKind): string {
    return this.getSync(kind).content;
  }

  /**
   * 是否处于「一次性引导」模式：`BOOTSTRAP.md` 存在且非空。
   *
   * 刻意要求**非空**：空文件说明用户已经手动清掉了内容，此时再让整个会话进入
   * 引导态会把人困在一段他自己关掉的流程里。
   */
  isOnboarding(): boolean {
    const state = this.getSync('bootstrap');
    return state.exists && state.content.trim() !== '';
  }

  /** 同步快照（UI 列表用） */
  statesSync(): IdentityFileState[] {
    return (Object.keys(IDENTITY_FILENAMES) as IdentityFileKind[]).map((kind) => {
      const def = IDENTITY_FILE_DEFS[kind];
      const state = this.getSync(kind);
      return {
        kind,
        filename: IDENTITY_FILENAMES[kind],
        label: def.label,
        description: def.description,
        content: state.content,
        exists: state.exists,
      };
    });
  }

  /** 直接读盘取原文（UI 打开编辑框时用，避免依赖快照新鲜度） */
  async read(kind: IdentityFileKind): Promise<string> {
    try {
      const raw = await platform.storage.get<string>(IdentityServiceImpl.storageKeyOf(kind));
      return typeof raw === 'string' ? raw : '';
    } catch {
      return '';
    }
  }

  /** 写入正文（空串 = 清空但保留文件，与「恢复默认=删文件」不同，见 remove） */
  async save(kind: IdentityFileKind, text: string): Promise<void> {
    const value = text ?? '';
    await platform.storage.set(IdentityServiceImpl.storageKeyOf(kind), value);
    this.snapshot.set(kind, { content: value, exists: true });
  }

  /** 删除文件（回到「没写过」的状态） */
  async remove(kind: IdentityFileKind): Promise<void> {
    await platform.storage.remove(IdentityServiceImpl.storageKeyOf(kind));
    this.snapshot.set(kind, { content: '', exists: false });
  }

  /**
   * 结束一次性引导：删除 `BOOTSTRAP.md`。
   *
   * 语义是「出生证明已用完」——引导过程产出的内容已经落到 SOUL/IDENTITY/USER，
   * 再留着它会让**之后每一个**新会话都重新进入引导态。
   *
   * 返回是否确实删掉了文件（false = 本来就没有）。
   */
  async completeOnboarding(): Promise<boolean> {
    const had = this.getSync('bootstrap').exists;
    await this.remove('bootstrap');
    return had;
  }

  /** 测试用：清空内存快照 */
  __resetForTest(): void {
    this.snapshot.clear();
    this.loaded = false;
  }
}

/** 身份文件的展示元信息（UI 与快照共用） */
export const IDENTITY_FILE_DEFS: Record<
  IdentityFileKind,
  { label: string; description: string }
> = {
  soul: {
    label: 'SOUL.md · 行事原则',
    description: '我怎么做事：原则、语气、边界。出厂自带一份默认，改了即生效。',
  },
  identity: {
    label: 'IDENTITY.md · 身份',
    description: '我是谁：名字、角色、专长。与「我怎么做事」分开，便于多套人设复用同一套原则。',
  },
  user: {
    label: 'USER.md · 用户画像',
    description: '用户是谁：称呼、偏好、背景。跨会话生效，每轮注入。',
  },
  bootstrap: {
    label: 'BOOTSTRAP.md · 一次性引导',
    description:
      '存在即进入引导态：Agent 先按它完成自我设定，产出落到上面三个文件后删除本文件。',
  },
};

/** IdentityService 单例（UI / store 一律用这个实例，禁止 new） */
export const IdentityService = new IdentityServiceImpl();
