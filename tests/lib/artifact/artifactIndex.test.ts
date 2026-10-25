import { describe, expect, it } from 'vitest';
import {
  artifactContentHash,
  buildIndexEntry,
  filterItems,
  groupByHash,
  hasVersionHistory,
  matchesKeyword,
  sortGroups,
  type ArtifactItem,
} from '@/lib/artifact/artifactIndex';
import type { Artifact, ArtifactIndexEntry } from '@/types';

function art(over: Partial<Artifact> & { id: string }): Artifact {
  const { id, ...rest } = over;
  return { type: 'code', content: '', createdAt: '2026-09-29T00:00:00.000Z', ...rest, id };
}

function item(entry: Partial<ArtifactIndexEntry>, artifact: Artifact): ArtifactItem {
  // 与 `buildIndexEntry` 产出的必填字段对齐（rev / updatedBy / deletedAt / version）
  const base: ArtifactIndexEntry = {
    id: artifact.id,
    sessionId: 's1',
    type: artifact.type,
    contentHash: artifactContentHash(artifact),
    createdAt: artifact.createdAt,
    rev: 0,
    updatedAt: '',
    updatedBy: '',
    deletedAt: null,
    version: 1,
  };
  return {
    entry: {
      ...base,
      // 与 `buildIndexEntry` 一致：有标题就带上，没有就不写这个键
      ...(artifact.title !== undefined ? { title: artifact.title } : {}),
      ...entry,
    },
    artifact,
  };
}

describe('artifactContentHash', () => {
  it('文本类按 content 寻址', () => {
    expect(artifactContentHash(art({ id: 'a', content: 'hello' }))).toBe(
      artifactContentHash(art({ id: 'b', content: 'hello' })),
    );
    expect(artifactContentHash(art({ id: 'a', content: 'hello' }))).not.toBe(
      artifactContentHash(art({ id: 'a', content: 'hello2' })),
    );
  });

  it('外链类 content 为空时按 url 寻址（否则所有图片会被判为重复）', () => {
    const imgA = art({ id: 'a', type: 'image', content: '', url: 'https://x/1.png' });
    const imgB = art({ id: 'b', type: 'image', content: '', url: 'https://x/2.png' });
    const imgA2 = art({ id: 'c', type: 'image', content: '', url: 'https://x/1.png' });
    expect(artifactContentHash(imgA)).not.toBe(artifactContentHash(imgB));
    expect(artifactContentHash(imgA)).toBe(artifactContentHash(imgA2));
  });
});

describe('buildIndexEntry', () => {
  it('带上 sessionId / messageId / contentHash', () => {
    const a = art({ id: 'a1', type: 'html', title: '周报', content: '<b>x</b>' });
    const e = buildIndexEntry('s9', 'm9', a);
    expect(e).toMatchObject({
      id: 'a1',
      sessionId: 's9',
      messageId: 'm9',
      type: 'html',
      title: '周报',
      contentHash: artifactContentHash(a),
    });
  });

  it('无 title 时不写 title 键（避免落盘出现 undefined）', () => {
    const e = buildIndexEntry('s9', 'm9', art({ id: 'a1', content: 'x' }));
    expect('title' in e).toBe(false);
  });
});

