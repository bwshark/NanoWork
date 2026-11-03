/**
 * FR-8.9：**回滚长期记忆**必须留痕。
 *
 * 为什么值得单独立一条：回滚覆盖的是磁盘上的长期记忆文件，而记忆会影响之后
 * **每一个回合**的模型行为——出事之后第一个要问的就是「这份记忆被人改过没有、
 * 改回的是哪一版」。版本时间线只说「有过哪些快照」，说不出「有人用其中某一版
 * 覆盖了当前内容」，两者不是同一件事。
 *
 * 这条用例同时也是接线判据：`rollbackTo` 在组件闭包里，审计写没写没有任何
 * 静态检查能发现（漏了不报错，页面照常弹「已回滚到所选版本」）。
 *
 * ⚠️ 回滚入口只在 `platform.env === 'electron'` 时渲染（Web 端没有备份落点），
 * 所以这里必须把 env 打桩成 electron，否则页面只会显示「仅桌面端支持」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPage } from '@/pages/memory/MemoryPage';
import { MemoryService } from '@/lib/memory/memory';
import { CURATED_MEMORY_FILE } from '@/lib/memory/workspaceMemory';
import { fileKeyOf, useFileBackupStore } from '@/stores/fileBackupStore';
import { platform } from '@/platform';
import { buttonByText, click, dialogRoot, flush, mount, unmount } from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CURRENT = '当前这版记忆正文';
const OLD = '更早那版记忆正文';
const HASH = 'a1b2c3d4e5f60718';

beforeEach(async () => {
  unmount();
  // 回滚入口的渲染条件就是这一条；web 环境下整块 UI 都不存在
  (platform as unknown as { env: string }).env = 'electron';
  await MemoryService.save(CURRENT, 'workspace');
  const key = fileKeyOf(
    'workspace',
    MemoryService.resolveWorkspaceDir(),
    CURATED_MEMORY_FILE,
  );
  useFileBackupStore.setState({
    timeline: {
      [key]: [{ hash: HASH, at: '2026-11-01T10:00:00.000Z', op: 'overwrite', seq: 1 }],
    },
  });
  vi.spyOn(platform.fileBackup, 'get').mockResolvedValue(OLD);
});

afterEach(() => {
  unmount();
  (platform as unknown as { env: string }).env = 'web';
  useFileBackupStore.setState({ timeline: {} });
  vi.restoreAllMocks();
});

describe('记忆页：回滚到历史版本', () => {
  it('回滚成功后写一条 memory.rollback，并把正文换成旧版', async () => {
    const append = vi.spyOn(platform, 'auditAppendApp').mockResolvedValue({ ok: true });

    const host = mount(<MemoryPage />);
    await flush();

    await click(buttonByText(host, '回滚到此处')!);
    await flush();
    // ⚠️ 只能在对话框里找「回滚」：`buttonByText` 是**包含**匹配，
    // 在 body 上找会先命中触发这次对话框的那颗「回滚到此处」，于是又开一次弹窗。
    await click(buttonByText(dialogRoot(), '回滚')!);
    await flush();

    // 先确认「回滚真的发生了」：否则下面那条审计断言可能只是在验一个假的成功路径
    expect(await MemoryService.load('workspace')).toBe(OLD);

    const rows = append.mock.calls
      .flatMap((call) => call[0])
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const rollback = rows.find((row) => row.action === 'memory.rollback');
    expect(rollback, '回滚没有写审计').toBeTruthy();
    expect(rollback?.targetLabel).toBe(CURATED_MEMORY_FILE);
    // 只留哈希前 8 位：够对上备份条目，又不至于让审计行变成一串乱码
    expect((rollback?.detail as Record<string, unknown>)?.version).toBe(HASH.slice(0, 8));
  });
});
