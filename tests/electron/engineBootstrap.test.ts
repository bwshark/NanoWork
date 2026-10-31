/**
 * 首启引导（`electron/engineBootstrap.ts`）。
 *
 * 要钉住的是三件"做错了不会报错、只会静默跑偏"的事：
 *
 * 1. **幂等**：配置已存在时绝不重写 —— 重写一次就把用户的模型/渠道设置抹了。
 * 2. **只补不覆盖**：引擎升级只补缺失键，用户改过的值（包括显式 null）必须保留。
 * 3. **占位符不外泄**：模板里的 `__NANOWORK_WORKSPACE__` 既不能进首份配置，
 *    也不能在后来的深合并里被当成"缺失键"补进去。
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENGINE_STAMP_FILE,
  WORKSPACE_PLACEHOLDER,
  bootstrapEngineRuntime,
  mergeMissingKeys,
  replacePlaceholder,
  type EngineBootstrapIO,
} from '@/../electron/engineBootstrap';

const ROOT = join('C:', 'app', 'resources', 'rt');
const USER_DATA = join('C:', 'userdata');

interface StubOptions {
  files?: Record<string, string>;
  dirs?: string[];
  failWrite?: string;
}

function stubIO(options: StubOptions = {}) {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const written: string[] = [];
  const mkdirs: string[] = [];
  const io: EngineBootstrapIO = {
    exists: (path) => files.has(path) || (options.dirs ?? []).includes(path),
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return value;
    },
    writeFile: async (path, data) => {
      if (options.failWrite === path) throw new Error('EACCES');
      files.set(path, data);
      written.push(path);
    },
    mkdir: async (path) => {
      mkdirs.push(path);
    },
  };
  return { io, files, written, mkdirs };
}

const template = {
  agents: { defaults: { workspace: WORKSPACE_PLACEHOLDER, botName: 'nanowork' } },
  channels: { sendProgress: true },
};
const manifest = { engineVersion: '0.3.0', buildId: 'b1' };

const configPath = join(USER_DATA, 'nanowork.config.json');
const templatePath = join(ROOT, 'config.template.json');
const manifestPath = join(ROOT, 'manifest.json');
const stampPath = join(USER_DATA, ENGINE_STAMP_FILE);

describe('首启生成', () => {
  it('没有配置时从模板生成，workspace 指向 userData', async () => {
    const { io, files, written } = stubIO({
      files: {
        [templatePath]: JSON.stringify(template),
        [manifestPath]: JSON.stringify(manifest),
      },
    });

    const result = await bootstrapEngineRuntime({
      runtimeRoot: ROOT,
      userData: USER_DATA,
      configPath,
      io,
    });

    expect(result.configCreated).toBe(true);
    expect(result.workspacePath).toBe(join(USER_DATA, 'workspace'));
    const saved = JSON.parse(files.get(configPath) ?? '{}');
    expect(saved.agents.defaults.workspace).toBe(join(USER_DATA, 'workspace'));
    expect(saved.agents.defaults.botName).toBe('nanowork');
    // 占位符绝不能留在成品配置里
    expect(files.get(configPath)).not.toContain(WORKSPACE_PLACEHOLDER);
    expect(written).toContain(configPath);
  });

  it('建好三个可写目录（插件落点 / 分词缓存 / 工作区）', async () => {
    const { io, mkdirs } = stubIO({
      files: { [templatePath]: JSON.stringify(template) },
    });
    await bootstrapEngineRuntime({ runtimeRoot: ROOT, userData: USER_DATA, configPath, io });

    expect(mkdirs).toEqual([
      join(USER_DATA, 'workspace'),
      join(USER_DATA, 'pyuser'),
      join(USER_DATA, 'tiktoken'),
    ]);
  });

  it('既无配置又无模板时只告警，不抛错（开发态的常见情况）', async () => {
    const { io } = stubIO();
    const result = await bootstrapEngineRuntime({
      runtimeRoot: ROOT,
      userData: USER_DATA,
      configPath,
      io,
    });

    expect(result.configCreated).toBe(false);
    expect(result.warnings.join('\n')).toContain('默认配置');
  });
});

describe('幂等', () => {
  it('配置已存在时不会被重新生成，用户值不动；第二次启动不再写入', async () => {
    const existing = JSON.stringify({ agents: { defaults: { workspace: 'D:/mine' } } });
    const { io, files, written } = stubIO({
      files: {
        [configPath]: existing,
        [templatePath]: JSON.stringify(template),
        [manifestPath]: JSON.stringify(manifest),
      },
    });

    const first = await bootstrapEngineRuntime({
      runtimeRoot: ROOT,
      userData: USER_DATA,
      configPath,
      io,
    });

    expect(first.configCreated).toBe(false);
    // 首次运行没有 stamp → 视为"未知旧版本"，会补一次缺失键（botName 等）
    expect(first.mergedKeys.length).toBeGreaterThan(0);
    expect(JSON.parse(files.get(configPath) ?? '{}').agents.defaults.workspace).toBe('D:/mine');

    // 第二次：stamp 已写入、版本一致 → 一个字都不写
    const before = written.length;
    const second = await bootstrapEngineRuntime({
      runtimeRoot: ROOT,
      userData: USER_DATA,
      configPath,
      io,
    });

    expect(second.mergedKeys).toEqual([]);
    expect(written.length).toBe(before);
  });
});

describe('引擎升级：深合并', () => {
  const upgradedTemplate = {
    agents: { defaults: { workspace: WORKSPACE_PLACEHOLDER, botName: 'nanowork', newFlag: true } },
    channels: { sendProgress: true, newChannel: { enabled: false } },
  };

  it('引擎版本变了 → 只补缺失键，用户值一字不动', async () => {
    const { io, files } = stubIO({
      files: {
        [configPath]: JSON.stringify({
          agents: { defaults: { workspace: 'D:/mine', botName: '我的助手' } },
          channels: { sendProgress: false },
        }),
        [templatePath]: JSON.stringify(upgradedTemplate),
        [manifestPath]: JSON.stringify(manifest),
        [stampPath]: JSON.stringify({ engineVersion: '0.2.0' }),
      },
    });

    const result = await bootstrapEngineRuntime({
      runtimeRoot: ROOT,
      userData: USER_DATA,
      configPath,
      io,
    });

    const saved = JSON.parse(files.get(configPath) ?? '{}');
    // 补上的
    expect(saved.agents.defaults.newFlag).toBe(true);
    expect(saved.channels.newChannel).toEqual({ enabled: false });
    // 没被动过的
    expect(saved.agents.defaults.workspace).toBe('D:/mine');
    expect(saved.agents.defaults.botName).toBe('我的助手');
    expect(saved.channels.sendProgress).toBe(false);
    expect(result.mergedKeys).toEqual(
      expect.arrayContaining(['agents.defaults.newFlag', 'channels.newChannel']),
    );
  });

  it('版本没变 → 不做任何合并（幂等）', async () => {
    const { io, written } = stubIO({
      files: {
        [configPath]: JSON.stringify({ agents: { defaults: { workspace: 'D:/mine' } } }),
        [templatePath]: JSON.stringify(upgradedTemplate),
        [manifestPath]: JSON.stringify(manifest),
        [stampPath]: JSON.stringify({ engineVersion: '0.3.0' }),
      },
    });

    const result = await bootstrapEngineRuntime({
      runtimeRoot: ROOT,
      userData: USER_DATA,
      configPath,
      io,
    });

    expect(result.mergedKeys).toEqual([]);
    expect(written).not.toContain(configPath);
  });

  it('缺少 manifest 时不动配置（读不到版本就不猜）', async () => {
    const { io, written } = stubIO({
      files: {
        [configPath]: JSON.stringify({ agents: { defaults: { workspace: 'D:/mine' } } }),
        [templatePath]: JSON.stringify(upgradedTemplate),
      },
    });

    const result = await bootstrapEngineRuntime({
      runtimeRoot: ROOT,
      userData: USER_DATA,
      configPath,
      io,
    });

    expect(result.engineVersion).toBeNull();
    expect(result.mergedKeys).toEqual([]);
    expect(written).not.toContain(configPath);
  });

  it('写回失败只告警（不阻断启动）', async () => {
    const { io } = stubIO({
      files: {
        [configPath]: JSON.stringify({ agents: { defaults: { workspace: 'D:/mine' } } }),
        [templatePath]: JSON.stringify(upgradedTemplate),
        [manifestPath]: JSON.stringify(manifest),
        [stampPath]: JSON.stringify({ engineVersion: '0.2.0' }),
      },
      failWrite: configPath,
    });

    const result = await bootstrapEngineRuntime({
      runtimeRoot: ROOT,
      userData: USER_DATA,
      configPath,
      io,
    });

    expect(result.warnings.join('\n')).toContain('深合并失败');
  });
});

describe('mergeMissingKeys', () => {
  it('workspace 占位符永远不参与合并', () => {
    const target: Record<string, unknown> = { agents: { defaults: {} } };
    mergeMissingKeys(target, {
      agents: { defaults: { workspace: WORKSPACE_PLACEHOLDER } },
    });
    expect((target.agents as any).defaults).toEqual({});
  });

  it('数组视为叶子：已存在的数组不做元素级追补', () => {
    const target: Record<string, unknown> = { list: ['a'] };
    mergeMissingKeys(target, { list: ['a', 'b'] });
    expect(target.list).toEqual(['a']);
  });

  it('显式 null 也算"用户值"，不被模板顶掉', () => {
    const target: Record<string, unknown> = { model: null };
    mergeMissingKeys(target, { model: 'qwen' });
    expect(target.model).toBeNull();
  });
});

describe('replacePlaceholder', () => {
  it('嵌套对象与数组里的占位符都要换掉', () => {
    const value = replacePlaceholder(
      { a: WORKSPACE_PLACEHOLDER, b: [{ c: WORKSPACE_PLACEHOLDER }] },
      'X',
    );
    expect(JSON.stringify(value)).not.toContain(WORKSPACE_PLACEHOLDER);
    expect(JSON.stringify(value)).toContain('"X"');
  });
});
