/**
 * 专家模型绑定在 store 两条写路径上的往返（FR-2.3）。
 *
 * ⚠️ 这条用例盯的是 store 里**最容易漏、又最难发现**的一处不对称：
 * `createAgent` 是**白名单式构造**（逐字段抄），`updateAgent` 是**展开赋值**
 * （`{...a, ...patch}`）。加一个新字段时只改后者不报错、测试也不会红，
 * 症状是「新建专家时选的模型在保存瞬间消失」——而编辑已有专家一切正常，
 * 于是用户会以为是自己没选上。
 *
 * `mergeAgents` 那一半同理：内置条目的用户覆盖是逐字段列的，漏一项 =
 * 「改了内置专家的模型，重启后变回内置值」。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentsStore } from '@/stores/agentsStore';
import { BUILTIN_AGENTS } from '@/ai/builtinAgents';

beforeEach(() => {
  // 每个用例都从干净的代码真源出发（store 是模块级单例）
  useAgentsStore.setState({ agents: BUILTIN_AGENTS.map((a) => ({ ...a })), tombstones: {} });
});

describe('createAgent：白名单必须带上 model', () => {
  it('创建时传入的模型会落库', () => {
    const created = useAgentsStore.getState().createAgent({
      name: '测试专家',
      systemPrompt: '你是测试专家',
      model: 'qwen',
    });

    expect(created.model).toBe('qwen');
    const stored = useAgentsStore.getState().agents.find((a) => a.id === created.id);
    expect(stored?.model).toBe('qwen');
  });

  it('不传则不带该字段（不是空串）', () => {
    const created = useAgentsStore.getState().createAgent({ name: 'x', systemPrompt: 'y' });
    expect(created.model).toBeUndefined();
  });
});

describe('updateAgent：展开赋值天然带上 model（含清空）', () => {
  it('可以改成一个新预设', () => {
    const a = useAgentsStore.getState().createAgent({ name: 'x', systemPrompt: 'y' });
    useAgentsStore.getState().updateAgent(a.id, { model: 'claude' });
    const stored = useAgentsStore.getState().agents.find((x) => x.id === a.id);
    expect(stored?.model).toBe('claude');
  });

  it('清空（空串）会原样存住，不退化成「未设置」', () => {
    // 空串是「显式不绑定」，与 undefined（从未设置）在语义上不同：
    // 前者要让 mergeAgents 里 `over.model ?? b.model` 求值成 ''（真的清掉）
    const a = useAgentsStore.getState().createAgent({ name: 'x', systemPrompt: 'y' });
    useAgentsStore.getState().updateAgent(a.id, { model: 'claude' });
    useAgentsStore.getState().updateAgent(a.id, { model: '' });
    const stored = useAgentsStore.getState().agents.find((x) => x.id === a.id);
    expect(stored?.model).toBe('');
  });
});

describe('mergeAgents：内置条目的模型覆盖', () => {
  it('用户给内置专家设的模型在 refresh 后保留', () => {
    const doc = BUILTIN_AGENTS.find((a) => a.id === 'builtin:doc')!;
    useAgentsStore.setState({ agents: [{ ...doc, model: 'qwen' }], tombstones: {} });
    useAgentsStore.getState().refresh();

    const merged = useAgentsStore.getState().agents.find((a) => a.id === 'builtin:doc');
    expect(merged?.model).toBe('qwen');
    // 代码仍是真源：其它内置条目必须被补回来，不能因为只存了一条就只剩一条
    expect(useAgentsStore.getState().agents.length).toBeGreaterThanOrEqual(
      BUILTIN_AGENTS.length,
    );
  });

  it('用户清空（空串）后不会被内置值盖回去', () => {
    // `'' ?? b.model` 求值为 `''`。当前内置条目都不绑模型，所以这条实际是
    // 「空串原样保留」；等将来某条内置模板绑了模型，它同时覆盖「能真的清掉」。
    const doc = BUILTIN_AGENTS.find((a) => a.id === 'builtin:doc')!;
    useAgentsStore.setState({ agents: [{ ...doc, model: '' }], tombstones: {} });
    useAgentsStore.getState().refresh();

    const merged = useAgentsStore.getState().agents.find((a) => a.id === 'builtin:doc');
    expect(merged?.model).toBe('');
  });
});
