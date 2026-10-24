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

/**
 * 知识库绑定走的是同一组不对称（FR-2.3 第四条 / M7）。
 *
 * 三个字段点都要覆盖，任何一个漏了症状都一样：**保存后看起来正常，重启就没了**。
 * `- 内置条目那一段**最容易漏**，因为它是逐字段手抄的。
 */
describe('知识库绑定：三条写路径都要带上 knowledge', () => {
  const BINDING = { orgId: 'o1', kbIds: ['k1'] };

  it('createAgent（白名单构造）会落库', () => {
    const created = useAgentsStore.getState().createAgent({
      name: '随身制度顾问',
      systemPrompt: '按制度回答',
      knowledge: BINDING,
    });
    const stored = useAgentsStore.getState().agents.find((a) => a.id === created.id);
    expect(stored?.knowledge).toEqual(BINDING);
  });

  it('createAgent 不传时是 undefined（不是空绑定）', () => {
    const created = useAgentsStore.getState().createAgent({ name: 'x', systemPrompt: 'y' });
    expect(created.knowledge).toBeUndefined();
  });

  it('updateAgent 能改也能清（清 = 回 undefined，而不是留着旧组织）', () => {
    const a = useAgentsStore.getState().createAgent({ name: 'x', systemPrompt: 'y' });
    useAgentsStore.getState().updateAgent(a.id, { knowledge: BINDING });
    expect(
      useAgentsStore.getState().agents.find((x) => x.id === a.id)?.knowledge,
    ).toEqual(BINDING);

    useAgentsStore.getState().updateAgent(a.id, { knowledge: undefined });
    expect(
      useAgentsStore.getState().agents.find((x) => x.id === a.id)?.knowledge,
    ).toBeUndefined();
  });

  it('mergeAgents 保留内置专家身上的知识库绑定（漏这个字段 = 重启后静默消失）', () => {
    const doc = BUILTIN_AGENTS.find((a) => a.id === 'builtin:doc')!;
    useAgentsStore.setState({ agents: [{ ...doc, knowledge: BINDING }], tombstones: {} });
    useAgentsStore.getState().refresh();

    const merged = useAgentsStore.getState().agents.find((a) => a.id === 'builtin:doc');
    expect(merged?.knowledge).toEqual(BINDING);
  });
});