describe('matchesKeyword', () => {
  const target = item({}, art({ id: 'a', title: '销售周报', content: 'console.log(1)', language: 'ts' }));

  it('命中标题 / 内容 / 语言任一', () => {
    expect(matchesKeyword(target, '周报')).toBe(true);
    expect(matchesKeyword(target, 'console')).toBe(true);
    expect(matchesKeyword(target, 'ts')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(matchesKeyword(target, 'CONSOLE')).toBe(true);
  });

  it('空关键词放行全部', () => {
    expect(matchesKeyword(target, '   ')).toBe(true);
  });

  it('不命中则排除', () => {
    expect(matchesKeyword(target, '不存在的词')).toBe(false);
  });
});

describe('filterItems', () => {
  const items = [
    item({ type: 'code', id: 'a' }, art({ id: 'a', type: 'code', content: 'fn a' })),
    item({ type: 'html', id: 'b' }, art({ id: 'b', type: 'html', content: '<i>b</i>' })),
  ];

  it('不传条件原样返回', () => {
    expect(filterItems(items, {})).toHaveLength(2);
  });

  it('按类型筛', () => {
    expect(filterItems(items, { types: ['html'] }).map((i) => i.entry.id)).toEqual(['b']);
  });

  it('类型与关键词同时生效', () => {
    expect(filterItems(items, { types: ['code'], keyword: 'fn' })).toHaveLength(1);
    expect(filterItems(items, { types: ['html'], keyword: 'fn' })).toHaveLength(0);
  });
});

describe('hasVersionHistory / editedOnly（FR-7.4 接入全局检索）', () => {
  it('无 versions 或只有一版 → 视为单版（不显示编辑标记）', () => {
    expect(hasVersionHistory(item({}, art({ id: 'a', content: 'x' })).entry)).toBe(false);
    expect(hasVersionHistory(item({ versions: [{ version: 1, contentHash: 'sha256:1', createdAt: 't' }] }, art({ id: 'a', content: 'x' })).entry)).toBe(false);
  });

  it('versions 长度 > 1 → 有版本历史', () => {
    const entry = item(
      { versions: [
        { version: 1, contentHash: 'sha256:1', createdAt: 't' },
        { version: 2, contentHash: 'sha256:2', createdAt: 't' },
      ] },
      art({ id: 'a', content: 'x' }),
    ).entry;
    expect(hasVersionHistory(entry)).toBe(true);
  });

  it('editedOnly 只留有多版本历史的产物', () => {
    const single = item({ id: 'a' }, art({ id: 'a', content: 'one' }));
    const multi = item(
      { id: 'b', versions: [
        { version: 1, contentHash: 'sha256:1', createdAt: 't' },
        { version: 2, contentHash: 'sha256:2', createdAt: 't' },
      ] },
      art({ id: 'b', content: 'two' }),
    );
    const out = filterItems([single, multi], { editedOnly: true });
    expect(out.map((i) => i.entry.id)).toEqual(['b']);

    // 关掉开关 → 两条都在
    expect(filterItems([single, multi], { editedOnly: false })).toHaveLength(2);
  });
});

describe('groupByHash（跨会话折叠）', () => {
  it('同内容聚成一组，组内按 createdAt 升序', () => {
    const shared = art({ id: 'x1', content: 'same' });
    const shared2 = art({ id: 'x2', content: 'same', createdAt: '2026-09-20T00:00:00.000Z' });
    const other = art({ id: 'y', content: 'other' });
    const groups = groupByHash([
      item({ sessionId: 's2' }, shared),
      item({ sessionId: 's1' }, shared2),
      item({ sessionId: 's1' }, other),
    ]);
    expect(groups).toHaveLength(2);
    const sharedGroup = groups.find((g) => g.items.length === 2)!;
    expect(sharedGroup.items.map((i) => i.entry.sessionId)).toEqual(['s1', 's2']);
  });
});

describe('sortGroups', () => {
  const g = (hash: string, times: string[]) => ({
    contentHash: hash,
    items: times.map((t, i) => item({ id: `${hash}-${i}`, createdAt: t }, art({ id: `${hash}-${i}`, content: hash }))),
  });
  const a = g('a', ['2026-09-01T00:00:00.000Z', '2026-09-10T00:00:00.000Z']);
  const b = g('b', ['2026-09-25T00:00:00.000Z']);

  it('newest：组内最新时间大的在前', () => {
    expect(sortGroups([a, b], 'newest').map((x) => x.contentHash)).toEqual(['b', 'a']);
  });

  it('oldest：反过来', () => {
    expect(sortGroups([a, b], 'oldest').map((x) => x.contentHash)).toEqual(['a', 'b']);
  });
});
