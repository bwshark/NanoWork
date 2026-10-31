import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_META,
  detectPlatform,
  normalizeArch,
  parseRuntimeAsset,
} from '../scripts/lib/installerPlan.mjs';

/**
 * 打包计划里的纯逻辑。
 *
 * 这些判断的失败方式都是"看起来成功"：架构反推错了，构建日志一路正常，用户装完
 * 才发现引擎起不来；产物扩展名认错了，要么报"没打出来"，要么把 Windows 的 exe 当成
 * mac 的 dmg 去校验。所以逐条钉住，而不是靠"跑一次看看"。
 */

describe('normalizeArch', () => {
  it('认 node、PBS triple 与用户输入三种写法', () => {
    for (const value of ['x64', 'x86_64', 'amd64', 'X64']) {
      expect(normalizeArch(value)).toBe('x64');
    }
    for (const value of ['arm64', 'aarch64', 'ARM64']) {
      expect(normalizeArch(value)).toBe('arm64');
    }
  });

  it('不认识的架构返回 null（调用方据此报错，而不是默认成 x64）', () => {
    expect(normalizeArch('ia32')).toBeNull();
    expect(normalizeArch('')).toBeNull();
    expect(normalizeArch(undefined)).toBeNull();
  });
});

describe('parseRuntimeAsset', () => {
  it('认 uv 命名的三平台资产', () => {
    expect(parseRuntimeAsset('cpython-3.12.11-windows-x86_64-none')).toEqual({
      platform: 'win',
      arch: 'x64',
    });
    expect(parseRuntimeAsset('cpython-3.12.11-macos-aarch64-none')).toEqual({
      platform: 'mac',
      arch: 'arm64',
    });
    expect(parseRuntimeAsset('cpython-3.12.11-linux-x86_64-gnu')).toEqual({
      platform: 'linux',
      arch: 'x64',
    });
  });

  it('认 python-build-standalone 的 install_only 资产', () => {
    expect(
      parseRuntimeAsset('cpython-3.12.11+20241016-x86_64-apple-darwin-install_only.tar.gz'),
    ).toEqual({ platform: 'mac', arch: 'x64' });
    expect(
      parseRuntimeAsset('cpython-3.12.11+20241016-aarch64-apple-darwin-install_only.tar.gz'),
    ).toEqual({ platform: 'mac', arch: 'arm64' });
    expect(
      parseRuntimeAsset('cpython-3.12.11+20241016-aarch64-unknown-linux-gnu-install_only.tar.gz'),
    ).toEqual({ platform: 'linux', arch: 'arm64' });
  });

  it('本机现有 manifest 的资产名必须解析成 win/x64', () => {
    // 这条是防回归：当前 build/rt 就是这个名字，解析错会让 Windows 打包直接失败
    expect(parseRuntimeAsset('cpython-3.12.11-windows-x86_64-none')).toEqual({
      platform: 'win',
      arch: 'x64',
    });
  });

  it('识别不出平台/架构时返回 null，交给调用方决定（警告而不是猜）', () => {
    expect(parseRuntimeAsset('')).toEqual({ platform: null, arch: null });
    expect(parseRuntimeAsset('unknown-asset-name')).toEqual({ platform: null, arch: null });
  });

  it('mac 与 linux 的平台关键字不会互相误配', () => {
    expect(detectPlatform('cpython-3.12.11-macos-aarch64-none')).toBe('mac');
    expect(detectPlatform('cpython-3.12.11-linux-x86_64-gnu')).toBe('linux');
    expect(detectPlatform('cpython-3.12.11-windows-x86_64-none')).toBe('win');
  });
});

