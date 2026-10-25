import { describe, expect, it } from 'vitest';
import { hashContent } from '@/lib/workspace/workspaceKey';
import {
  blockAt,
  blockKey,
  diffRemovedKeys,
  mergeMemory,
  mergeMemoryText,
  mergeTombstones,
  parseMemory,
  renderMemory,
  splitBlocks,
} from '@/lib/memory/memoryMerge';

/** 复刻 `MemoryService.append` 产出的引用块形态（含去重标记与时间行） */
function quoteBlock(at: string, body: string): string {
  return `> [${at}] 来自「手动保存」\n> <!-- SUMMARY:${hashContent(body)} -->\n> ${body}`;
}

const T1 = '2026-09-29T10:00:00.000Z';
const T2 = '2026-09-29T11:00:00.000Z';
const T3 = '2026-09-29T12:00:00.000Z';

describe('memoryMerge — 段落切分与段键', () => {
  it('按空行切分（不是按 ## 标题）——引用块占绝大多数（D2-1）', () => {
    const text = `${quoteBlock(T1, '我叫明明')}\n\n${quoteBlock(T2, '我擅长前端')}\n\n## 手写小节\n\n内容`;
    const blocks = splitBlocks(text);
    expect(blocks).toHaveLength(4);
    // 引用块没有被 `## ` 切碎
    expect(blocks[0].startsWith('> [')).toBe(true);
  });

  it('块首时间是 ISO（D2-3）；无时间戳的块视为最旧', () => {
    expect(blockAt(quoteBlock(T1, 'x'))).toBe(T1);
    expect(blockAt('> 没有时间行\n> 正文')).toBe('');
  });

  it('段键跨设备一致：引用块走 SUMMARY 哈希（J-4）', () => {
    // 同一正文在两台机器上各自 append，标记哈希必然相同
    expect(blockKey(quoteBlock(T1, '我叫明明'))).toBe(
      blockKey(quoteBlock(T2, '我叫明明')),
    );
    // 与「正文不同」区分开
    expect(blockKey(quoteBlock(T1, '我叫明明'))).not.toBe(
      blockKey(quoteBlock(T1, '我叫红红')),
    );
  });

  it('手写块（无标记）走归一化哈希，标点/大小写不同不影响键（J-4）', () => {
    const a = blockKey('## 项目决策\n\n采用 SQLite');
    const b = blockKey('## 项目决策\n\n采用sqlite！');
    expect(a).toBe(b);
    // 与标记块不混进同一命名空间
    expect(a.startsWith('t:')).toBe(true);
    expect(blockKey(quoteBlock(T1, 'x')).startsWith('s:')).toBe(true);
  });

  it('renderMemory 与 splitBlocks 互为逆运算（同键重复只留一份）', () => {
    const text = `${quoteBlock(T1, 'a')}\n\n${quoteBlock(T2, 'b')}`;
    expect(renderMemory(parseMemory(text))).toBe(text);
  });
});

