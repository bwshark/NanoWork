import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_PLUGIN_SCHEMA,
  compareVersions,
  installPluginPackage,
  inventoryPluginResources,
  isPluginInstalled,
  parseVersion,
  readInstalledPlugins,
  readPluginManifest,
  satisfiesRange,
  uninstallPluginPackage,
} from '../../electron/pluginPackage';

/**
 * 插件包格式测试（FR-3.4 客户端侧）。
 *
 * 这里钉住的是**与引擎共享的那套语义**，而不是自创规则：
 * 1. 清单校验强度与引擎一致（`$schema` 命中 + `name` 同一条正则）——
 *    引擎拒收的包客户端也不该接受，否则会出现"装上了但引擎看不见"；
 * 2. 位置回退"先判存在再解析"——高优先级位置存在但内容坏 = **明确失败**，
 *    不悄悄回退（否则一份坏清单会被另一份好清单掩盖）；
 * 3. 安装顺序"先全部校验、再落盘"——非法包不该在磁盘上留下半个目录。
 */

const SCHEMA = AGENT_PLUGIN_SCHEMA;

let root = '';
let pluginsRoot = '';
let sourceRoot = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nanowork-plugins-'));
  pluginsRoot = join(root, 'plugins');
  sourceRoot = join(root, 'src');
  mkdirSync(pluginsRoot, { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言
  }
});

/** 写一个清单文件（自动建父目录） */
function writeJson(dir: string, relPath: string, value: unknown): void {
  const target = join(dir, relPath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2), 'utf8');
}

