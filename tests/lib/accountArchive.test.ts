/**
 * 账户归档纯函数单测（批次 6a §2.4，判据 J-C1~C4）。
 *
 * 锁四条容易做错、且做错的后果不直观的行为：
 * - **J-C1 往返无损**：`local` 段若「解析再序列化」，键顺序 / 空白 / 转义会变化，
 *   逐字节比对即红——这是「归档可重新导入」承诺的基石；
 * - **J-C2 非法输入被拒**：不返回半个归档（否则导入会写坏一半存储）；
 * - **J-C3 版本更高时拒绝**：老客户端不能静默丢字段；
 * - **J-C4 云端段可缺省**：离线导出的 `cloud: null` 仍可解析。
 */

import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  ArchiveParseError,
  applyArchive,
  archiveFileName,
  buildArchive,
  parseArchive,
} from '@/lib/accountArchive';
import type { NanoworkArchive } from '@/lib/accountArchive';

/** 一段带换行与 CJK 的文本 + 一段 JSON 文本——两类最容易在往返中变形的值。 */
const LOCAL: Record<string, string> = {
  'nanowork.settings': JSON.stringify({ theme: 'dark', models: ['a', 'b'] }),
  'nanowork.identity.soul': '第一行\n第二行\t带制表符\n\n 末尾有空格 ',
  'nanowork.userMemory': '# 记忆\n\n- 喜欢简洁\n- 中文与 emoji 🙂',
  'nanowork.agents': '{"items":[{"id":"x","name":"专家 A"}]}',
};

function baseArchive(overrides: Partial<NanoworkArchive> = {}): NanoworkArchive {
  return buildArchive(
    {
      local: LOCAL,
      sessionsMeta: [],
      sessionEvents: {},
      cloud: null,
    },
    { exportedAt: '2026-09-28T12:00:00.000Z', deviceId: 'dev-1', account: null },
  );
}

describe('J-C1：往返无损（逐字节相同）', () => {
  it('buildArchive → JSON.stringify → parseArchive → applyArchive 后每个 key 与原始相同', async () => {
    const archive = baseArchive();
    const text = JSON.stringify(archive);
    const parsed = parseArchive(text);

    const written: Record<string, string> = {};
    const report = await applyArchive(parsed, async (key, value) => {
      written[key] = value;
    });

    expect(report.written).toBe(Object.keys(LOCAL).length);
    expect(report.keys.sort()).toEqual(Object.keys(LOCAL).sort());
    for (const key of Object.keys(LOCAL)) {
      // 逐字节：字符串完全相等（含换行 / 制表符 / CJK / 空白）
      expect(written[key]).toBe(LOCAL[key]);
    }
  });

  it('顶层元信息在往返后保持', () => {
    const parsed = parseArchive(JSON.stringify(baseArchive()));
    expect(parsed.format).toBe(ARCHIVE_FORMAT);
    expect(parsed.formatVersion).toBe(ARCHIVE_FORMAT_VERSION);
    expect(parsed.exportedAt).toBe('2026-09-28T12:00:00.000Z');
    expect(parsed.deviceId).toBe('dev-1');
  });
});

describe('J-C2：非法输入被拒（不返回半个归档）', () => {
  it('非 JSON', () => {
    expect(() => parseArchive('not json')).toThrow(ArchiveParseError);
  });

  it('空对象（缺 format）', () => {
    expect(() => parseArchive('{}')).toThrow(ArchiveParseError);
  });

  it('format 不对', () => {
    const wrong = JSON.stringify({ ...baseArchive(), format: 'something-else' });
    expect(() => parseArchive(wrong)).toThrow(ArchiveParseError);
  });

  it('local 段的值不是字符串', () => {
    const bad = JSON.stringify({ ...baseArchive(), local: { k: 123 } });
    expect(() => parseArchive(bad)).toThrow(ArchiveParseError);
  });
});

describe('J-C3：formatVersion 高于本端时拒绝', () => {
  it('更高的版本号抛错', () => {
    const future = JSON.stringify({
      ...baseArchive(),
      formatVersion: ARCHIVE_FORMAT_VERSION + 1,
    });
    expect(() => parseArchive(future)).toThrow(ArchiveParseError);
  });

  it('formatVersion 缺失 / 非法也抛错', () => {
    expect(() => parseArchive(JSON.stringify({ ...baseArchive(), formatVersion: 'x' }))).toThrow(
      ArchiveParseError,
    );
  });
});

describe('J-C4：云端段可缺省（未登录也能导出）', () => {
  it('cloud: null 仍可解析', () => {
    const parsed = parseArchive(JSON.stringify(baseArchive()));
    expect(parsed.cloud).toBeNull();
  });

  it('cloud 字段缺失仍可解析', () => {
    const archive = baseArchive();
    const { cloud: _omitted, ...withoutCloud } = archive;
    const parsed = parseArchive(JSON.stringify(withoutCloud));
    expect(parsed.cloud).toBeNull();
  });
});

describe('archiveFileName：文件名格式', () => {
  it('nanowork-export-YYYYMMDD-HHmmss.json', () => {
    const name = archiveFileName(new Date(2026, 8, 28, 9, 5, 3));
    expect(name).toBe('nanowork-export-20260928-090503.json');
  });
});
