/**
 * 示例扩展的安装（`examples/extensions/hello-world` → `~/.nanowork/extensions/`）。
 *
 * ## 为什么需要这个按钮
 *
 * 扩展能力的第一道门槛是"得先有一个扩展"。让用户自己去仓库里找目录、复制、
 * 改路径、回来点重新扫描——四步里任何一步没做对，界面就表现为"功能好像没生效"，
 * 而用户无从判断卡在哪一步。一个按钮把这段路径压成一次点击。
 *
 * ## 样例从哪来
 *
 * - **打包态**：`extraResources` 把 `examples/extensions` 放到 `process.resourcesPath`
 *   下面（不进 asar —— asar 是只读虚拟文件系统，`copyFile` 从里面复制不可靠）；
 * - **开发态**：仓库里的 `examples/extensions/hello-world`。
 *
 * 两条路都找不到时**如实报错**，不静默失败。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** 示例扩展的目录名（= 清单里的 id，id 必须等于目录名） */
export const SAMPLE_EXTENSION_DIR = 'hello-world';

/** 打包态：`<resources>/extensions-samples/hello-world` */
function packagedSampleDir(): string | null {
  const resourcesPath = process.resourcesPath;
  if (!resourcesPath) return null;
  const dir = join(resourcesPath, 'extensions-samples', SAMPLE_EXTENSION_DIR);
  return existsSync(dir) ? dir : null;
}

/** 开发态：仓库里的 `examples/extensions/hello-world` */
function devSampleDir(): string | null {
  try {
    const dir = join(app.getAppPath(), 'examples', 'extensions', SAMPLE_EXTENSION_DIR);
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** 找到示例扩展的源目录；找不到返回 null */
export function findSampleExtensionDir(): string | null {
  return packagedSampleDir() ?? devSampleDir();
}

/** 递归复制一个目录（`fs.cp` 在 Node 16.7+ 才有，Electron 自带的新版本可用） */
async function copyDir(from: string, to: string): Promise<void> {
  await fs.cp(from, to, { recursive: true, force: true });
}

/**
 * 安装示例扩展。
 *
 * @param extensionsRoot 扩展根目录（`~/.nanowork/extensions`）
 * @param overwrite 已存在同名扩展时是否覆盖（默认 false：不覆盖用户改过的版本）
 */
export async function installSampleExtension(
  extensionsRoot: string,
  overwrite = false,
): Promise<{ ok: boolean; error?: string; path?: string }> {
  const source = findSampleExtensionDir();
  if (!source) {
    return {
      ok: false,
      error:
        '找不到示例扩展（打包后应在 resources/extensions-samples 下，开发态应在 examples/extensions 下）',
    };
  }

  const target = join(extensionsRoot, SAMPLE_EXTENSION_DIR);
  if (existsSync(target) && !overwrite) {
    return { ok: true, path: target };
  }

  try {
    await fs.mkdir(extensionsRoot, { recursive: true });
    // 先删后拷：直接覆盖会留下旧版本残留文件（改过名的文件不会被清理）
    await fs.rm(target, { recursive: true, force: true });
    await copyDir(source, target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
