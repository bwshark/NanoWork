/**
 * 引擎运行时的首启引导（B1 打包方案的 P1）。
 *
 * ## 为什么必须有这一步
 *
 * 开发态，仓库根就躺着一份 `nanowork.config.json`；打包态**没有** —— 那份文件含凭据、
 * 被 `.gitignore` 忽略，安装包里只带一份脱敏的 `config.template.json`。
 *
 * 于是新装用户第一次启动时，如果没有这一步：
 *
 * - 引擎会按 `~/.nanobot/config.json` 的默认值跑，`agents.defaults.workspace` 落回
 *   `~/.nanobot/workspace` —— 用户数据散到别处，与应用的数据目录（userData）分家；
 * - 设置页的几个"写回 config"链路（渠道/模型/MCP/工具策略）拿到的是一个不存在的路径；
 * - 引擎升级后新增的配置字段永远不会出现在老用户的配置里（`extra="ignore"` 静默忽略）。
 *
 * ## 三条判据
 *
 * 1. **幂等**：重复启动零成本 —— 不复制、不重写已存在的配置。
 * 2. **只补不覆盖**：升级时按模板**深合并缺失键**，用户改过的值一个字都不动。
 * 3. **永不阻塞、永不弹窗**：失败只进日志与返回值，由自检报告负责呈现（与本仓库其它
 *    引擎链路同一哲学：引导失败不该让应用打不开）。
 *
 * @see docs/plan-packaging-and-release.md §2.4 / §3.5
 */

import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';

/** 模板里 workspace 的占位符（构建期由 `scripts/build-engine.mjs` 写入） */
export const WORKSPACE_PLACEHOLDER = '__NANOWORK_WORKSPACE__';

/** 引导需要在 userData 下准备的目录（相对 userData） */
export const BOOTSTRAP_DIRS = ['workspace', 'pyuser', 'tiktoken'] as const;

/** stamp 文件：记录"上次运行的引擎版本"，用来触发配置深合并 */
export const ENGINE_STAMP_FILE = 'engine.stamp';

