/**
 * 自动更新状态机（B4-01）。
 *
 * 真实下载/安装只能在真机验证，但「事件 → 界面状态」是纯逻辑，而且错了**不报错**：
 * 最典型的是把 `error` 显示成「已是最新」——用户看到一句「最新版」，永远升不上去。
 * 这里用替身把每条分支钉死。
 */

import { describe, expect, it, vi } from 'vitest';
import { createUpdateController, type UpdaterLike } from '../../electron/updater';
import type { UpdateStatus } from '../../src/types/update';

type CheckMode = 'available' | 'not-available' | 'throw';
type DownloadMode = 'ok' | 'throw';

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls: Array<[boolean | undefined, boolean | undefined]> = [];

  private handlers = new Map<string, Array<(...args: never[]) => void>>();

  constructor(
    private readonly opts: {
      check?: CheckMode;
      download?: DownloadMode;
      version?: string;
    } = {},
  ) {}

  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (...a: unknown[]) => void)(...args);
    }
  }

  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    this.emit('checking-for-update');
    if (this.opts.check === 'throw') throw new Error('feed unreachable');
    if (this.opts.check === 'not-available') {
      this.emit('update-not-available', {});
      return null;
    }
    this.emit('update-available', { version: this.opts.version ?? '0.2.0' });
    return null;
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1;
    if (this.opts.download === 'throw') throw new Error('download failed');
    this.emit('download-progress', { percent: 42 });
    this.emit('update-downloaded', { version: this.opts.version ?? '0.2.0' });
    return [];
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installCalls.push([isSilent, isForceRunAfter]);
  }
}

function harness(opts: { packaged?: boolean; updater?: FakeUpdater } = {}) {
  const updater = opts.updater ?? new FakeUpdater();
  const emitted: UpdateStatus[] = [];
  const controller = createUpdateController({
    updater,
    isPackaged: opts.packaged ?? true,
    currentVersion: '0.1.0',
    emit: (status) => emitted.push(status),
  });
  return { updater, controller, emitted };
}

describe('createUpdateController', () => {
  it('未打包（开发态）直接判 unsupported，且不调用 checkForUpdates', async () => {
    const { updater, controller } = harness({ packaged: false });

    expect(controller.getStatus().phase).toBe('unsupported');
    const status = await controller.check();

    expect(status.phase).toBe('unsupported');
    // 开发态没有 app-update.yml，真去 check 只会抛一个看起来像「发布坏了」的错。
    expect(updater.checkCalls).toBe(0);
  });

  it('创建时固定 autoDownload=false、autoInstallOnAppQuit=true', () => {
    const { updater } = harness();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it('available → 下载 → 进度 → downloaded 的完整链路', async () => {
    const { updater, controller, emitted } = harness({
      updater: new FakeUpdater({ check: 'available', version: '0.2.0' }),
    });

    const checked = await controller.check();
    expect(checked.phase).toBe('available');
    expect(checked.availableVersion).toBe('0.2.0');

    const downloaded = await controller.download();
    expect(downloaded.phase).toBe('downloaded');
    expect(downloaded.availableVersion).toBe('0.2.0');
    expect(downloaded.percent).toBe(100);

    // 事件顺序：checking → available → downloading(0) → downloading(42) → downloaded
    expect(emitted.map((s) => s.phase)).toEqual([
      'checking',
      'checking',
      'available',
      'downloading',
      'downloading',
      'downloaded',
    ]);
  });

  it('只有 update-not-available 才产出「已是最新」', async () => {
    const { controller } = harness({
      updater: new FakeUpdater({ check: 'not-available' }),
    });

    const status = await controller.check();

    expect(status.phase).toBe('up-to-date');
    expect(status.message).toBeUndefined();
  });

  it('检查抛错时是 error，绝不是「已是最新」', async () => {
    const { controller } = harness({ updater: new FakeUpdater({ check: 'throw' }) });

    const status = await controller.check();

    expect(status.phase).toBe('error');
    expect(status.message).toContain('feed unreachable');
  });

  it('updater 自己抛 error 事件时同样落到 error', () => {
    const { updater, controller } = harness();
    updater.emit('error', new Error('signature rejected'));
    expect(controller.getStatus().phase).toBe('error');
    expect(controller.getStatus().message).toContain('signature rejected');
  });

  it('download 只在 available 时执行', async () => {
    const { updater, controller } = harness();

    const status = await controller.download();

    expect(status.phase).toBe('idle');
    expect(updater.downloadCalls).toBe(0);
  });

  it('install 只在 downloaded 时发起，并用 (false, true) 重启', async () => {
    const { updater, controller } = harness({
      updater: new FakeUpdater({ check: 'available' }),
    });

    // 未下载完：不能把用户踢下线却什么都没装
    expect(controller.install()).toBe(false);
    expect(updater.installCalls).toEqual([]);

    await controller.check();
    await controller.download();
    expect(controller.install()).toBe(true);
    expect(updater.installCalls).toEqual([[false, true]]);
  });

  it('下载进度越界会被夹到 0–100', async () => {
    const { updater, controller, emitted } = harness({
      updater: new FakeUpdater({ check: 'available' }),
    });
    await controller.check();
    updater.emit('download-progress', { percent: 150 });
    updater.emit('download-progress', { percent: Number.NaN });

    const progress = emitted.filter((s) => s.phase === 'downloading');
    expect(progress.at(-2)?.percent).toBe(100);
    expect(progress.at(-1)?.percent).toBeUndefined();
  });

  it('下载失败落到 error，phase 不再是 downloading', async () => {
    const { controller } = harness({
      updater: new FakeUpdater({ check: 'available', download: 'throw' }),
    });
    await controller.check();

    const status = await controller.download();

    expect(status.phase).toBe('error');
    expect(status.message).toContain('download failed');
  });
});
