/**
 * toolsPolicyStore（FR-8.4 写策略的状态层）。
 *
 * 纯逻辑（策略在 config.json 里怎么读写）锁在 `tests/electron/toolsPolicyConfig.test.ts`，
 * 分区渲染锁在 `tests/settingsDialogSections.test.tsx`。这里只锁 store 这一层的两件事：
 *
 * 1. **桥说失败就不装作成功**：主进程拒绝写入时不能把状态改成「已保存」，
 *    否则界面显示「配好了」，而文件里一个字没变。
 * 2. **并发去重 + 以盘为准回读**：进入分区与勾选开关常常同时发生；写完必须
 *    重读一次——主进程会补出 `tools.file` 段（原先可能整段不存在），
 *    拿本地乐观状态显示就与磁盘形状对不上。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { useToolsPolicyStore } from '@/stores/toolsPolicyStore';
import type {
  NanobotFileToolsPolicy,
  NanobotToolsSnapshot,
  ToolsSyncResult,
} from '@/platform/types';

const getTools = vi.fn<() => Promise<NanobotToolsSnapshot | null>>();
const syncTools = vi.fn<(json: string) => Promise<ToolsSyncResult>>();

/** 桥回传的形状（`NanobotToolsSnapshot`，带 `file` 那层包装） */
function bridgeSnapshot(defaultDenyWrite: boolean): NanobotToolsSnapshot {
  return { file: { defaultDenyWrite, supported: true } };
}

/**
 * store 里的形状——**拆掉 `file` 那一层的扁平策略**。
 *
 * 两种形状不能互相顶替：`state.policy` 存的是扁平的 `{defaultDenyWrite, supported}`，
 * 桥回传的是 `{ file: {...} }`。断言时拿错形状，永远报 `undefined`，而看代码
 * 「明明字段叫 defaultDenyWrite」却找不到为什么拿到 undefined。
 */
function flatPolicy(defaultDenyWrite: boolean, supported = true): NanobotFileToolsPolicy {
  return { defaultDenyWrite, supported };
}

beforeEach(() => {
  vi.restoreAllMocks();
  getTools.mockReset();
  syncTools.mockReset();
  vi.spyOn(platform, 'getNanobotTools').mockImplementation(() => getTools());
  vi.spyOn(platform, 'syncNanobotTools').mockImplementation((json) => syncTools(json));
  useToolsPolicyStore.setState({
    policy: null,
    policyAvailable: false,
    policyLoading: false,
  });
});

describe('loadPolicy', () => {
  it('段存在 → 连 supported 一起带回来', async () => {
    getTools.mockResolvedValue(bridgeSnapshot(true));
    await useToolsPolicyStore.getState().loadPolicy();
    // ⚠️ state.policy 是**扁平**策略（store 已经把快照里的 `file` 拆开了），
    // 不是桥回传的那层 `{ file: ... }` 包装——拿错形状断言永远拿到 undefined
    expect(useToolsPolicyStore.getState().policy).toEqual({
      defaultDenyWrite: true,
      supported: true,
    });
    expect(useToolsPolicyStore.getState().policyAvailable).toBe(true);
  });

  it('段缺失（supported:false）仍算「可读」——那是引擎没这个落点，不是读不到', async () => {
    getTools.mockResolvedValue({ file: { defaultDenyWrite: false, supported: false } });
    await useToolsPolicyStore.getState().loadPolicy();
    expect(useToolsPolicyStore.getState().policy?.supported).toBe(false);
    expect(useToolsPolicyStore.getState().policyAvailable).toBe(true);
  });

  it('桥返回 null（Web 端 / 找不到 config.json）→ 可用性标 false 而不是塞一个 false', async () => {
    getTools.mockResolvedValue(null);
    await useToolsPolicyStore.getState().loadPolicy();
    expect(useToolsPolicyStore.getState().policy).toBeNull();
    expect(useToolsPolicyStore.getState().policyAvailable).toBe(false);
  });

  it('桥抛错 → 保留上一次的状态，只把可用性标 false', async () => {
    useToolsPolicyStore.setState({ policy: flatPolicy(false), policyAvailable: true });
    getTools.mockRejectedValue(new Error('boom'));
    await useToolsPolicyStore.getState().loadPolicy();
    expect(useToolsPolicyStore.getState().policy?.defaultDenyWrite).toBe(false);
  });

  it('并发调用复用同一次回读（不重复打桥）', async () => {
    getTools.mockResolvedValue(bridgeSnapshot(false));
    await Promise.all([
      useToolsPolicyStore.getState().loadPolicy(),
      useToolsPolicyStore.getState().loadPolicy(),
    ]);
    expect(getTools).toHaveBeenCalledTimes(1);
  });
});

describe('setDefaultDenyWrite', () => {
  it('写入成功 → 以磁盘为准回读一次', async () => {
    getTools.mockResolvedValue(bridgeSnapshot(true));
    syncTools.mockResolvedValue({ ok: true, message: 'ok', changed: true });
    await useToolsPolicyStore.getState().setDefaultDenyWrite(true);
    expect(syncTools).toHaveBeenCalledTimes(1);
    expect(JSON.parse(syncTools.mock.calls[0][0])).toEqual({
      op: 'setDefaultDenyWrite',
      defaultDenyWrite: true,
    });
    expect(useToolsPolicyStore.getState().policy?.defaultDenyWrite).toBe(true);
  });

  it('主进程拒绝 → 不回读、状态不动（不能显示成「已保存」）', async () => {
    useToolsPolicyStore.setState({ policy: flatPolicy(false), policyAvailable: true });
    syncTools.mockResolvedValue({ ok: false, message: '配置格式非法' });
    const ok = await useToolsPolicyStore.getState().setDefaultDenyWrite(true);
    expect(ok).toBe(false);
    expect(getTools).not.toHaveBeenCalled();
    expect(useToolsPolicyStore.getState().policy?.defaultDenyWrite).toBe(false);
  });

  it('failover 之外的另一条：桥拿到的是磁盘现状，不是本地乐观值', async () => {
    // 主进程会把 `tools.file` 段补出来（原先可能整段不存在）→ 回读给出 supported:true，
    // 显示的是「磁盘上的形状」而不是「刚才点了什么」
    getTools.mockResolvedValue(bridgeSnapshot(true));
    syncTools.mockResolvedValue({ ok: true, message: 'ok', changed: true });
    useToolsPolicyStore.setState({ policy: flatPolicy(false, false) });
    await useToolsPolicyStore.getState().setDefaultDenyWrite(true);
    expect(useToolsPolicyStore.getState().policy).toEqual({
      defaultDenyWrite: true,
      supported: true,
    });
  });
});
