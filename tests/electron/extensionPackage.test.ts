/**
 * 扩展清单解析与资源定位（`electron/extensionPackage.ts`）。
 *
 * 扩展清单来自**用户目录**，是不可信输入。这里钉住的都是「校验漏了也不报错、
 * 但要等到真机上出事」的那几条：
 *
 * 1. **id 必须等于目录名** —— 它同时是协议 host 与目录名，不一致时"清单说自己是 A、
 *    实际文件在 B"，界面与协议各查一边，症状是白屏 + 404；
 * 2. **URL 只认包内相对路径与 http(s)** —— `javascript:` 会在扩展自己的源里执行脚本，
 *    `file:` 直接绕过协议的目录约束；
 * 3. **包内路径必须过包含性检查** —— `../../evil.cjs` 这类 entry 一旦被接受，
 *    等于把"任意 node 脚本执行"做成了一条清单字段；
 * 4. **未扫描过的 id 一律 404** —— 协议 handler 只认映射表，不按 URL 里的 host 拼目录。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installExtensionPackage,
  isInside,
  parseExtensionManifest,
  readExtension,
  resolveExtensionRequest,
  resolveInside,
  scanExtensions,
} from '../../electron/extensionPackage';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nanowork-ext-'));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

function writeJson(dir: string, relPath: string, value: unknown): void {
  const target = join(dir, relPath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2), 'utf8');
}

function writeFile(dir: string, relPath: string, content = 'x'): void {
  const target = join(dir, relPath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'hello',
  name: 'Hello',
  version: '0.0.1',
  description: 'demo',
  ...over,
});

describe('parseExtensionManifest', () => {
  it('解析出界面入口、预览器、设置项与服务声明', () => {
    const { manifest, issues } = parseExtensionManifest(
      JSON.stringify(
        base({
          ui: {
            entry: { title: 'Hello', url: './ui/index.html', keepAlive: true },
            artifactPreviews: [
              { id: 'pv', label: '预览', match: { bizType: 'nanowork/html' }, url: './ui/pv.html' },
            ],
            settings: [{ id: 's1', label: '设置', target: 'dataManagement' }],
          },
          service: { entry: './server/index.cjs', process: 'fork', args: ['--port', '0'] },
        }),
      ),
      { dirName: 'hello', source: 'user' },
    );

    expect(issues).toEqual([]);
    expect(manifest?.ui?.entry).toEqual({
      title: 'Hello',
      url: './ui/index.html',
      keepAlive: true,
    });
    expect(manifest?.ui?.artifactPreviews?.[0].match.bizType).toBe('nanowork/html');
    expect(manifest?.ui?.settings?.[0].target).toBe('dataManagement');
    expect(manifest?.service).toEqual({
      entry: './server/index.cjs',
      process: 'fork',
      args: ['--port', '0'],
    });
  });

  it('id 与目录名不一致时拒绝（协议 host 与目录必须同一份事实）', () => {
    const { manifest, issues } = parseExtensionManifest(JSON.stringify(base({ id: 'other' })), {
      dirName: 'hello',
      source: 'user',
    });
    expect(manifest).toBeNull();
    expect(issues.join()).toContain('不一致');
  });

  it('id 含路径分隔符或大写时拒绝', () => {
    for (const bad of ['../evil', 'Hello', 'a/b', '']) {
      const { manifest } = parseExtensionManifest(JSON.stringify(base({ id: bad })), {
        dirName: bad,
        source: 'user',
      });
      expect(manifest).toBeNull();
    }
  });

  it('拒绝 javascript: 入口（会在扩展自己的源里执行脚本）', () => {
    const { manifest, issues } = parseExtensionManifest(
      JSON.stringify(base({ ui: { entry: { title: 'x', url: 'javascript:alert(1)' } } })),
      { dirName: 'hello', source: 'user' },
    );
    expect(manifest?.ui?.entry).toBeUndefined();
    expect(issues.join()).toContain('ui.entry.url');
  });

  it('http(s) 入口放行（用户自己托管的界面）', () => {
    const { manifest } = parseExtensionManifest(
      JSON.stringify(base({ ui: { entry: { title: 'x', url: 'https://example.com/app' } } })),
      { dirName: 'hello', source: 'user' },
    );
    expect(manifest?.ui?.entry?.url).toBe('https://example.com/app');
  });

  it('service.process 不是 fork 时忽略服务而不是整份拒绝', () => {
    const { manifest, issues } = parseExtensionManifest(
      JSON.stringify(base({ service: { entry: './s.cjs', process: 'spawn' } })),
      { dirName: 'hello', source: 'user' },
    );
    expect(manifest).not.toBeNull();
    expect(manifest?.service).toBeUndefined();
    expect(issues.join()).toContain('fork');
  });

  it('service.entry 不是 js 时忽略', () => {
    const { manifest } = parseExtensionManifest(
      JSON.stringify(base({ service: { entry: './run.sh', process: 'fork' } })),
      { dirName: 'hello', source: 'user' },
    );
    expect(manifest?.service).toBeUndefined();
  });

  it('坏 JSON 直接判为不可用', () => {
    const { manifest, issues } = parseExtensionManifest('{ not json', {
      dirName: 'hello',
      source: 'user',
    });
    expect(manifest).toBeNull();
    expect(issues[0]).toContain('JSON');
  });
});

describe('resolveInside / isInside', () => {
  it('拒绝越界路径（含规范化后才越界的写法）', () => {
    expect(resolveInside(root, '../evil.cjs')).toBeNull();
    expect(resolveInside(root, 'ui/../../evil.cjs')).toBeNull();
    expect(resolveInside(root, '/etc/passwd')).toBeNull();
    expect(resolveInside(root, '')).toBeNull();
  });

  it('拒绝 Windows 盘符相对路径（isAbsolute 为 false，normalize 后也不以 ../ 开头）', () => {
    // 实测：normalize('C:../evil.cjs') === 'C:..\\evil.cjs'，
    //       resolve(root, …) === 'C:\\ext\\evil.cjs'（跑到包外一层）
    // 所以这条只能靠"含冒号一律拒"来挡。
    expect(resolveInside(root, 'C:../evil.cjs')).toBeNull();
    expect(resolveInside(root, 'C:..\\evil.cjs')).toBeNull();
    // NTFS 备用数据流语法同理
    expect(resolveInside(root, 'ui/index.html:stream')).toBeNull();
  });

  it('接受包内路径', () => {
    const target = resolveInside(root, 'ui/index.html');
    expect(target).not.toBeNull();
    expect(isInside(root, target!)).toBe(true);
  });

  it('前缀相同的兄弟目录不算在内（/a/bc 不在 /a/b 里）', () => {
    expect(isInside('/a/b', '/a/bc/x')).toBe(false);
  });
});

describe('resolveExtensionRequest', () => {
  const roots = new Map([['hello', join('C:', 'ext', 'hello')]]);

  it('未扫描过的扩展 id 一律拒绝（不按 URL 里的 host 拼目录）', () => {
    expect(resolveExtensionRequest('nanowork-ext://unknown/index.html', roots)).toBeNull();
  });

  it('URL 里的 `..` 会被 WHATWG 规范化吃掉，仍落在包内（不是漏洞，但要说清语义）', () => {
    const hit = resolveExtensionRequest('nanowork-ext://hello/../secret.txt', roots);
    expect(hit?.filePath.replace(/\\/g, '/')).toContain('ext/hello/secret.txt');
  });

  it('百分号编码的 `..` 必须被拒（decode 发生在规范化之后，这一层是唯一防线）', () => {
    expect(
      resolveExtensionRequest('nanowork-ext://hello/%2e%2e%2f%2e%2e%2fsecret.txt', roots),
    ).toBeNull();
  });

  it('正常路径解析到包内文件', () => {
    const hit = resolveExtensionRequest('nanowork-ext://hello/ui/index.html', roots);
    expect(hit?.extId).toBe('hello');
    expect(hit?.filePath.replace(/\\/g, '/')).toContain('ext/hello/ui/index.html');
  });

  it('不是本协议的一律拒绝', () => {
    expect(resolveExtensionRequest('https://hello/index.html', roots)).toBeNull();
  });
});

describe('scanExtensions', () => {
  it('一个坏包只进 skipped，不影响其它扩展', async () => {
    writeJson(join(root, 'good'), 'extension.json', base({ id: 'good', name: '好扩展' }));
    writeFile(join(root, 'good'), 'ui/index.html', '<html></html>');
    mkdirSync(join(root, 'bad'), { recursive: true });
    writeFile(join(root, 'bad'), 'extension.json', '{ broken');

    const result = await scanExtensions(root);
    expect(result.extensions.map((e) => e.manifest.name)).toEqual(['好扩展']);
    expect(result.skipped).toEqual(['bad']);
  });

  it('目录不存在时给原因而不是抛错', async () => {
    const result = await scanExtensions(join(root, 'missing'));
    expect(result.extensions).toEqual([]);
    expect(result.error).toContain('不存在');
  });

  it('忽略隐藏目录与下划线目录（草稿/禁用扩展的约定）', async () => {
    writeJson(join(root, '.draft'), 'extension.json', base({ id: '.draft' }));
    writeJson(join(root, '_off'), 'extension.json', base({ id: '_off' }));
    writeJson(join(root, 'on'), 'extension.json', base({ id: 'on' }));

    const result = await scanExtensions(root);
    expect(result.extensions.map((e) => e.manifest.id)).toEqual(['on']);
  });

  it('读单个扩展时把清单提示带出来（页面要能显示）', async () => {
    writeJson(
      join(root, 'hello'),
      'extension.json',
      base({ service: { entry: './run.sh', process: 'fork' } }),
    );
    const { extension } = await readExtension(root, 'hello', 'user');
    expect(extension?.issues.join()).toContain('.js');
  });
});

// ---------------------------------------------------------------------------
// 安装 + 装错结构诊断
// ---------------------------------------------------------------------------

/**
 * 这两组守的是**用户实际踩到的两个坑**：
 *
 * 1. 没有"安装"入口时只能手工复制，而 `cp -r pkg/* dest/` 与 `cp -r pkg dest/`
 *    只差一个星号，结果却是"扩展目录里躺着一堆文件、扫描器一个都看不见"；
 * 2. 那种状态下界面必须**说清楚**正确结构，否则用户只会以为功能没做。
 */
