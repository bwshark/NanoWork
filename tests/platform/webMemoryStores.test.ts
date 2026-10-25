/**
 * Web 端两套记忆存储的**同源约束**（`src/platform/storage.web.ts`）。
 *
 * ## 为什么要专门锁这个
 *
 * Web 把同一个「记忆目录」拆成两个 localStorage key：v1 `nanowork.wsmem.*`（`{文件名: 正文}`）
 * 与 v2 `nanowork.mem2.*`（带子目录的相对名）。拆开是必要的（v1 的文件名过滤器会丢掉带 `/`
 * 的名字，v2 的事实日志就永远列不出来），但**`MEMORY.md` 会被两边同时认领**——
 * 而它的写路径在 v2（`applyManualMemoryEdit` / `distill` 重写投影）、读路径却有一半在 v1
 * （`MemoryService.readFile` / `loadForInjection`）。两侧不同源时症状是：
 * 手编保存看起来成功（toast 说「已登记」、投影也写对了），但编辑器读回来是**空的**，
 * 注入的 legacy 段落也是旧内容。真机就是这么发现的（`tasks/verify-memory-v2.mjs`）。
 *
 * Electron 端两套能力落在**同一个真实目录**，所以这类用例在那边永远测不出来——
 * 只有直接测 Web 适配层才暴露。判据因此都落在「写一侧、从另一侧读」上。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { WebMemoryDirFiles, WebWorkspaceMemoryFiles } from '@/platform/storage.web';
import { CURATED_MEMORY_FILE, webMemoryDirKey } from '@/lib/memory/memoryPaths';
import { dailyMemoryFileName } from '@/lib/memory/workspaceMemory';
import { WORKSPACE_MEMORY_STORAGE_PREFIX } from '@/platform/storage.web';
import { workspaceKeyFor } from '@/lib/workspace/workspaceKey';
import type { MemoryDirRef } from '@/platform/types';

const REF: MemoryDirRef = { kind: 'workspace', workdir: null };

const v1 = new WebWorkspaceMemoryFiles();
const v2 = new WebMemoryDirFiles();

/** v1 侧那个装 `.md` 的 blob（裸读，用来证「有没有残留第二份」） */
const v1Blob = (): Record<string, string> => {
  const raw = window.localStorage.getItem(`${WORKSPACE_MEMORY_STORAGE_PREFIX}${workspaceKeyFor(null)}`);
  return raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
};

beforeEach(() => {
  window.localStorage.clear();
});

describe('MEMORY.md 在 Web 端只有一个物理落点（v2 侧）', () => {
  it('v2 写入后，v1 面能原样读回来', async () => {
    await v2.writeDirFile(REF, CURATED_MEMORY_FILE, '- 本项目不要引入 ORM');
    expect(await v1.read(null, CURATED_MEMORY_FILE)).toBe('- 本项目不要引入 ORM');
  });

  it('证伪性：只读 v1 映射就会读不到（这正是修复前的实现）', async () => {
    await v2.writeDirFile(REF, CURATED_MEMORY_FILE, '只写了 v2');
    // 修复前 `v1.read()` 的等价写法——只查 v1 那份映射
    expect(v1Blob()[CURATED_MEMORY_FILE]).toBeUndefined();
    // 现在同一个调用能读到，差别全在「转发到 v2」这一步
    expect(await v1.read(null, CURATED_MEMORY_FILE)).toBe('只写了 v2');
  });

  it('v1 写入后，v2 面能原样读回来（保存路径与读路径同源）', async () => {
    await v1.write(null, CURATED_MEMORY_FILE, '手编的一条规则');
    expect(await v2.readDirFile(REF, CURATED_MEMORY_FILE)).toBe('手编的一条规则');
  });

  it('写入不留下第二份：v1 键里不再有 MEMORY.md', async () => {
    await v1.write(null, CURATED_MEMORY_FILE, '只应存在一处');
    expect(Object.keys(v1Blob())).not.toContain(CURATED_MEMORY_FILE);
    // v1 键空了就整个删掉，不留 `{}` 孤儿
    expect(window.localStorage.getItem(`${WORKSPACE_MEMORY_STORAGE_PREFIX}${workspaceKeyFor(null)}`)).toBeNull();
    expect(window.localStorage.getItem(webMemoryDirKey(REF))).toContain('只应存在一处');
  });

  it('v1 的目录列表带上 v2 侧的 MEMORY.md', async () => {
    await v2.writeDirFile(REF, CURATED_MEMORY_FILE, 'x');
    expect(await v1.list(null)).toContain(CURATED_MEMORY_FILE);
  });

  it('v1 删除 MEMORY.md 也作用在 v2 侧', async () => {
    await v2.writeDirFile(REF, CURATED_MEMORY_FILE, 'x');
    await v1.remove(null, CURATED_MEMORY_FILE);
    expect(await v2.readDirFile(REF, CURATED_MEMORY_FILE)).toBeNull();
    expect(await v1.read(null, CURATED_MEMORY_FILE)).toBeNull();
  });

  it('读宽回落：只有 v1 侧有 MEMORY.md 的旧数据仍读得到（只读，不迁移）', async () => {
    // 直接塞进 v1 blob，模拟「v2 之前写入、尚未经蒸馏重建」的历史数据
    window.localStorage.setItem(
      `${WORKSPACE_MEMORY_STORAGE_PREFIX}${workspaceKeyFor(null)}`,
      JSON.stringify({ [CURATED_MEMORY_FILE]: '老版本写的正文' }),
    );
    expect(await v1.read(null, CURATED_MEMORY_FILE)).toBe('老版本写的正文');
    // 回落是只读的：写入一次后即收敛到 v2 一侧，v1 不再残留
    await v1.write(null, CURATED_MEMORY_FILE, '新正文');
    expect(Object.keys(v1Blob())).not.toContain(CURATED_MEMORY_FILE);
    expect(await v2.readDirFile(REF, CURATED_MEMORY_FILE)).toBe('新正文');
  });

  it('日期 .md 仍留在 v1 一侧，不进 v2 命名空间', async () => {
    const day = dailyMemoryFileName();
    await v1.write(null, day, '今天的日志');
    expect(await v1.read(null, day)).toBe('今天的日志');
    expect(await v2.readDirFile(REF, day)).toBeNull();
    expect(await v2.listDir(REF)).not.toContain(day);
  });

  it('removeAll 两侧一起清，计数把 MEMORY.md 算上', async () => {
    const day = dailyMemoryFileName();
    await v1.write(null, day, '日志');
    await v1.write(null, CURATED_MEMORY_FILE, '精炼记忆');
    expect(await v1.removeAll(null)).toBe(2);
    expect(await v1.read(null, CURATED_MEMORY_FILE)).toBeNull();
    expect(await v1.read(null, day)).toBeNull();
    expect(await v1.list(null)).toEqual([]);
  });

  it('清空工作区记忆不碰 v2 的 canonical（curated.json 才是权威）', async () => {
    await v2.writeDirFile(REF, 'curated.json', '{"schema":2}');
    await v1.write(null, CURATED_MEMORY_FILE, '投影');
    await v1.removeAll(null);
    expect(await v2.readDirFile(REF, 'curated.json')).toBe('{"schema":2}');
    expect(await v2.readDirFile(REF, CURATED_MEMORY_FILE)).toBeNull();
  });
});