/** 写一个文本文件（自动建父目录） */
function writeFile(dir: string, relPath: string, content = 'x'): void {
  const target = join(dir, relPath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: SCHEMA,
    name: 'demo-plugin',
    description: '演示插件',
    extensions: {
      'dev.nanobot': {
        displayName: '演示插件',
        version: '1.2.3',
        category: 'Development',
        accentColor: '#4f46e5',
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 清单解析
// ---------------------------------------------------------------------------

describe('readPluginManifest: 合法清单', () => {
  it('解析出引擎与客户端都认的字段，并记录命中的清单位置', async () => {
    writeJson(sourceRoot, 'plugin.json', validManifest());
    const manifest = await readPluginManifest(sourceRoot);

    expect(manifest).not.toBeNull();
    expect(manifest?.name).toBe('demo-plugin');
    expect(manifest?.displayName).toBe('演示插件');
    expect(manifest?.version).toBe('1.2.3');
    expect(manifest?.versionDeclared).toBe(true);
    expect(manifest?.description).toBe('演示插件');
    expect(manifest?.category).toBe('Development');
    expect(manifest?.accentColor).toBe('#4f46e5');
    expect(manifest?.manifestRelPath).toBe('plugin.json');
  });

  it('displayName 缺省回落 name，category 缺省回落 Plugin', async () => {
    writeJson(sourceRoot, 'plugin.json', {
      $schema: SCHEMA,
      name: 'bare-plugin',
    });
    const manifest = await readPluginManifest(sourceRoot);

    expect(manifest?.displayName).toBe('bare-plugin');
    expect(manifest?.category).toBe('Plugin');
  });

  it('没声明版本时回落 0.0.0 并标记 versionDeclared=false', async () => {
    writeJson(sourceRoot, 'plugin.json', { $schema: SCHEMA, name: 'bare-plugin' });
    const manifest = await readPluginManifest(sourceRoot);

    expect(manifest?.version).toBe('0.0.0');
    expect(manifest?.versionDeclared).toBe(false);
  });

  it('main 缺省为 SKILL.md，permissions 缺省为空数组', async () => {
    writeJson(sourceRoot, 'plugin.json', { $schema: SCHEMA, name: 'bare-plugin' });
    const manifest = await readPluginManifest(sourceRoot);

    expect(manifest?.main).toBe('SKILL.md');
    expect(manifest?.permissions).toEqual({ tools: [], network: [] });
  });

  it('读取 permissions.tools / network 声明', async () => {
    writeJson(
      sourceRoot,
      'plugin.json',
      validManifest({ permissions: { tools: ['Read', 'Bash'], network: ['docs.qq.com'] } }),
    );
    const manifest = await readPluginManifest(sourceRoot);

    expect(manifest?.permissions).toEqual({ tools: ['Read', 'Bash'], network: ['docs.qq.com'] });
  });

  it('engines.nanowork 被读成 engineRange', async () => {
    writeJson(sourceRoot, 'plugin.json', validManifest({ engines: { nanowork: '>=1.0.0' } }));
    const manifest = await readPluginManifest(sourceRoot);

    expect(manifest?.engineRange).toBe('>=1.0.0');
  });

  it('accentColor 不是 6 位十六进制时不展示（而不是原样透传）', async () => {
    writeJson(
      sourceRoot,
      'plugin.json',
      validManifest({
        extensions: { 'dev.nanobot': { accentColor: 'indigo' } },
      }),
    );
    const manifest = await readPluginManifest(sourceRoot);

    expect(manifest?.accentColor).toBeUndefined();
  });
});

describe('readPluginManifest: 拒收（与引擎同强度）', () => {
  it('缺 $schema → null', async () => {
    writeJson(sourceRoot, 'plugin.json', { name: 'demo-plugin' });
    expect(await readPluginManifest(sourceRoot)).toBeNull();
  });

  it('$schema 不是 agent-plugins.org → null', async () => {
    writeJson(sourceRoot, 'plugin.json', { $schema: 'https://example.com/other.json', name: 'demo' });
    expect(await readPluginManifest(sourceRoot)).toBeNull();
  });

  it.each([
    ['大写字母', 'Demo'],
    ['双连字符（引擎用 -- 拼 MCP 命名空间）', 'demo--plugin'],
    ['路径穿越', '..'],
    ['以点结尾', 'demo.'],
    ['超长（>64）', 'a'.repeat(65)],
  ])('name 非法（%s）→ null', async (_label, name) => {
    writeJson(sourceRoot, 'plugin.json', { $schema: SCHEMA, name });
    expect(await readPluginManifest(sourceRoot)).toBeNull();
  });

  it('没有清单文件的目录 → null', async () => {
    writeFile(sourceRoot, 'README.md', 'hi');
    expect(await readPluginManifest(sourceRoot)).toBeNull();
  });

  it('JSON 语法错误 → null（不抛异常）', async () => {
    writeFile(sourceRoot, 'plugin.json', '{ not json');
    expect(await readPluginManifest(sourceRoot)).toBeNull();
  });

  it('清单是数组而不是对象 → null', async () => {
    writeFile(sourceRoot, 'plugin.json', '[1,2,3]');
    expect(await readPluginManifest(sourceRoot)).toBeNull();
  });
});

describe('readPluginManifest: 位置回退', () => {
  it('包根没有 plugin.json 时读 .nanowork-plugin/plugin.json（PRD §12.2 位置）', async () => {
    writeJson(sourceRoot, '.nanowork-plugin/plugin.json', validManifest());
    const manifest = await readPluginManifest(sourceRoot);

    expect(manifest?.name).toBe('demo-plugin');
    expect(manifest?.manifestRelPath).toBe('.nanowork-plugin/plugin.json');
  });

  it('两处都有时以包根 plugin.json 为准（顺序即优先级）', async () => {
    writeJson(sourceRoot, 'plugin.json', validManifest({ name: 'root-wins' }));
    writeJson(sourceRoot, '.nanowork-plugin/plugin.json', validManifest({ name: 'fallback' }));
    const manifest = await readPluginManifest(sourceRoot);

    expect(manifest?.name).toBe('root-wins');
  });

  it('高优先级位置存在但 JSON 坏 → 明确失败，不回退到低优先级', async () => {
    writeFile(sourceRoot, 'plugin.json', '{ broken');
    writeJson(sourceRoot, '.nanowork-plugin/plugin.json', validManifest({ name: 'fallback' }));

    expect(await readPluginManifest(sourceRoot)).toBeNull();
  });

  it('高优先级位置存在但 $schema 不匹配 → 明确失败，不回退', async () => {
    writeJson(sourceRoot, 'plugin.json', { $schema: 'https://example.com/x.json', name: 'root' });
    writeJson(sourceRoot, '.nanowork-plugin/plugin.json', validManifest({ name: 'fallback' }));

    expect(await readPluginManifest(sourceRoot)).toBeNull();
  });
});

describe('readPluginManifest: logo', () => {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function withLogo(logo: string): Record<string, unknown> {
    return validManifest({ extensions: { 'dev.nanobot': { logo } } });
  }

  it('合法 PNG 被转成 data URL', async () => {
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, 'logo.png'), Buffer.concat([PNG_MAGIC, Buffer.from('body')]));
    writeJson(sourceRoot, 'plugin.json', withLogo('./logo.png'));

    const manifest = await readPluginManifest(sourceRoot);
    expect(manifest?.logo?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('非 ./ 开头的路径被拒（只认包内相对路径）', async () => {
    writeFileSync(join(sourceRoot, 'logo.png'), PNG_MAGIC);
    writeJson(sourceRoot, 'plugin.json', withLogo('/etc/passwd'));

    expect((await readPluginManifest(sourceRoot))?.logo).toBeUndefined();
  });

  it('路径穿越被拒（../ 逃出包外）', async () => {
    writeFileSync(join(root, 'outside.png'), PNG_MAGIC);
    writeJson(sourceRoot, 'plugin.json', withLogo('./../outside.png'));

    expect((await readPluginManifest(sourceRoot))?.logo).toBeUndefined();
  });

  it('扩展名与魔数不符被拒（防止伪造 .png）', async () => {
    writeFile(sourceRoot, 'logo.png', 'not really a png');
    writeJson(sourceRoot, 'plugin.json', withLogo('./logo.png'));

    expect((await readPluginManifest(sourceRoot))?.logo).toBeUndefined();
  });

  it('文件不存在时不报错，只是没有 logo', async () => {
    writeJson(sourceRoot, 'plugin.json', withLogo('./missing.png'));
    const manifest = await readPluginManifest(sourceRoot);

    expect(manifest).not.toBeNull();
    expect(manifest?.logo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 资源盘点
// ---------------------------------------------------------------------------

describe('inventoryPluginResources', () => {
  it('缺失的分组也返回（count 0），界面不会因缺项跳动', async () => {
    writeJson(sourceRoot, 'plugin.json', validManifest());
    const groups = await inventoryPluginResources(sourceRoot);

    expect(groups.map((g) => g.id)).toEqual([
      'skill',
      'agents',
      'experts',
      'skills',
      'commands',
      'hooks',
      'mcp',
      'prompt',
      'scripts',
      'assets',
    ]);
    expect(groups.every((g) => g.count === 0)).toBe(true);
  });

  it('按目录盘点各分组（入口技能 / 子代理 / 子技能 / 命令 / 提示词）', async () => {
    writeJson(sourceRoot, 'plugin.json', validManifest());
    writeFile(sourceRoot, 'SKILL.md', '# demo');
    writeFile(sourceRoot, 'agents/researcher.md');
    writeFile(sourceRoot, 'agents/planner.md');
    writeFile(sourceRoot, 'commands/deploy.md');
    writeFile(sourceRoot, 'prompt/persona.md');
    writeFile(sourceRoot, 'skills/foo/SKILL.md');
    // 不含 SKILL.md 的目录不算子技能
    writeFile(sourceRoot, 'skills/not-a-skill/readme.md');

    const byId = new Map((await inventoryPluginResources(sourceRoot)).map((g) => [g.id, g]));
    expect(byId.get('skill')?.names).toEqual(['SKILL.md']);
    expect(byId.get('agents')?.names).toEqual(['planner', 'researcher']);
    expect(byId.get('commands')?.names).toEqual(['deploy']);
    expect(byId.get('prompt')?.names).toEqual(['persona']);
    expect(byId.get('skills')?.names).toEqual(['foo']);
  });

  it('MCP 配置支持 mcp.json → mcp/mcp.json 回退', async () => {
    writeJson(sourceRoot, 'plugin.json', validManifest());
    writeFile(sourceRoot, 'mcp/mcp.json', '{"mcpServers":{}}');
    const byId = new Map((await inventoryPluginResources(sourceRoot)).map((g) => [g.id, g]));

    expect(byId.get('mcp')?.names).toEqual(['mcp/mcp.json']);
  });

  it('专家包只数目录，脚本与资源只数文件', async () => {
    writeJson(sourceRoot, 'plugin.json', validManifest());
    mkdirSync(join(sourceRoot, 'experts/agronomist'), { recursive: true });
    writeFile(sourceRoot, 'experts/README.md');
    writeFile(sourceRoot, 'scripts/run.sh');
    writeFile(sourceRoot, 'assets/logo.png');
    mkdirSync(join(sourceRoot, 'assets/nested'), { recursive: true });

    const byId = new Map((await inventoryPluginResources(sourceRoot)).map((g) => [g.id, g]));
    expect(byId.get('experts')?.names).toEqual(['agronomist']);
    expect(byId.get('scripts')?.names).toEqual(['run.sh']);
    expect(byId.get('assets')?.names).toEqual(['logo.png']);
  });
});

// ---------------------------------------------------------------------------
// 扫描已安装
// ---------------------------------------------------------------------------

describe('readInstalledPlugins', () => {
  it('坏包被跳过并记进 skipped，好包照常返回（一个坏包不等于什么都没装）', async () => {
    mkdirSync(join(pluginsRoot, 'good'), { recursive: true });
    writeJson(join(pluginsRoot, 'good'), 'plugin.json', validManifest({ name: 'good' }));
    mkdirSync(join(pluginsRoot, 'broken'), { recursive: true });
    writeFile(join(pluginsRoot, 'broken'), 'plugin.json', '{ broken');
    writeFile(pluginsRoot, 'loose-file.txt', 'x');

    const { plugins, skipped } = await readInstalledPlugins(pluginsRoot);
    expect(plugins.map((p) => p.manifest.name)).toEqual(['good']);
    expect(skipped).toEqual(['broken']);
  });

  it('按名字排序，并带上资源盘点与 installedAt', async () => {
    for (const name of ['zeta', 'alpha']) {
      mkdirSync(join(pluginsRoot, name), { recursive: true });
      writeJson(join(pluginsRoot, name), 'plugin.json', validManifest({ name }));
    }

    const { plugins } = await readInstalledPlugins(pluginsRoot);
    expect(plugins.map((p) => p.manifest.name)).toEqual(['alpha', 'zeta']);
    expect(plugins[0]?.resources.length).toBe(10);
    expect(typeof plugins[0]?.installedAt).toBe('string');
  });

  it('插件根不存在时返回空列表而不是抛错', async () => {
    const result = await readInstalledPlugins(join(root, 'nope'));
    expect(result).toEqual({ plugins: [], skipped: [] });
  });
});

// ---------------------------------------------------------------------------
// 安装 / 卸载
// ---------------------------------------------------------------------------

describe('installPluginPackage', () => {
  it('安装后目录名取清单 name，而不是来源目录名', async () => {
    const source = join(root, 'demo-plugin-1.2.3');
    mkdirSync(source, { recursive: true });
    writeJson(source, 'plugin.json', validManifest());
    writeFile(source, 'SKILL.md', '# demo');

    const result = await installPluginPackage({ sourceDir: source, pluginsRoot });
    expect(result.ok).toBe(true);
    expect(result.manifest?.name).toBe('demo-plugin');
    expect(result.root).toBe(join(pluginsRoot, 'demo-plugin'));
    expect(readdirSync(pluginsRoot)).toEqual(['demo-plugin']);
  });

  it('来源目录不存在 → source-missing', async () => {
    const result = await installPluginPackage({ sourceDir: join(root, 'nope'), pluginsRoot });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('source-missing');
  });

  it('清单非法 → manifest-invalid，且**不落盘**（先校验再写）', async () => {
    writeFile(sourceRoot, 'plugin.json', '{ broken');
    const result = await installPluginPackage({ sourceDir: sourceRoot, pluginsRoot });

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('manifest-invalid');
    expect(readdirSync(pluginsRoot)).toEqual([]);
  });

  it('已安装且未要求覆盖 → already-installed', async () => {
    writeJson(sourceRoot, 'plugin.json', validManifest());
    mkdirSync(join(pluginsRoot, 'demo-plugin'), { recursive: true });

    const result = await installPluginPackage({ sourceDir: sourceRoot, pluginsRoot });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('already-installed');
  });

  it('覆盖安装是整目录替换：旧版本残留文件不会被继承', async () => {
    const target = join(pluginsRoot, 'demo-plugin');
    mkdirSync(target, { recursive: true });
    writeFile(target, 'stale.js', 'old');

    writeJson(sourceRoot, 'plugin.json', validManifest());
    const result = await installPluginPackage({ sourceDir: sourceRoot, pluginsRoot, overwrite: true });

    expect(result.ok).toBe(true);
    expect(readdirSync(target).includes('stale.js')).toBe(false);
  });

  it('拒绝把自己复制进插件根之内', async () => {
    const inside = join(pluginsRoot, 'demo-plugin');
    mkdirSync(inside, { recursive: true });
    writeJson(inside, 'plugin.json', validManifest());

    const result = await installPluginPackage({ sourceDir: inside, pluginsRoot });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('escape');
  });

  it('自拷贝守卫优先于覆盖安装：overwrite 时也不会把来源删掉', async () => {
    // 覆盖安装是"先 rm 再 cp"。若守卫排在 already-installed 之后，
    // 这条路径会把来源目录 rm 掉，随后 cp 无源可读 —— 旧版本没了、新的也没装上。
    const inside = join(pluginsRoot, 'demo-plugin');
    mkdirSync(inside, { recursive: true });
    writeJson(inside, 'plugin.json', validManifest());
    writeFile(inside, 'SKILL.md', '# demo');

    const result = await installPluginPackage({ sourceDir: inside, pluginsRoot, overwrite: true });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('escape');
    // 来源原封不动
    expect(readdirSync(inside).sort()).toEqual(['SKILL.md', 'plugin.json']);
  });
});

describe('uninstallPluginPackage', () => {
  it('删除已安装包并返回 true', async () => {
    writeJson(sourceRoot, 'plugin.json', validManifest());
    await installPluginPackage({ sourceDir: sourceRoot, pluginsRoot });

    expect(await uninstallPluginPackage(pluginsRoot, 'demo-plugin')).toBe(true);
    expect(readdirSync(pluginsRoot)).toEqual([]);
  });

  it('包不存在返回 false', async () => {
    expect(await uninstallPluginPackage(pluginsRoot, 'ghost')).toBe(false);
  });

  it.each(['..', 'a--b', 'Demo', 'a/b'])('名字非法（%s）返回 false 且不触碰文件系统', async (name) => {
    writeJson(sourceRoot, 'plugin.json', validManifest());
    await installPluginPackage({ sourceDir: sourceRoot, pluginsRoot });

    expect(await uninstallPluginPackage(pluginsRoot, name)).toBe(false);
    expect(readdirSync(pluginsRoot)).toEqual(['demo-plugin']);
  });

  it('名字合法但目录是符号链接指向外部时不解引用删除', async () => {
    if (process.platform === 'win32') return; // Windows 建符号链接需要特权，交给 CI 的 POSIX 环境
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFile(outside, 'keep.txt', 'x');
    symlinkSync(outside, join(pluginsRoot, 'linked'), 'dir');

    // 目标经 realpath 解析后在插件根之外 → containPath 拒绝 → false
    expect(await uninstallPluginPackage(pluginsRoot, 'linked')).toBe(false);
  });
});

describe('isPluginInstalled', () => {
  it('只认目录，名字非法直接 false', async () => {
    mkdirSync(join(pluginsRoot, 'demo-plugin'), { recursive: true });
    expect(await isPluginInstalled(pluginsRoot, 'demo-plugin')).toBe(true);
    expect(await isPluginInstalled(pluginsRoot, 'ghost')).toBe(false);
    expect(await isPluginInstalled(pluginsRoot, '..')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

describe('版本比较', () => {
  it('parseVersion 解析 x.y.z，允许 v 前缀与缺省段', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1')).toEqual([1, 0, 0]);
    expect(parseVersion('1.2')).toEqual([1, 2, 0]);
    expect(parseVersion('abc')).toBeNull();
  });

  it('compareVersions 按段比较，非法版本视作 0.0.0', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('junk', '1.0.0')).toBeLessThan(0);
  });

  it('satisfiesRange 支持 * / 精确 / 比较符 / ^ / ~ / 空格与', () => {
    expect(satisfiesRange('1.2.3', '')).toBe(true);
    expect(satisfiesRange('1.2.3', '*')).toBe(true);
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true);
    expect(satisfiesRange('1.2.3', '>=1.0.0')).toBe(true);
    expect(satisfiesRange('0.9.0', '>=1.0.0')).toBe(false);
    expect(satisfiesRange('1.2.3', '^1.2.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfiesRange('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfiesRange('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfiesRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfiesRange('1.0.0', 'not-a-range')).toBe(false);
  });
});