describe('installExtensionPackage', () => {
  it('把来源目录整体复制成 extensions/<清单 id>', async () => {
    const source = join(root, 'src-hello');
    writeJson(source, 'extension.json', base({ id: 'hello', name: 'Hello' }));
    writeFile(source, 'ui/index.html', '<html></html>');
    const extensionsRoot = join(root, 'extensions');

    const result = await installExtensionPackage({ sourceDir: source, extensionsRoot });
    expect(result.ok).toBe(true);
    expect(result.id).toBe('hello');
    expect(existsSync(join(extensionsRoot, 'hello', 'ui', 'index.html'))).toBe(true);
  });

  it('落点目录名取清单里的 id，而不是来源目录名', async () => {
    // 来源目录叫 `some-folder`，清单说自己是 `hello`
    const source = join(root, 'some-folder');
    writeJson(source, 'extension.json', base({ id: 'hello' }));
    const extensionsRoot = join(root, 'extensions');

    const result = await installExtensionPackage({ sourceDir: source, extensionsRoot });
    expect(result.ok).toBe(true);
    expect(result.root?.replace(/\\/g, '/')).toContain('/extensions/hello');
  });

  it('已安装且未勾选覆盖时拒绝（不悄悄替换用户的目录）', async () => {
    const source = join(root, 'src-hello');
    writeJson(source, 'extension.json', base({ id: 'hello' }));
    const extensionsRoot = join(root, 'extensions');
    mkdirSync(join(extensionsRoot, 'hello'), { recursive: true });

    const result = await installExtensionPackage({ sourceDir: source, extensionsRoot });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('already-installed');
  });

  it('勾选覆盖后替换成功', async () => {
    const source = join(root, 'src-hello');
    writeJson(source, 'extension.json', base({ id: 'hello' }));
    writeFile(source, 'ui/index.html', 'NEW');
    const extensionsRoot = join(root, 'extensions');
    mkdirSync(join(extensionsRoot, 'hello'), { recursive: true });
    writeFile(extensionsRoot, 'hello/ui/index.html', 'OLD');

    const result = await installExtensionPackage({
      sourceDir: source,
      extensionsRoot,
      overwrite: true,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(extensionsRoot, 'hello', 'ui', 'index.html'), 'utf8')).toBe('NEW');
  });

  it('来源已在扩展目录内时拒绝（否则是把自己复制进自己）', async () => {
    const extensionsRoot = join(root, 'extensions');
    const source = join(extensionsRoot, 'hello');
    writeJson(source, 'extension.json', base({ id: 'hello' }));

    const result = await installExtensionPackage({ sourceDir: source, extensionsRoot });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('escape');
  });

  it('来源目录没有清单时如实拒绝', async () => {
    const source = join(root, 'empty');
    mkdirSync(source, { recursive: true });
    const result = await installExtensionPackage({
      sourceDir: source,
      extensionsRoot: join(root, 'extensions'),
    });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('manifest-invalid');
  });
});

describe('scanExtensions：装错结构诊断', () => {
  it('⭐ 清单直接躺在根目录时给出 hint（这是"一个扩展都看不见"的根因）', async () => {
    writeJson(root, 'extension.json', base({ id: 'hello' }));

    const result = await scanExtensions(root);
    expect(result.extensions).toEqual([]);
    expect(result.hint).toBeTruthy();
    expect(result.hint).toContain('子目录');
  });

  it('结构正确时不给 hint（别把正常状态也报警）', async () => {
    writeJson(join(root, 'hello'), 'extension.json', base({ id: 'hello' }));
    const result = await scanExtensions(root);
    expect(result.hint).toBeUndefined();
  });
});