describe('产物匹配规则', () => {
  const matches = (platform: keyof typeof PLATFORM_META, fileName: string) =>
    PLATFORM_META[platform].artifacts.filter((spec) => spec.ext.test(fileName)).map((s) => s.kind);

  it('按 artifactName 模板产出的名字都能被认出来', () => {
    expect(matches('win', 'nanowork-0.1.0-win-x64.exe')).toEqual(['nsis']);
    expect(matches('mac', 'nanowork-0.1.0-mac-arm64.dmg')).toEqual(['dmg']);
    expect(matches('mac', 'nanowork-0.1.0-mac-x64.zip')).toEqual(['zip']);
    expect(matches('linux', 'nanowork-0.1.0-linux-x86_64.AppImage')).toEqual(['AppImage']);
    expect(matches('linux', 'nanowork-0.1.0-linux-amd64.deb')).toEqual(['deb']);
  });

  it('不会把别的平台的产物算进来（否则校验会拿错文件）', () => {
    expect(matches('mac', 'nanowork-0.1.0-win-x64.exe')).toEqual([]);
    expect(matches('linux', 'nanowork-0.1.0-mac-arm64.dmg')).toEqual([]);
    expect(matches('win', 'nanowork-0.1.0-linux-x86_64.AppImage')).toEqual([]);
  });

  it('runtimeProbe 能命中各平台归档/文件系统里的解释器路径', () => {
    expect(
      PLATFORM_META.win.runtimeProbe.test('resources\\rt\\python\\python.exe'),
    ).toBe(true);
    expect(
      PLATFORM_META.mac.runtimeProbe.test(
        '/Volumes/NanoWork/nanowork.app/Contents/Resources/rt/python/bin/python3',
      ),
    ).toBe(true);
    expect(
      PLATFORM_META.linux.runtimeProbe.test('./opt/nanowork/resources/rt/python/bin/python3'),
    ).toBe(true);
    // deb 里的 python3 是符号链接，dpkg-deb 会在行尾追加 "-> python3.12"，
    // 所以判据不能锚定行尾（锚了就永远判不到，等于这条校验白写）
    expect(
      PLATFORM_META.linux.runtimeProbe.test(
        'lrwxrwxrwx root/root 0 2026-10-31 12:00 ./opt/nanowork/resources/rt/python/bin/python3 -> python3.12',
      ),
    ).toBe(true);
    expect(PLATFORM_META.win.runtimeProbe.test('resources\\rt\\python\\python.exe.old')).toBe(true);
  });
});

describe('collect-artifacts 脚本（CI 上传清单）', () => {
  it('把安装包与 electron-updater 元数据一起列出来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nw-collect-'));
    try {
      for (const name of [
        'nanowork-0.1.0-mac-arm64.dmg',
        'nanowork-0.1.0-mac-arm64.zip',
        'latest-mac.yml',
        'nanowork-0.1.0-mac-arm64.dmg.blockmap',
      ]) {
        writeFileSync(join(dir, name), 'x');
      }
      const report = join(dir, 'artifacts.json');
      writeFileSync(
        report,
        JSON.stringify({
          platform: 'mac',
          arch: 'arm64',
          artifacts: [
            { kind: 'dmg', path: join(dir, 'nanowork-0.1.0-mac-arm64.dmg'), size: 1 },
            { kind: 'zip', path: join(dir, 'nanowork-0.1.0-mac-arm64.zip'), size: 1 },
          ],
        }),
      );
      const output = execFileSync(
        process.execPath,
        [resolve('scripts/collect-artifacts.mjs'), report],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .map((line) => line.replace(/\\/g, '/').split('/').pop());
      expect(output).toContain('nanowork-0.1.0-mac-arm64.dmg');
      expect(output).toContain('nanowork-0.1.0-mac-arm64.zip');
      expect(output).toContain('latest-mac.yml');
      expect(output).toContain('nanowork-0.1.0-mac-arm64.dmg.blockmap');
      expect(output).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('清单缺失时以非 0 退出（不能让 CI 静默上传空列表）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nw-collect-empty-'));
    try {
      mkdirSync(join(dir, 'sub'));
      expect(() =>
        execFileSync(process.execPath, [resolve('scripts/collect-artifacts.mjs'), join(dir, 'nope.json')], {
          stdio: 'pipe',
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
