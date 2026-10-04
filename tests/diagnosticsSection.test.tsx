/**
 * 设置弹窗「诊断」分区（FR-11.2 / FR-11.3 的出口）。
 *
 * 锁三件事，都是「看起来像小事、实际会误导人」的：
 *
 * 1. 三种「没有数据」分开说：加载中 / 读不到（Web 端）/ 读到了但确实没记录；
 * 2. 导出**取消**不报错（保存对话框里按 Esc 是最常见的操作，弹红 toast 会让人
 *    以为导出失败）；
 * 3. 打开目录失败要说出来（目录还没建出来是最常见的情况，静默失败看起来像按钮坏了）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { useToastStore } from '@/components/Toast';
import { DiagnosticsSection } from '@/components/settings/sections/DiagnosticsSection';
import { buttonByText, click, flush, mount, unmount } from './helpers/reactMount';
import type { DiagnosticsStats } from '@/platform/types';

function stats(patch: Partial<DiagnosticsStats> = {}): DiagnosticsStats {
  return {
    logsDir: 'C:/Users/u/AppData/Roaming/nanowork/logs',
    tracesDir: 'C:/Users/u/AppData/Roaming/nanowork/traces',
    logFiles: 12,
    logBytes: 48 * 1024,
    traceFiles: 3,
    traceBytes: 3 * 1024 * 1024,
    logDates: ['2026-10-03', '2026-10-04'],
    ...patch,
  };
}

const diagnosticsStats = vi.fn();
const exportDiagnostics = vi.fn();
const openPath = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  useToastStore.setState({ items: [] });
  diagnosticsStats.mockReset().mockResolvedValue(stats());
  exportDiagnostics.mockReset().mockResolvedValue({ ok: true, path: 'D:/out.zip', bytes: 2048, entryCount: 9, skipped: 0 });
  openPath.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(platform, 'diagnosticsStats').mockImplementation(diagnosticsStats);
  vi.spyOn(platform, 'exportDiagnostics').mockImplementation(exportDiagnostics);
  vi.spyOn(platform, 'openPath').mockImplementation(openPath);
});

describe('DiagnosticsSection：三种「没有数据」分开说', () => {
  it('读不到（Web 端）时说明原因，而不是显示一堆零', async () => {
    diagnosticsStats.mockResolvedValue(null);
    const host = mount(<DiagnosticsSection />);
    await flush();

    expect(host.textContent).toContain('当前环境没有本地数据目录');
    expect(host.textContent).toContain('桌面端');
    // 不该出现「打开目录」这种点了必然失败的按钮
    expect(buttonByText(host, '打开目录')).toBeNull();
    unmount();
  });

  it('读到但确实没有记录时，给出下一步（跑一轮对话）', async () => {
    diagnosticsStats.mockResolvedValue(stats({ logFiles: 0, traceFiles: 0, logBytes: 0, traceBytes: 0, logDates: [] }));
    const host = mount(<DiagnosticsSection />);
    await flush();

    expect(host.textContent).toContain('还没有日志文件');
    expect(host.textContent).toContain('还没有 trace');
    expect(host.textContent).toContain('还没有任何诊断产物');
    unmount();
  });

  it('有数据时显示落点与体量', async () => {
    const host = mount(<DiagnosticsSection />);
    await flush();

    const text = host.textContent ?? '';
    expect(text).toContain('C:/Users/u/AppData/Roaming/nanowork/logs');
    expect(text).toContain('12 个文件');
    expect(text).toContain('覆盖 2 天');
    expect(text).toContain('3 份');
    unmount();
  });
});

describe('DiagnosticsSection：导出', () => {
  it('成功时提示路径与体量', async () => {
    const host = mount(<DiagnosticsSection />);
    await flush();

    click(buttonByText(host, '导出…'));
    await flush();

    expect(exportDiagnostics).toHaveBeenCalledTimes(1);
    const toast = useToastStore.getState().items.at(-1);
    expect(toast?.severity).toBe('success');
    expect(toast?.message).toContain('已导出诊断包');
    expect(toast?.message).toContain('9 个文件');
    unmount();
  });

  it('用户取消**不是**错误：不弹任何提示', async () => {
    exportDiagnostics.mockResolvedValue({ ok: false, canceled: true });
    const host = mount(<DiagnosticsSection />);
    await flush();

    click(buttonByText(host, '导出…'));
    await flush();

    expect(useToastStore.getState().items).toHaveLength(0);
    unmount();
  });

  it('失败时报出原因', async () => {
    exportDiagnostics.mockResolvedValue({ ok: false, error: '磁盘已满' });
    const host = mount(<DiagnosticsSection />);
    await flush();

    click(buttonByText(host, '导出…'));
    await flush();

    const toast = useToastStore.getState().items.at(-1);
    expect(toast?.severity).toBe('error');
    expect(toast?.message).toContain('磁盘已满');
    unmount();
  });

  it('略过文件时如实说明（不让人以为「就这些」）', async () => {
    exportDiagnostics.mockResolvedValue({ ok: true, path: 'D:/out.zip', bytes: 2048, entryCount: 5, skipped: 7 });
    const host = mount(<DiagnosticsSection />);
    await flush();

    click(buttonByText(host, '导出…'));
    await flush();

    expect(useToastStore.getState().items.at(-1)?.message).toContain('略过 7 个文件');
    unmount();
  });
});

describe('DiagnosticsSection：打开目录', () => {
  it('成功时静默（没有 toast 刷屏）', async () => {
    const host = mount(<DiagnosticsSection />);
    await flush();

    click(buttonByText(host, '打开目录'));
    await flush();

    expect(openPath).toHaveBeenCalledWith('C:/Users/u/AppData/Roaming/nanowork/logs');
    expect(useToastStore.getState().items).toHaveLength(0);
    unmount();
  });

  it('失败时说出来（目录还没建出来是最常见的情况）', async () => {
    openPath.mockResolvedValue({ ok: false, error: '路径不存在' });
    const host = mount(<DiagnosticsSection />);
    await flush();

    click(buttonByText(host, '打开目录'));
    await flush();

    const toast = useToastStore.getState().items.at(-1);
    expect(toast?.severity).toBe('error');
    expect(toast?.message).toContain('打不开目录');
    unmount();
  });
});