export interface EngineBootstrapIO {
  exists(path: string): boolean;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface EngineBootstrapDeps {
  /** 运行时根：打包态 `<resources>/rt`，开发态项目根 */
  runtimeRoot: string;
  /** `app.getPath('userData')` */
  userData: string;
  /** 配置文件落点（与 `engineConfigPath()` 同源，不在这里另算） */
  configPath: string;
  /** 模板路径；不传则默认 `<runtimeRoot>/config.template.json` */
  templatePath?: string;
  now?: () => Date;
  io?: EngineBootstrapIO;
}

export interface EngineBootstrapResult {
  /** 本次是否新建了配置文件 */
  configCreated: boolean;
  configPath: string;
  workspacePath: string;
  /** 运行时清单里的引擎版本（读不到为 null） */
  engineVersion: string | null;
  buildId: string | null;
  /** 升级时补上的缺失键（点分路径），用于日志与排障 */
  mergedKeys: string[];
  /** 非致命问题（只进日志，不打断启动） */
  warnings: string[];
}

const defaultIO: EngineBootstrapIO = {
  exists: existsSync,
  readFile: (path) => fs.readFile(path, 'utf-8'),
  writeFile: async (path, data, options) => {
    await fs.writeFile(path, data, { encoding: 'utf-8', mode: options?.mode });
  },
  mkdir: async (path) => {
    await fs.mkdir(path, { recursive: true });
  },
};

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(raw: string): unknown {
  // 用户可能用记事本改过配置：BOM 会让 JSON.parse 直接抛错
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

/**
 * 把模板里**缺失**的键补进现有配置。
 *
 * - 只补不改：同名键一律保留用户值（包括显式写 null 的）。
 * - 数组整体视为叶子：模板新增的数组元素不追补（追补会在用户已删项时把它加回来）。
 * - `agents.defaults.workspace` 永远跳过：模板里那是占位符，合并进来就是脏数据。
 */
export function mergeMissingKeys(
  target: Json,
  template: Json,
  path = '',
  merged: string[] = [],
): string[] {
  for (const [key, templateValue] of Object.entries(template)) {
    const here = path ? `${path}.${key}` : key;
    if (here === 'agents.defaults.workspace') continue;
    if (templateValue === WORKSPACE_PLACEHOLDER) continue;

    const current = (target as Json)[key];
    if (current === undefined) {
      (target as Json)[key] = templateValue;
      merged.push(here);
      continue;
    }
    if (isPlainObject(current) && isPlainObject(templateValue)) {
      mergeMissingKeys(current, templateValue, here, merged);
    }
  }
  return merged;
}

/** 把模板里的占位符递归替换成真实值（数组与嵌套对象都要走） */
export function replacePlaceholder(node: unknown, value: string): unknown {
  if (node === WORKSPACE_PLACEHOLDER) return value;
  if (Array.isArray(node)) return node.map((item) => replacePlaceholder(item, value));
  if (isPlainObject(node)) {
    const out: Json = {};
    for (const [key, item] of Object.entries(node)) out[key] = replacePlaceholder(item, value);
    return out;
  }
  return node;
}

/**
 * 执行首启引导。**幂等**：配置已存在时不会重写它。
 */
export async function bootstrapEngineRuntime(
  deps: EngineBootstrapDeps,
): Promise<EngineBootstrapResult> {
  const io = deps.io ?? defaultIO;
  const now = deps.now ?? (() => new Date());
  const templatePath = deps.templatePath ?? join(deps.runtimeRoot, 'config.template.json');
  const manifestPath = join(deps.runtimeRoot, 'manifest.json');
  const stampPath = join(deps.userData, ENGINE_STAMP_FILE);
  const workspacePath = join(deps.userData, 'workspace');

  const result: EngineBootstrapResult = {
    configCreated: false,
    configPath: deps.configPath,
    workspacePath,
    engineVersion: null,
    buildId: null,
    mergedKeys: [],
    warnings: [],
  };

  // ① 可写目录：插件落点、分词缓存、工作区
  for (const dir of BOOTSTRAP_DIRS) {
    try {
      await io.mkdir(join(deps.userData, dir));
    } catch (error) {
      result.warnings.push(`创建目录失败 ${dir}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ② 运行时清单（读不到不是错误：开发态本来就没有）
  let manifest: { engineVersion?: string; buildId?: string } | null = null;
  if (io.exists(manifestPath)) {
    try {
      manifest = readJson(await io.readFile(manifestPath)) as {
        engineVersion?: string;
        buildId?: string;
      };
      result.engineVersion = manifest.engineVersion ?? null;
      result.buildId = manifest.buildId ?? null;
    } catch (error) {
      result.warnings.push(`manifest.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ③ 模板（打包态有；开发态没有）
  let template: Json | null = null;
  if (io.exists(templatePath)) {
    try {
      const parsed = readJson(await io.readFile(templatePath));
      template = isPlainObject(parsed) ? parsed : null;
      if (template === null) result.warnings.push('config.template.json 不是对象，已忽略');
    } catch (error) {
      result.warnings.push(`config.template.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const configExists = io.exists(deps.configPath);

  // ④ 首启生成（只在真的没有时）
  if (!configExists && template) {
    try {
      const initial = replacePlaceholder(template, workspacePath) as Json;
      await io.writeFile(deps.configPath, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
      result.configCreated = true;
    } catch (error) {
      result.warnings.push(`写入配置失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!configExists && !template) {
    // 开发态的正常情况：仓库里本来就有 config；两者都没有才是异常
    result.warnings.push('既没有配置文件也没有模板：将使用引擎默认配置（数据可能落到 ~/.nanobot）');
  }

  // ⑤ 读取上次运行的引擎版本（用于判断是否需要补配置字段）
  let previousVersion: string | null = null;
  let previousBuildId: string | null = null;
  if (io.exists(stampPath)) {
    try {
      const stamp = readJson(await io.readFile(stampPath)) as {
        engineVersion?: string;
        buildId?: string;
      };
      previousVersion = stamp.engineVersion ?? null;
      previousBuildId = stamp.buildId ?? null;
    } catch {
      // stamp 坏了就当"未知旧版本"：补一次缺失键无害，且能自愈
      previousVersion = null;
    }
  }

  // ⑥ 引擎版本变化 → 深合并缺失键
  if (configExists && template && manifest?.engineVersion) {
    if (previousVersion !== manifest.engineVersion) {
      try {
        const current = readJson(await io.readFile(deps.configPath));
        if (isPlainObject(current)) {
          const merged = mergeMissingKeys(current, template);
          if (merged.length > 0) {
            await io.writeFile(deps.configPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
            result.mergedKeys = merged;
          }
        }
      } catch (error) {
        result.warnings.push(`配置深合并失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // ⑦ 记录本次运行的引擎版本。
  //    只在版本/buildId 变化时落盘：每次都写会让"幂等"名存实亡（每次启动都产生一次写），
  //    而这份文件唯一的作用就是回答"上次跑的是哪个版本"。
  if (manifest?.engineVersion) {
    const nextBuildId = manifest.buildId ?? null;
    const changed =
      previousVersion !== manifest.engineVersion || previousBuildId !== nextBuildId;
    if (changed) {
      try {
        const stamp = {
          engineVersion: manifest.engineVersion,
          buildId: nextBuildId,
          updatedAt: now().toISOString(),
        };
        await io.writeFile(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
      } catch (error) {
        result.warnings.push(`写入 engine.stamp 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return result;
}
