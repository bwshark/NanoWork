import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { WebStorageAdapter } from '@/platform/storage.web';
import type { AppInfo } from '@/platform/types';
import {
  DEVICE_ID_STORAGE_KEY,
  __resetDeviceIdForTest,
  currentDeviceId,
  getDeviceId,
} from '@/lib/core/deviceId';

function appInfo(deviceId: string): AppInfo {
  return {
    appName: 'NanoWork',
    version: '0.0.0',
    electron: '0.0.0',
    node: '0.0.0',
    chrome: '0.0.0',
    platform: 'win32',
    osVersion: '10',
    arch: 'x64',
    deviceId,
  };
}

describe('getDeviceId', () => {
  beforeEach(() => {
    __resetDeviceIdForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetDeviceIdForTest();
  });

  it('Electron：取主进程已生成的设备 ID，不自己生成、不写存储', async () => {
    // 自己生成就会得到第二个 id：界面上「设备 ID」与同步元数据里的 updatedBy 对不上
    const setSpy = vi.spyOn(WebStorageAdapter.prototype, 'set');
    vi.spyOn(platform, 'appInfo').mockResolvedValue(appInfo('dev-from-main'));

    await expect(getDeviceId()).resolves.toBe('dev-from-main');
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('Web（appInfo 为 null）：生成一次并持久化，此后恒为同一个值', async () => {
    vi.spyOn(platform, 'appInfo').mockResolvedValue(null);
    const setSpy = vi.spyOn(WebStorageAdapter.prototype, 'set');

    const first = await getDeviceId();
    const second = await getDeviceId();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    // 只写一次：反复生成会让「同一台设备」在同步层变成两台
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(DEVICE_ID_STORAGE_KEY, first);
    // 真的落进了 localStorage（WebStorageAdapter 自己带一层 JSON 序列化）
    expect(JSON.parse(window.localStorage.getItem(DEVICE_ID_STORAGE_KEY) ?? 'null')).toBe(first);
  });

  it('Web：重启（缓存清空）后读回同一个 id，而不是新生成一个', async () => {
    vi.spyOn(platform, 'appInfo').mockResolvedValue(null);
    const first = await getDeviceId();

    __resetDeviceIdForTest();
    const setSpy = vi.spyOn(WebStorageAdapter.prototype, 'set');
    const second = await getDeviceId();

    expect(second).toBe(first);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('并发调用只生成一个 id（否则同一台机器会拿到两个设备身份）', async () => {
    vi.spyOn(platform, 'appInfo').mockResolvedValue(null);
    const setSpy = vi.spyOn(WebStorageAdapter.prototype, 'set');

    const [a, b, c] = await Promise.all([getDeviceId(), getDeviceId(), getDeviceId()]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it('appInfo 抛错时降级为本地生成，不把异常抛给调用方', async () => {
    vi.spyOn(platform, 'appInfo').mockRejectedValue(new Error('ipc 挂了'));

    await expect(getDeviceId()).resolves.toBeTruthy();
  });

  it('主进程回的 deviceId 是空白串时按「没答」处理，走本地生成', async () => {
    vi.spyOn(platform, 'appInfo').mockResolvedValue(appInfo('   '));

    const id = await getDeviceId();
    expect(id.trim()).toBe(id);
    expect(id).not.toBe('');
  });
});

describe('currentDeviceId', () => {
  beforeEach(() => {
    __resetDeviceIdForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetDeviceIdForTest();
  });

  it('未预热返回 null —— 调用方据此延后写入，而不是拿空串当 updatedBy', () => {
    expect(currentDeviceId()).toBeNull();
  });

  it('预热后可同步读到同一个值（store 的写动作是同步的）', async () => {
    vi.spyOn(platform, 'appInfo').mockResolvedValue(appInfo('dev-sync'));

    const id = await getDeviceId();

    expect(currentDeviceId()).toBe(id);
    expect(currentDeviceId()).toBe('dev-sync');
  });

  it('重置用例状态会清空缓存（模块级状态不随 setState 归零）', async () => {
    vi.spyOn(platform, 'appInfo').mockResolvedValue(appInfo('dev-sync'));
    await getDeviceId();

    __resetDeviceIdForTest();

    expect(currentDeviceId()).toBeNull();
  });
});