describe('memoryMerge — 段落级 LWW', () => {
  it('J-1 两端各自 append，合并后两段都在（并集，不丢）', () => {
    const local = `${quoteBlock(T1, '我叫明明')}`;
    const remote = `${quoteBlock(T2, '我擅长前端')}`;
    const merged = mergeMemoryText(local, remote);
    expect(merged).toContain('我叫明明');
    expect(merged).toContain('我擅长前端');
    // 按时间升序
    expect(merged.indexOf('我叫明明')).toBeLessThan(merged.indexOf('我擅长前端'));
  });

  it('J-2 同段键冲突：at 大者胜（内容不同即代表被改写）', () => {
    const a = parseMemory(quoteBlock(T1, '我叫明明'));
    // 对端同一段（同键）在更晚时刻被改成另一份正文
    const b: typeof a = { blocks: [{ key: a.blocks[0].key, at: T3, body: '我叫红红' }], tombstones: {} };
    const merged = renderMemory(mergeMemory(a, b));
    expect(merged).toContain('我叫红红');
    expect(merged).not.toContain('我叫明明');
  });

  it('J-2b at 相同保留块（块优先于墓碑的同一条取舍）', () => {
    const a = parseMemory(quoteBlock(T1, '我叫明明'));
    const b = { blocks: a.blocks, tombstones: { [a.blocks[0].key]: T1 } };
    const merged = renderMemory(mergeMemory(a, b));
    expect(merged).toContain('我叫明明');
  });

  it('J-3 删除可传播：墓碑严格更新 → 该段不回来', () => {
    const local = parseMemory(`${quoteBlock(T1, '我叫明明')}\n\n${quoteBlock(T2, '我擅长前端')}`);
    const removedKey = local.blocks[0].key;
    // 对端已删除第一段（墓碑时刻晚于段时刻）+ 保留第二段
    const remote = {
      blocks: local.blocks.filter((b) => b.key !== removedKey),
      tombstones: { [removedKey]: T3 },
    };
    const merged = renderMemory(mergeMemory(local, remote));
    expect(merged).not.toContain('我叫明明');
    expect(merged).toContain('我擅长前端');
  });

  it('J-3b 清空可传播：对端清空（全部段进墓碑）→ 本机也变空', () => {
    const local = parseMemory(`${quoteBlock(T1, 'a')}\n\n${quoteBlock(T2, 'b')}`);
    const remote = {
      blocks: [],
      tombstones: Object.fromEntries(local.blocks.map((b) => [b.key, T3])),
    };
    expect(renderMemory(mergeMemory(local, remote))).toBe('');
  });

  it('J-3c 删除后又被写回来：墓碑更旧 → 段保留', () => {
    const key = blockKey(quoteBlock(T1, '我叫明明'));
    const local = { blocks: [{ key, at: T3, body: quoteBlock(T3, '我叫明明') }], tombstones: {} };
    const remote = { blocks: [], tombstones: { [key]: T1 } };
    expect(renderMemory(mergeMemory(local, remote))).toContain('我叫明明');
  });

  it('合并幂等且可交换', () => {
    const a = parseMemory(`${quoteBlock(T1, 'a')}`);
    const b = parseMemory(`${quoteBlock(T2, 'b')}`);
    const ab = mergeMemory(a, b);
    const ba = mergeMemory(b, a);
    expect(renderMemory(ab)).toBe(renderMemory(ba));
    // 再合并一次不变
    expect(renderMemory(mergeMemory(ab, b))).toBe(renderMemory(ab));
  });

  it('两侧皆空 → 空；墓碑单独存在时不产生段落', () => {
    expect(renderMemory(mergeMemory(parseMemory(''), parseMemory('')))).toBe('');
    const only = mergeMemory({ blocks: [], tombstones: { 's:1': T1 } }, parseMemory(''));
    expect(only.blocks).toHaveLength(0);
    expect(only.tombstones['s:1']).toBe(T1);
  });
});

describe('memoryMerge — 墓碑工具', () => {
  it('mergeTombstones 同键取时刻较大者', () => {
    expect(mergeTombstones({ k: T1 }, { k: T3 })).toEqual({ k: T3 });
    expect(mergeTombstones({ k: T3 }, { k: T1 })).toEqual({ k: T3 });
    expect(mergeTombstones({ a: T1 }, { b: T2 })).toEqual({ a: T1, b: T2 });
  });

  it('diffRemovedKeys：上次有、这次没有 → 墓碑（D2-5）', () => {
    expect(diffRemovedKeys(['s:1', 's:2'], ['s:2'], T3)).toEqual({ 's:1': T3 });
    expect(diffRemovedKeys(['s:1'], ['s:1', 's:2'], T3)).toEqual({});
    expect(diffRemovedKeys([], [], T3)).toEqual({});
  });
});
