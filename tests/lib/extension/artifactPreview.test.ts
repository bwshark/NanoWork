/**
 * 产物 ↔ 扩展预览器的匹配（`src/lib/extension/artifactPreview.ts`）。
 *
 * 匹配错了不会报错，只会表现成"点了按钮打开的不是我以为的那个扩展"或者
 * "一个贪心扩展把所有文件产物都抢走"。所以这里钉的是**优先级**与**扩展名解析**：
 *
 * 1. `ext:pdf` 必须优先于 `type:file`（越具体越先问）；
 * 2. 扩展名只取路径最后一段的最后一个点（`C:\a.b\report` 的扩展名不是 `b`）；
 * 3. `v1.2.3.4` 这类文件名不产生扩展名（否则会匹配到 `ext:4`）；
 * 4. 同一档里有多个扩展认领时，取扫描顺序的第一个（可复现）。
 */

import { describe, expect, it } from 'vitest';
import {
  artifactBizTypes,
  artifactExtension,
  listArtifactPreviewers,
  matchArtifactPreview,
} from '@/lib/extension/artifactPreview';
import type { Artifact } from '@/types';
import type { InstalledExtension } from '@/types/extension';

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: 'a1',
    type: 'file',
    content: 'hello',
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

function extension(id: string, name: string, bizTypes: string[]): InstalledExtension {
  return {
    manifest: {
      id,
      name,
      version: '0.0.1',
      description: '',
      source: 'user',
      permissions: [],
      ui: {
        artifactPreviews: bizTypes.map((bizType) => ({
          id: `${id}-${bizType}`,
          label: `${name} 预览`,
          match: { bizType },
          url: './ui/preview.html',
        })),
      },
    },
    root: `/extensions/${id}`,
    issues: [],
  };
}

describe('artifactExtension', () => {
  it('从路径取最后一段的扩展名（小写）', () => {
    expect(artifactExtension({ path: 'C:\\docs\\Report.PDF' })).toBe('pdf');
    expect(artifactExtension({ path: '/tmp/a/b/data.csv' })).toBe('csv');
  });

  it('目录名里的点不算扩展名', () => {
    expect(artifactExtension({ path: 'C:\\a.b\\report' })).toBeNull();
  });

  it('版本号式的文件名不产生扩展名（否则会匹配到 ext:4）', () => {
    expect(artifactExtension({ path: '/tmp/v1.2.3.4' })).toBeNull();
  });

  it('没有路径时退到标题', () => {
    expect(artifactExtension({ title: 'notes.md' })).toBe('md');
  });

  it('取不到就返回 null（不猜）', () => {
    expect(artifactExtension({})).toBeNull();
  });
});

describe('artifactBizTypes', () => {
  it('候选按具体程度排序：ext → lang → type', () => {
    const types = artifactBizTypes(
      artifact({ type: 'file', path: '/tmp/report.pdf', language: 'text' }),
    );
    expect(types).toEqual(['ext:pdf', 'lang:text', 'type:file']);
  });

  it('缺字段时跳过对应候选', () => {
    expect(artifactBizTypes(artifact({ type: 'markdown' }))).toEqual(['type:markdown']);
  });
});

describe('matchArtifactPreview', () => {
  it('⭐ ext 匹配优先于 type 匹配（贪心扩展不能抢走所有文件）', () => {
    const greedy = extension('greedy', '贪心扩展', ['type:file']);
    const precise = extension('precise', 'PDF 预览', ['ext:pdf']);

    // 贪心扩展排在前面，但 ext:pdf 更具体，必须赢
    const hit = matchArtifactPreview(artifact({ path: '/tmp/a.pdf' }), [greedy, precise]);
    expect(hit?.extension.manifest.id).toBe('precise');
    expect(hit?.matchedBizType).toBe('ext:pdf');
  });

  it('只有 type 匹配时才用 type', () => {
    const greedy = extension('greedy', '贪心扩展', ['type:file']);
    const hit = matchArtifactPreview(artifact({ path: '/tmp/a.pdf' }), [greedy]);
    expect(hit?.extension.manifest.id).toBe('greedy');
  });

  it('同一档多个扩展认领时取扫描顺序第一个（可复现）', () => {
    const a = extension('a-ext', 'A', ['ext:pdf']);
    const b = extension('b-ext', 'B', ['ext:pdf']);
    expect(matchArtifactPreview(artifact({ path: '/x.pdf' }), [a, b])?.extension.manifest.id).toBe(
      'a-ext',
    );
  });

  it('没有扩展或没有预览器时返回 null', () => {
    expect(matchArtifactPreview(artifact({ path: '/x.pdf' }), [])).toBeNull();
    expect(
      matchArtifactPreview(artifact({ path: '/x.pdf' }), [extension('no-pv', '无预览', [])]),
    ).toBeNull();
  });

  it('lang 兜底：扩展可以按高亮语言认领', () => {
    const byLang = extension('py', 'Python 预览', ['lang:python']);
    const hit = matchArtifactPreview(artifact({ type: 'code', language: 'python' }), [byLang]);
    expect(hit?.matchedBizType).toBe('lang:python');
  });

  it('markdown 也能被显式认领（type:markdown）', () => {
    const byType = extension('md', 'Markdown 增强', ['type:markdown']);
    const hit = matchArtifactPreview(artifact({ type: 'markdown' }), [byType]);
    expect(hit?.extension.manifest.id).toBe('md');
  });
});

describe('listArtifactPreviewers', () => {
  it('列出全部预览器（不判是否匹配当前产物）', () => {
    const list = listArtifactPreviewers([
      extension('a', 'A', ['ext:pdf', 'ext:docx']),
      extension('b', 'B', []),
    ]);
    expect(list).toHaveLength(2);
    expect(list.map((x) => x.extension.manifest.id)).toEqual(['a', 'a']);
  });

  it('⭐ 代码块产物（没有文件名）匹配不到 ext，但仍能手动选择', () => {
    // 模型直接吐一段日志时产物长这样：type=code、标题是「代码块 (text) 1」，
    // 没有 path 也没有带扩展名的 title —— 任何 ext: 声明都不可能命中。
    const code = artifact({ type: 'code', title: '代码块 (text) 1', language: 'text' });
    const logExt = extension('hello', 'Hello 扩展', ['ext:log']);

    expect(matchArtifactPreview(code, [logExt])).toBeNull();
    // 入口仍然要给（否则用户以为扩展没装上）
    expect(listArtifactPreviewers([logExt])).toHaveLength(1);
  });
});
