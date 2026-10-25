import { describe, expect, it } from 'vitest';
import {
  badgeForFileName,
  changeCountOf,
  deletedFilePathFrom,
  deriveFileArtifacts,
  fileArtifactId,
  fileBaseName,
  fileExtension,
  findFileArtifact,
  formatBytes,
  isFileArtifact,
  languageForFileName,
  normalizeFilePath,
  summarizeFiles,
  toFileViews,
  toneForFileName,
} from '@/lib/artifact/fileArtifact';
import { buildIndexEntry } from '@/lib/artifact/artifactIndex';
import type { Artifact, ArtifactIndexEntry } from '@/types';

function art(over: Partial<Artifact> & { id: string }): Artifact {
  const { id, ...rest } = over;
  return { type: 'code', content: 'x', createdAt: '2026-09-29T00:00:00.000Z', ...rest, id };
}

function fileArt(id: string, path: string, over: Partial<Artifact> = {}): Artifact {
  return art({ id, type: 'file', title: fileBaseName(path), path, ...over });
}

describe('路径工具', () => {
  it('归一化分隔符 / 前导 ./ / 尾部斜杠，不动大小写与 ../（合并错文件比多一条卡片更难查）', () => {
    expect(normalizeFilePath('D:\\aa\\tetris.html')).toBe('D:/aa/tetris.html');
    expect(normalizeFilePath('  /tmp/a/b/  ')).toBe('/tmp/a/b');
    expect(normalizeFilePath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeFilePath('././src/a.ts')).toBe('src/a.ts');
    expect(normalizeFilePath('../src/a.ts')).toBe('../src/a.ts');
    expect(normalizeFilePath('C:/A.txt')).toBe('C:/A.txt');
    expect(normalizeFilePath('/')).toBe('/');
  });

  it('取文件名与扩展名', () => {
    expect(fileBaseName('D:/aa/tetris.html')).toBe('tetris.html');
    expect(fileBaseName('plain')).toBe('plain');
    expect(fileExtension('a/b/README.md')).toBe('md');
    expect(fileExtension('Makefile')).toBe('');
    expect(fileExtension('archive.tar.gz')).toBe('gz');
  });

  it('会话 + 路径共同决定身份：同会话同路径稳定，换会话则不同', () => {
    const a = fileArtifactId('s1', 'D:\\aa\\x.ts');
    expect(a).toBe(fileArtifactId('s1', 'D:/aa/x.ts')); // 分隔符归一后同 id
    expect(a).not.toBe(fileArtifactId('s2', 'D:/aa/x.ts')); // 跨会话各记一条
    expect(a).not.toBe(fileArtifactId('s1', 'D:/aa/y.ts'));
    expect(a.startsWith('file-')).toBe(true);
  });

  it('语言 / 角标 / 色调按扩展名推断', () => {
    expect(languageForFileName('a.tsx')).toBe('tsx');
    expect(languageForFileName('README.md')).toBe('markdown');
    expect(languageForFileName('unknown.zzz')).toBeUndefined();
    expect(badgeForFileName('a.ts')).toBe('TS');
    expect(badgeForFileName('noext')).toBe('·');
    expect(toneForFileName('a.json')).toBe('data');
    expect(toneForFileName('a.py')).toBe('python');
    expect(toneForFileName('a.zzz')).toBe('other');
  });

  it('体积格式化：B / KB / MB，未知返回空串', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2355)).toBe('2.3 KB');
    expect(formatBytes(20 * 1024)).toBe('20 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(undefined)).toBe('');
  });
});

describe('deriveFileArtifacts：工具调用 → 文件产物草稿', () => {
  it('write_file：带正文、体积（UTF-8 字节长）与推断语言', () => {
    const drafts = deriveFileArtifacts(
      'write_file',
      { path: 'D:\\aa\\tetris.html', content: '<html>中文</html>' },
      'call-1',
    );
    expect(drafts).toEqual([
      {
        path: 'D:/aa/tetris.html',
        name: 'tetris.html',
        content: '<html>中文</html>',
        size: new TextEncoder().encode('<html>中文</html>').length,
        language: 'html',
        op: 'write',
      },
    ]);
  });

  it('write_file：新建空文件是合法产出（体积 0），但缺正文参数则不算', () => {
    const empty = deriveFileArtifacts('write_file', { path: 'a/empty.txt', content: '' }, 'c');
    expect(empty[0]?.size).toBe(0);
    expect(deriveFileArtifacts('write_file', { path: 'a/x.txt' }, 'c')).toEqual([]);
    expect(deriveFileArtifacts('write_file', { content: 'x' }, 'c')).toEqual([]);
  });

  it('write_file：append=true 是分块续写 → 按改写记录，不把这一块当全文', () => {
    const drafts = deriveFileArtifacts(
      'write_file',
      { path: 'big.log', content: 'chunk-2', append: true },
      'call-9',
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      path: 'big.log',
      content: '',
      op: 'edit',
      fingerprint: 'call-9',
    });
    // 这一块的长度不是文件体积，故不给 size
    expect(drafts[0].size).toBeUndefined();
  });

  it('edit_file：只记路径与变更指纹，不给体积', () => {
    const drafts = deriveFileArtifacts(
      'edit_file',
      { path: 'D:/aa/tetris.html', old_text: 'a', new_text: 'b' },
      'call-7',
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      path: 'D:/aa/tetris.html',
      op: 'edit',
      fingerprint: 'call-7',
    });
    expect(drafts[0].content).toBe('');
    expect(drafts[0].size).toBeUndefined();
  });

  it('edit 作为历史别名同样识别', () => {
    expect(deriveFileArtifacts('edit', { file_path: 'a/b.ts' }, 'c')[0]).toMatchObject({
      path: 'a/b.ts',
      op: 'edit',
    });
  });

  it('apply_patch：按 edits[] 逐个文件；add=写入，replace=改写', () => {
    const drafts = deriveFileArtifacts(
      'apply_patch',
      {
        edits: [
          { path: 'src/new.ts', action: 'add', new_text: '+x' },
          { path: 'src/old.ts', action: 'replace', old_text: 'a', new_text: 'b' },
          { path: 'src\\win.ts', action: 'replace', old_text: 'a', new_text: 'b' },
        ],
      },
      'call-1',
    );
    expect(drafts.map((d) => [d.path, d.op])).toEqual([
      ['src/new.ts', 'write'],
      ['src/old.ts', 'edit'],
      ['src/win.ts', 'edit'],
    ]);
  });

  it('apply_patch：同一文件多条编辑合并为一条；dry_run 不产出；畸形条目跳过', () => {
    const merged = deriveFileArtifacts(
      'apply_patch',
      {
        edits: [
          { path: 'a.ts', action: 'replace' },
          { path: './a.ts', action: 'replace' },
          { path: 'b.ts', action: 'replace' },
          { path: 'b.ts', action: 'add' },
        ],
      },
      'c',
    );
    expect(merged.map((d) => [d.path, d.op])).toEqual([
      ['a.ts', 'edit'],
      ['b.ts', 'write'], // 同路径出现 add → 按新增算
    ]);

    expect(
      deriveFileArtifacts('apply_patch', { edits: [{ path: 'a.ts', action: 'add' }], dry_run: true }, 'c'),
    ).toEqual([]);
    expect(deriveFileArtifacts('apply_patch', { edits: [null, 42, {}] }, 'c')).toEqual([]);
    expect(deriveFileArtifacts('apply_patch', {}, 'c')).toEqual([]);
  });

  it('只读工具与未知工具一律不产出', () => {
    for (const tool of ['read_file', 'grep', 'exec', 'delete_file', 'mcp__x__y']) {
      expect(deriveFileArtifacts(tool, { path: 'a.txt', content: 'x' }, 'c')).toEqual([]);
    }
  });
});

