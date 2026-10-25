import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FR-7.3 写路径断言：MemoryService 的五个写入口（save / writeFile / append /
 * removeFile / clear）必须在落盘前调 `snapshotBeforeWrite`——即往 `platform.fileBackup`
 * 存一份旧正文，并在 `useFileBackupStore` 记一条时间线。这里用真实 web platform
 * （storage 走 localStorage、fileBackup 是 no-op），直接断言时间线条目与备份调用，
 * 证明「写前快照」真的挂上了。
 */
import { MemoryService } from '@/lib/memory/memory';
import { platform } from '@/platform';
import { useFileBackupStore } from '@/stores/fileBackupStore';
import { fileKeyOf } from '@/lib/artifact/fileBackup';
import { contentHash } from '@/lib/core/contentHash';

const USER_KEY = fileKeyOf('user', null, 'MEMORY.md');
const WS_KEY = fileKeyOf('workspace', null, 'MEMORY.md');

beforeEach(() => {
  window.localStorage.clear();
  useFileBackupStore.setState({ timeline: {} });
  // 工作区级用默认工作区（无 workdir），让 WS_KEY 口径稳定
  MemoryService.useWorkspace(null);
  vi.restoreAllMocks();
});

describe('MemoryService 写路径挂 prebackup（FR-7.3 / J-A1~A3）', () => {
  it('user 级 save 覆盖前记 overwrite 快照 + 备份旧正文', async () => {
    await MemoryService.save('初版', 'user');
    const putSpy = vi.spyOn(platform.fileBackup, 'put');
    await MemoryService.save('改版', 'user');

    expect(putSpy).toHaveBeenCalledWith(contentHash('初版'), '初版');
    const tl = useFileBackupStore.getState().list(USER_KEY);
    expect(tl.some((e) => e.op === 'overwrite' && e.hash === contentHash('初版'))).toBe(true);
  });

  it('user 级 append 追加前记 append 快照', async () => {
    await MemoryService.append('a', { source: 's', at: '2025-01-01T00:00:00.000Z' }, 'user');
    const putSpy = vi.spyOn(platform.fileBackup, 'put');
    await MemoryService.append('b', { source: 's', at: '2025-01-02T00:00:00.000Z' }, 'user');

    // append 的快照针对「写入前的整段合并视图」（含引用块格式），故只断言 op 与备份发生；
    // 不比较具体 hash（那是对整段文本算的，不是裸 'a'）
    expect(putSpy).toHaveBeenCalled();
    const tl = useFileBackupStore.getState().list(USER_KEY);
    expect(tl.some((e) => e.op === 'append')).toBe(true);
  });

  it('user 级 clear 删除前记 delete 快照', async () => {
    await MemoryService.save('待清', 'user');
    const putSpy = vi.spyOn(platform.fileBackup, 'put');
    await MemoryService.clear('user');

    expect(putSpy).toHaveBeenCalledWith(contentHash('待清'), '待清');
    const tl = useFileBackupStore.getState().list(USER_KEY);
    expect(tl.some((e) => e.op === 'delete' && e.hash === contentHash('待清'))).toBe(true);
  });

  it('workspace 级 save（=写 MEMORY.md）覆盖前记 overwrite 快照', async () => {
    await MemoryService.save('ws 初版');
    const putSpy = vi.spyOn(platform.fileBackup, 'put');
    await MemoryService.save('ws 改版');

    expect(putSpy).toHaveBeenCalled();
    const tl = useFileBackupStore.getState().list(WS_KEY);
    expect(tl.some((e) => e.op === 'overwrite' && e.hash === contentHash('ws 初版'))).toBe(true);
  });

  it('workspace 级 removeFile 删除前记 delete 快照', async () => {
    await MemoryService.writeFile(null, 'MEMORY.md', '将要被删的内容');
    const putSpy = vi.spyOn(platform.fileBackup, 'put');
    await MemoryService.removeFile(null, 'MEMORY.md');

    expect(putSpy).toHaveBeenCalledWith(contentHash('将要被删的内容'), '将要被删的内容');
    const tl = useFileBackupStore.getState().list(WS_KEY);
    expect(tl.some((e) => e.op === 'delete')).toBe(true);
  });

  it('workspace 级 clear 逐个备份被删文件的旧正文', async () => {
    await MemoryService.writeFile(null, 'MEMORY.md', '精炼记忆');
    await MemoryService.append('日期文件内容', { source: 's', at: '2025-03-03T00:00:00.000Z' });
    const putSpy = vi.spyOn(platform.fileBackup, 'put');
    await MemoryService.clear('workspace');

    // 至少两份文件被备份（MEMORY.md + 当日日期文件）
    expect(putSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(useFileBackupStore.getState().list(WS_KEY).every((e) => e.op === 'delete')).toBe(true);
  });
});
