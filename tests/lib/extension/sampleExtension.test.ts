/**
 * 样例扩展（`examples/extensions/hello-world`）本身是"活文档"，这份用例守着它别写坏。
 *
 * 三条都对应"错了不报错"：
 *
 * 1. **bizType 前缀**：本项目只认 `ext:` / `lang:` / `type:`（见
 *    `lib/extension/artifactPreview.ts`）。样例里写成 `nanowork/hello` 这种
 *    WorkBuddy 风格的值，清单照样能加载、卡片照样显示「N 个预览器」，但**永远不会被匹配到**
 *    —— 用户会以为扩展没生效。
 * 2. **声明指向的文件真实存在**：`url: './ui/preview.html'` 少一个文件就是打开即 404，
 *    而协议层只会回一句没有信息量的 Not Found。
 * 3. **id 与目录名一致**：协议 host 与目录名必须同一份事实。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExtensionManifest } from '../../../electron/extensionPackage';

const ROOT = join(process.cwd(), 'examples', 'extensions', 'hello-world');

function loadManifest() {
  const text = readFileSync(join(ROOT, 'extension.json'), 'utf8');
  return parseExtensionManifest(text, { dirName: 'hello-world', source: 'user' });
}

describe('hello-world 样例扩展', () => {
  it('清单可解析且 id 与目录名一致', () => {
    const { manifest, issues } = loadManifest();
    expect(issues).toEqual([]);
    expect(manifest?.id).toBe('hello-world');
  });

  it('⭐ 预览器的 bizType 必须是本项目认的三种前缀之一', () => {
    const { manifest } = loadManifest();
    const previews = manifest?.ui?.artifactPreviews ?? [];
    expect(previews.length).toBeGreaterThan(0);

    for (const preview of previews) {
      expect(
        /^(ext|lang|type):.+$/.test(preview.match.bizType),
        `bizType「${preview.match.bizType}」不是 ext:/lang:/type: 前缀，永远不会被匹配到`,
      ).toBe(true);
    }
  });

  it('所有声明指向的文件真实存在', () => {
    const { manifest } = loadManifest();
    const rels = [
      manifest?.ui?.entry?.url,
      ...(manifest?.ui?.artifactPreviews ?? []).map((p) => p.url),
      manifest?.service?.entry,
    ].filter((rel): rel is string => typeof rel === 'string' && !/^https?:/i.test(rel));

    expect(rels.length).toBeGreaterThanOrEqual(3);
    for (const rel of rels) {
      const abs = join(ROOT, rel.replace(/^\.\//, ''));
      expect(existsSync(abs), `清单声明的 ${rel} 不存在`).toBe(true);
    }
  });

  it('后台服务入口是 js 且能被校验通过', () => {
    const { manifest } = loadManifest();
    expect(manifest?.service?.process).toBe('fork');
    expect(manifest?.service?.entry).toMatch(/\.cjs$/);
  });

  it('settings 的 target 指向本项目真实存在的设置分区', () => {
    const { manifest } = loadManifest();
    const targets = (manifest?.ui?.settings ?? []).map((s) => s.target);
    expect(targets.length).toBeGreaterThan(0);
    // 与 `settingsUiStore.SETTINGS_SECTION_IDS` 对齐：样例写了不存在的分区，
    // 条目会掉进「扩展」汇总页而不是目标分区——能看见但位置不对，容易被误解成 bug。
    for (const target of targets) {
      expect(['data', 'general', 'plugins', 'extensions']).toContain(target);
    }
  });
});
