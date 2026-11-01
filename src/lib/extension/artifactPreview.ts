/**
 * 产物 ↔ 扩展预览器的匹配（`extension.json` 的 `ui.artifactPreviews`）。
 *
 * ## bizType 到底是什么
 *
 * WorkBuddy 里的 bizType 是**产品自定义类型标识**（`wb/app`、`workbuddy/browser-preview`），
 * 扩展按它接管某类内容的渲染。本项目的产物没有那套 bizType，只有
 * `type`（html / markdown / file / code …）与文件名，所以这里把 bizType 定义成
 * **三种可判定的前缀**，扩展写哪个都行：
 *
 * | 写法 | 匹配依据 | 例子 |
 * |---|---|---|
 * | `ext:<扩展名>` | 产物文件名后缀（小写，不含点） | `ext:pdf` / `ext:docx` |
 * | `lang:<语言>` | 产物上已推断出的高亮语言 | `lang:python` |
 * | `type:<产物类型>` | `Artifact.type` 的原值 | `type:markdown` |
 *
 * ## 为什么候选顺序是 ext → lang → type
 *
 * 越具体的越优先：同一个 `.pdf` 产物，`ext:pdf` 是"我就认这个格式"，
 * `type:file` 是"所有文件我都要"——后者一旦排前面，一个贪心的扩展会把
 * 所有文件产物都抢走。
 *
 * ## 为什么这一层**不**接管内置渲染
 *
 * 内置能渲染的（html / markdown / mermaid / 内联代码）保持原样，扩展只是产物面板上
 * **多出来的一个入口**。让扩展默认接管等于"装个扩展就能把产物面板改坏"，
 * 而用户没有任何手段判断是谁弄坏的。
 */

import type { Artifact } from '@/types';
import type { ExtensionArtifactPreview, InstalledExtension } from '@/types/extension';

/** 从产物标题 / 路径里取扩展名（小写、不含点）；取不到返回 null */
export function artifactExtension(artifact: Pick<Artifact, 'title' | 'path'>): string | null {
  const source = artifact.path ?? artifact.title ?? '';
  if (!source) return null;
  // 只看最后一段，避免把 `C:\a.b\c` 里的 `.b` 当成扩展名
  const base = source.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  // 两道判据：
  // - 太长 → 多半是文件名里的点（`v1.2.3.4` 的最后一段）；
  // - **纯数字** → 同上（`report.2026` 的 `2026` 不是扩展名）。`7z` 这种以数字开头的
  //   真实格式仍然放行，所以不能写成"首字符必须是字母"。
  if (!/^[a-z0-9]{1,10}$/.test(ext) || /^[0-9]+$/.test(ext)) return null;
  return ext;
}

/**
 * 一份产物可以匹配的 bizType 候选，**按具体程度排序**。
 *
 * 返回值只用于匹配，不给界面展示（界面展示的是扩展自己写的 label）。
 */
export function artifactBizTypes(artifact: Artifact): string[] {
  const candidates: string[] = [];
  const ext = artifactExtension(artifact);
  if (ext) candidates.push(`ext:${ext}`);
  if (artifact.language) candidates.push(`lang:${artifact.language.toLowerCase()}`);
  if (artifact.type) candidates.push(`type:${artifact.type}`);
  return candidates;
}

/** 一次命中的结果 */
export interface ArtifactPreviewMatch {
  extension: InstalledExtension;
  preview: ExtensionArtifactPreview;
  /** 命中的 bizType（排障与界面提示用） */
  matchedBizType: string;
}

/**
 * 找第一个能预览这份产物的扩展。
 *
 * 匹配顺序由**候选 bizType 的具体程度**决定（不是扩展的扫描顺序）：先问"有没有扩展
 * 认 `ext:pdf`"，再问"认 `lang:x`"，最后才问"认 `type:file`"。这样贪心扩展
 * 不会因为目录名排前面就抢走所有文件。
 *
 * 同一档里有多个扩展认领时，取扫描顺序的第一个（扫描已按名称排序 → 结果可复现）。
 */
export function matchArtifactPreview(
  artifact: Artifact,
  extensions: readonly InstalledExtension[],
): ArtifactPreviewMatch | null {
  if (extensions.length === 0) return null;
  const candidates = artifactBizTypes(artifact);
  if (candidates.length === 0) return null;

  for (const bizType of candidates) {
    for (const extension of extensions) {
      const preview = extension.manifest.ui?.artifactPreviews?.find(
        (item) => item.match.bizType === bizType,
      );
      if (preview) return { extension, preview, matchedBizType: bizType };
    }
  }
  return null;
}

/** 一个可用的预览器（与其所属扩展） */
export interface AvailablePreviewer {
  extension: InstalledExtension;
  preview: ExtensionArtifactPreview;
}

/**
 * 列出全部可用预览器（不判断是否匹配当前产物）。
 *
 * 为什么需要：产物不一定有文件名。**围栏代码块产物**（模型直接输出一段日志/CSV）
 * 只有 `type: 'code'` 与 `title: '代码块 (text) 1'`——没有扩展名，`ext:log` 再怎么
 * 写也匹配不上。这时正确做法不是让用户干瞪眼，而是把可选项摆出来让他自己挑：
 * 「我知道我这段是日志，用日志查看器打开」。
 */
export function listArtifactPreviewers(
  extensions: readonly InstalledExtension[],
): AvailablePreviewer[] {
  const out: AvailablePreviewer[] = [];
  for (const extension of extensions) {
    for (const preview of extension.manifest.ui?.artifactPreviews ?? []) {
      out.push({ extension, preview });
    }
  }
  return out;
}
