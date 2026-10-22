/**
 * 专家包的文件落盘与读回（FR-3.3）。
 *
 * 平台差异**全部吃掉**在这里，组件只处理结果对象：
 * - Electron：`platform.writeTextFile` 把相对路径解析到 `~/.nanowork/`（用户可见）；
 * - Web：同一次调用降级为浏览器下载（`storage.web.ts` 的实现）。
 *
 * 因此**不新增任何平台能力、不碰 `electron/`**（也就不需要重建 `main.cjs`）。
 * 与「导出账户归档」走同一条通道（`AccountSection`），两处行为一致，用户不会
 * 遇到「一种导出弹下载、另一种导出没反应」。
 */

import { platform } from '@/platform';
import type { Agent } from '@/types';
import type { ExpertPackage } from '@/types/expertPackage';
import {
  buildExpertPackage,
  expertPackageFileName,
  parseExpertPackage,
  serializeExpertPackage,
} from './expertPackage';

export interface ExpertPackageExportResult {
  ok: boolean;
  /** 非致命问题（头像超限被剔除等）。**必须展示**，否则用户以为头像跟着走了 */
  warnings: string[];
  /** 落点描述（文件名）；失败时为空串 */
  fileName: string;
  error?: string;
}

/**
 * 把一位专家写成专家包文件。
 *
 * 不抛错：返回值带 `error`。导出是个「用户点了按钮」的动作，异常冒到 React 里
 * 只会变成一个白屏，而在 toast 里说「写不进去，可能是目录不可写」才有用。
 */
export async function exportExpertPackageFile(
  agent: Agent,
  skillNameOf: (id: string) => string,
  opts?: { version?: string; description?: string },
): Promise<ExpertPackageExportResult> {
  const { pkg, warnings } = buildExpertPackage(agent, skillNameOf, opts);
  const fileName = expertPackageFileName(agent.name);
  try {
    await platform.writeTextFile(fileName, serializeExpertPackage(pkg));
    return { ok: true, warnings, fileName };
  } catch (err) {
    return {
      ok: false,
      warnings,
      fileName: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ExpertPackageReadResult {
  ok: boolean;
  /** 用户取消选择 —— 与「文件坏了」必须区分：取消不该报错 */
  canceled?: boolean;
  warnings: string[];
  error?: string;
  pkg?: ExpertPackage;
  fileName?: string;
}

/**
 * 弹窗选一个专家包并解析。
 *
 * 取消走 `canceled`，解析失败走 `error` + 分类文案（由 `parseExpertPackage` 给）：
 * 「你取消了」和「这个文件不是专家包」对用户意味着完全不同的下一步动作。
 */
export async function readExpertPackageFile(): Promise<ExpertPackageReadResult> {
  let picked: { name: string; content: string } | null = null;
  try {
    picked = await platform.pickFile();
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!picked) return { ok: false, canceled: true, warnings: [] };

  const parsed = parseExpertPackage(picked.content);
  if (!parsed.ok) {
    return { ok: false, warnings: [], error: parsed.error, fileName: picked.name };
  }
  return {
    ok: true,
    warnings: parsed.warnings,
    pkg: parsed.pkg,
    fileName: picked.name,
  };
}