describe('deletedFilePathFrom：删除类工具的目标路径', () => {
  it('delete_file 的 path / file_path 都认（引擎两种叫法都出现过）', () => {
    expect(deletedFilePathFrom('delete_file', { path: 'D:/aa/x.ts' })).toBe('D:/aa/x.ts');
    expect(deletedFilePathFrom('delete_file', { file_path: 'D:/aa/x.ts' })).toBe('D:/aa/x.ts');
    expect(deletedFilePathFrom('remove_file', { path: 'D:/aa/x.ts' })).toBe('D:/aa/x.ts');
  });

  it('工具名大小写与空白归一后再匹配', () => {
    expect(deletedFilePathFrom('  Delete_File ', { path: 'a.txt' })).toBe('a.txt');
  });

  it('写类 / 只读工具一律不认（否则一次写入就会把产物误摘）', () => {
    for (const tool of ['write_file', 'edit_file', 'edit', 'apply_patch', 'read_file', 'exec']) {
      expect(deletedFilePathFrom(tool, { path: 'a.txt' })).toBeUndefined();
    }
  });

  it('缺路径 / 路径为空串时返回 undefined（调用方据此跳过）', () => {
    expect(deletedFilePathFrom('delete_file', {})).toBeUndefined();
    expect(deletedFilePathFrom('delete_file', { path: '   ' })).toBeUndefined();
    expect(deletedFilePathFrom('delete_file', { path: 42 })).toBeUndefined();
  });
});

describe('视图汇总', () => {
  it('isFileArtifact / findFileArtifact 按类型与路径识别', () => {
    const list = [art({ id: 'c1' }), fileArt('f1', 'D:/a/x.ts')];
    expect(list.map(isFileArtifact)).toEqual([false, true]);
    expect(findFileArtifact(list, 'D:\\a\\x.ts')?.id).toBe('f1');
    expect(findFileArtifact(list, 'D:/a/y.ts')).toBeUndefined();
  });

  it('changeCountOf：按版本链长度算，缺索引按 0', () => {
    const entry: ArtifactIndexEntry = {
      ...buildIndexEntry('s1', 'm1', art({ id: 'a1' })),
      version: 3,
      versions: [
        { version: 1, contentHash: 'sha256:1', createdAt: 't1' },
        { version: 2, contentHash: 'sha256:2', createdAt: 't2' },
        { version: 3, contentHash: 'sha256:3', createdAt: 't3' },
      ],
    };
    expect(changeCountOf(entry)).toBe(2);
    expect(changeCountOf(undefined)).toBe(0);
  });

  it('toFileViews 只留文件产物，并带出版本 / 变更次数', () => {
    const index: Record<string, ArtifactIndexEntry> = {
      f1: {
        ...buildIndexEntry('s1', 'm1', fileArt('f1', 'D:/a/x.ts', { content: 'v1' })),
        version: 2,
        versions: [
          { version: 1, contentHash: 'sha256:1', createdAt: 't1' },
          { version: 2, contentHash: 'sha256:2', createdAt: 't2' },
        ],
      },
    };
    const views = toFileViews([art({ id: 'c1' }), fileArt('f1', 'D:/a/x.ts')], index);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ version: 2, changes: 1, createdBySession: true });
  });

  it('summarizeFiles：产物数 / 被再次编辑过的文件数（都与面板列出的条数对齐）', () => {
    const summary = summarizeFiles([
      { artifact: fileArt('f1', 'a'), version: 1, changes: 0, createdBySession: true },
      { artifact: fileArt('f2', 'b'), version: 3, changes: 2, createdBySession: true },
    ]);
    expect(summary).toEqual({ fileCount: 2, changedFileCount: 1 });
  });
});