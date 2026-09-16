/**
 * 身份文件服务（FR-4.3 / design §14.1 的 L4）。
 *
 * 关键契约有两条，都不是「能读能写」这么简单：
 *
 * 1. **`exists` 与 `content !== ''` 必须可区分**。「用户把文件清空了」和
 *    「用户从没写过」在 UI 上是两种状态，合并成一个字段会让「恢复默认」按钮
 *    的语义错乱。
 * 2. **`isOnboarding()` 要求引导文件非空**。只要文件存在就进引导态的话，
 *    用户手动清空内容后会被永久困在一个他自己关掉的流程里。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityService, IDENTITY_FILE_DEFS } from '@/lib/identity';
import { IDENTITY_STORAGE_KEYS } from '@/lib/constants';
import type { IdentityFileKind } from '@/types';

const KINDS: IdentityFileKind[] = ['soul', 'identity', 'user', 'bootstrap'];

beforeEach(() => {
  window.localStorage.clear();
  IdentityService.__resetForTest();
});

describe('IdentityService：读写', () => {
  it('未加载过时视为「不存在」（不是「空文件」）', () => {
    const state = IdentityService.getSync('soul');
    expect(state.exists).toBe(false);
    expect(state.content).toBe('');
  });

  it('loadAll 后未写过的文件都是不存在', async () => {
    await IdentityService.loadAll();
    for (const kind of KINDS) {
      expect(IdentityService.getSync(kind).exists, kind).toBe(false);
    }
    expect(IdentityService.isLoaded).toBe(true);
  });

  it('save 之后同步可见', async () => {
    await IdentityService.save('identity', '我是 ReviewBot');
    await IdentityService.loadAll();
    expect(IdentityService.contentSync('identity')).toBe('我是 ReviewBot');
    expect(IdentityService.getSync('identity').exists).toBe(true);
  });

  it('save 空串 = 文件存在但内容为空（与「没写过」不同）', async () => {
    await IdentityService.save('soul', '');
    await IdentityService.loadAll();
    const state = IdentityService.getSync('soul');
    expect(state.exists).toBe(true);
    expect(state.content).toBe('');
  });

  it('remove 回到「没写过」', async () => {
    await IdentityService.save('soul', '内容');
    await IdentityService.loadAll();
    expect(IdentityService.getSync('soul').exists).toBe(true);

    await IdentityService.remove('soul');
    await IdentityService.loadAll();
    expect(IdentityService.getSync('soul').exists).toBe(false);
    expect(IdentityService.contentSync('soul')).toBe('');
  });

  it('read 直接读盘，不依赖快照新鲜度', async () => {
    // 绕过服务直接落盘，模拟「另一个窗口写入」
    await window.localStorage.setItem(
      IDENTITY_STORAGE_KEYS.user,
      JSON.stringify('外部写入的内容'),
    );
    expect(IdentityService.contentSync('user')).toBe(''); // 快照还没刷新
    expect(await IdentityService.read('user')).toBe('外部写入的内容');
  });

  it('读取异常收敛为「不存在」，不抛错', async () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(IdentityService.loadAll()).resolves.toBeUndefined();
    spy.mockRestore();
    expect(IdentityService.getSync('soul').exists).toBe(false);
  });
});

describe('IdentityService：一次性引导', () => {
  it('引导文件存在且非空 → 进入引导态', async () => {
    await IdentityService.save('bootstrap', '先了解我是谁');
    await IdentityService.loadAll();
    expect(IdentityService.isOnboarding()).toBe(true);
  });

  it('引导文件不存在 → 不在引导态', async () => {
    await IdentityService.loadAll();
    expect(IdentityService.isOnboarding()).toBe(false);
  });

  it('引导文件被清空 → 不在引导态（用户关掉的流程不该把他困住）', async () => {
    await IdentityService.save('bootstrap', '');
    await IdentityService.loadAll();
    expect(IdentityService.getSync('bootstrap').exists).toBe(true);
    expect(IdentityService.isOnboarding()).toBe(false);
  });

  it('引导文件只有空白 → 不在引导态', async () => {
    await IdentityService.save('bootstrap', '   \n  ');
    await IdentityService.loadAll();
    expect(IdentityService.isOnboarding()).toBe(false);
  });

  it('completeOnboarding 删除文件并返回 true', async () => {
    await IdentityService.save('bootstrap', '种子');
    await IdentityService.loadAll();
    expect(await IdentityService.completeOnboarding()).toBe(true);
    await IdentityService.loadAll();
    expect(IdentityService.isOnboarding()).toBe(false);
    expect(IdentityService.getSync('bootstrap').exists).toBe(false);
  });

  it('completeOnboarding 对不存在的文件返回 false（幂等，不抛错）', async () => {
    await IdentityService.loadAll();
    expect(await IdentityService.completeOnboarding()).toBe(false);
    expect(await IdentityService.completeOnboarding()).toBe(false);
  });

  it('完成引导不触碰其它身份文件', async () => {
    await IdentityService.save('soul', '原则');
    await IdentityService.save('identity', '名字');
    await IdentityService.save('bootstrap', '种子');
    await IdentityService.loadAll();

    await IdentityService.completeOnboarding();
    await IdentityService.loadAll();

    expect(IdentityService.contentSync('soul')).toBe('原则');
    expect(IdentityService.contentSync('identity')).toBe('名字');
  });
});

describe('IdentityService：快照与元信息', () => {
  it('statesSync 覆盖四个文件且文件名正确', async () => {
    await IdentityService.loadAll();
    const states = IdentityService.statesSync();
    expect(states.map((s) => s.filename)).toEqual([
      'SOUL.md',
      'IDENTITY.md',
      'USER.md',
      'BOOTSTRAP.md',
    ]);
  });

  it('每个 kind 都有展示元信息', () => {
    for (const kind of KINDS) {
      expect(IDENTITY_FILE_DEFS[kind].label.trim()).not.toBe('');
      expect(IDENTITY_FILE_DEFS[kind].description.trim()).not.toBe('');
    }
  });

  it('storage key 形状稳定（主进程路由按它匹配）', () => {
    expect(IDENTITY_STORAGE_KEYS.soul).toBe('nanowork.identity.soul');
    expect(IDENTITY_STORAGE_KEYS.bootstrap).toBe('nanowork.identity.bootstrap');
  });

  it('空文件与未写过在快照里可区分', async () => {
    await IdentityService.save('soul', '');
    await IdentityService.loadAll();
    const soul = IdentityService.statesSync().find((s) => s.kind === 'soul');
    const user = IdentityService.statesSync().find((s) => s.kind === 'user');
    expect(soul?.exists).toBe(true);
    expect(user?.exists).toBe(false);
  });
});
