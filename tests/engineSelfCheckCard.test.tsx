/**
 * 引擎自检卡片（FR-13.6，B5-04）。
 *
 * 这一屏是「黑盒 → 可操作」的唯一出口，所以钉的是**信息有没有落到界面上**：
 *
 * 1. **三项分别显示**，且状态不合并 —— 合成一句「引擎启动失败」等于把黑盒换个地方摆；
 * 2. **失败时真实路径与真实命令要出现在界面上**（验收①的 UI 侧：venv 改名后用户看到的
 *    必须是「找过这些路径」，而不是「引擎不可用」）；
 * 3. **Web 端说「不适用」而不是报红** —— `platform.engineSelfCheck()` 在 Web 返回
 *    `null`，那是「没有本地引擎这回事」，把它显示成三条红会让 Web 用户以为坏了。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { EngineSelfCheckCard } from '@/components/settings/sections/EngineSelfCheckCard';
import type { EngineSelfCheckReport } from '@/types/engine';
import { buttonByText, click, flush, mount, unmount } from './helpers/reactMount';

const PYTHON = 'C:\\app\\nanobot\\nanobot\\.venv\\Scripts\\python.exe';
const SCRIPT = 'C:\\app\\nanobot\\nanobot\\.venv\\Scripts\\nanobot.exe';
const VENV = 'C:\\app\\nanobot\\nanobot\\.venv';
const CONFIG = 'C:\\app\\nanowork.config.json';

function okReport(): EngineSelfCheckReport {
  return {
    checkedAt: '2026-10-16T12:00:00.000Z',
    ok: true,
    findings: [
      { id: 'interpreter', title: '引擎解释器', status: 'ok', summary: `解释器可用：${PYTHON}`, detail: null, remedy: null },
      { id: 'engine-import', title: '引擎包导入', status: 'ok', summary: '引擎包可导入', detail: null, remedy: null },
      { id: 'config', title: '配置文件校验', status: 'ok', summary: '配置文件通过引擎 schema 校验', detail: null, remedy: null },
    ],
    target: { bin: PYTHON, config: CONFIG, candidates: [PYTHON, SCRIPT], engineRoot: 'C:\\app' },
  };
}

function interpreterFailedReport(): EngineSelfCheckReport {
  return {
    ...okReport(),
    ok: false,
    findings: [
      {
        id: 'interpreter',
        title: '引擎解释器',
        status: 'failed',
        summary: `找不到引擎解释器：${PYTHON}`,
        detail: `按优先级找过这些路径：\n  - ${PYTHON}\n  - ${SCRIPT}`,
        remedy: {
          steps: ['本项目不打包 Python 运行时。', '重建 venv，或把 venv 改回候选路径。'],
          commands: [`python -m venv ${VENV}`, `${PYTHON} -m pip install -e C:\\app\\nanobot`],
          docPath: 'C:\\app\\docs\\engine-dev-setup.md',
        },
      },
      { id: 'engine-import', title: '引擎包导入', status: 'skipped', summary: '解释器不可达，跳过（先解决上一项）', detail: null, remedy: null },
      { id: 'config', title: '配置文件校验', status: 'skipped', summary: '解释器不可达，跳过（先解决第一项）', detail: null, remedy: null },
    ],
  };
}

function chipLabels(): string[] {
  return Array.from(document.querySelectorAll('.MuiChip-label')).map(
    (el) => el.textContent ?? '',
  );
}

const engineSelfCheck = vi.fn();

beforeEach(() => {
  engineSelfCheck.mockReset();
  vi.spyOn(platform, 'engineSelfCheck').mockImplementation((refresh?: boolean) =>
    engineSelfCheck(refresh),
  );
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('EngineSelfCheckCard', () => {
  it('三项全过：各显示一个「通过」，不出现「需处理」', async () => {
    engineSelfCheck.mockResolvedValue(okReport());

    const host = mount(<EngineSelfCheckCard />);
    await flush();

    expect(chipLabels()).toEqual(['通过', '通过', '通过']);
    expect(host.textContent).not.toContain('需处理');
    expect(host.textContent).toContain(PYTHON); // 「我在用哪个解释器」要看得见
  });

  it('解释器失败：判「需处理」，且**真实路径与真实命令出现在界面上**', async () => {
    engineSelfCheck.mockResolvedValue(interpreterFailedReport());

    const host = mount(<EngineSelfCheckCard />);
    await flush();

    expect(chipLabels()).toEqual(['需处理', '未判定', '未判定']);
    // 验收①的 UI 侧：用户要能看到「找过哪些路径」
    expect(host.textContent).toContain(PYTHON);
    expect(host.textContent).toContain(SCRIPT);
    // 命令可直接复制执行（含真实 venv 路径）
    expect(host.textContent).toContain(VENV);
    expect(host.textContent).toContain('pip install -e');
    expect(host.textContent).toContain('复制命令');
    // 步骤是「怎么修」，不是「哪里错了」的复述
    expect(host.textContent).toContain('重建 venv');
  });

  it('未判定的项不显示成失败（新装用户不该看到一片红）', async () => {
    const report = interpreterFailedReport();
    // 只有配置那一项「未判定」，另外两项通过
    report.ok = true;
    report.findings = [
      { ...report.findings[1], status: 'ok', summary: '解释器可用' },
      { ...report.findings[1], id: 'engine-import', status: 'ok', summary: '引擎包可导入' },
      { ...report.findings[2], status: 'skipped', summary: '配置文件还不存在，引擎首次启动时会生成默认配置' },
    ];
    engineSelfCheck.mockResolvedValue(report);

    const host = mount(<EngineSelfCheckCard />);
    await flush();

    expect(chipLabels()).toEqual(['通过', '通过', '未判定']);
    expect(host.textContent).not.toContain('需处理');
  });

  it('Web 端（返回 null）说「不适用」，不报红', async () => {
    engineSelfCheck.mockResolvedValue(null);

    const host = mount(<EngineSelfCheckCard />);
    await flush();

    expect(host.textContent).toContain('Web 端不适用');
    expect(chipLabels()).toEqual([]);
  });

  it('「重新自检」以 refresh=true 再要一份（而不是拿缓存）', async () => {
    engineSelfCheck.mockResolvedValue(okReport());

    const host = mount(<EngineSelfCheckCard />);
    await flush();
    expect(engineSelfCheck).toHaveBeenLastCalledWith(false);

    click(buttonByText(host, '重新自检'));
    await flush();

    expect(engineSelfCheck).toHaveBeenCalledTimes(2);
    expect(engineSelfCheck).toHaveBeenLastCalledWith(true);
  });

  it('主进程调用失败时显示原因，而不是静默空白', async () => {
    engineSelfCheck.mockRejectedValue(new Error('IPC 通道不可用'));

    const host = mount(<EngineSelfCheckCard />);
    await flush();

    expect(host.textContent).toContain('自检失败');
    expect(host.textContent).toContain('IPC 通道不可用');
  });

  it('显示检查时间（把旧报告当成现状是最常见的误判）', async () => {
    engineSelfCheck.mockResolvedValue(okReport());

    const host = mount(<EngineSelfCheckCard />);
    await flush();

    expect(host.textContent).toContain('2026-10-16 12:00:00');
  });
});
