/**
 * Agent 级提示词覆盖（design §13.1）。
 *
 * 字段语义是这个模块唯一容易出错的地方：`promptDomain` / `promptStyle` **省略
 * 就是「跟随全局」**，装配时由 `sessionsStore` 决定回退到 settings 还是内置默认。
 * 所以绝不能像 `name` 那样给一个兜底值——一旦在创建时把「没设置」落成 `general`，
 * 这个 Agent 就永久脱离了全局设置，而用户从没做过这个决定。
 *
 * 用例覆盖两条写入路径（这是真实踩过的坑）：`createAgent` 是**白名单式构造**，
 * 漏写字段就等于「新建时选的覆盖在保存瞬间消失」；`updateAgent` 是展开赋值。
 * 两者行为必须一致，否则只有「新建」会遇到问题，而编辑同一个 Agent 却正常。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentsStore } from '@/stores/agentsStore';

beforeEach(() => {
  window.localStorage.clear();
  // 恢复成出厂状态：内置 Agent 齐全、无用户 Agent
  useAgentsStore.setState({ agents: [], activeAgentId: null });
  useAgentsStore.getState().refresh();
});

describe('agentsStore：提示词覆盖字段', () => {
  it('createAgent 保留传入的覆盖值', () => {
    const agent = useAgentsStore.getState().createAgent({
      name: '工程助手',
      promptDomain: 'code',
      promptStyle: 'style-direct',
    });

    const stored = useAgentsStore.getState().agents.find((a) => a.id === agent.id);
    expect(stored?.promptDomain).toBe('code');
    expect(stored?.promptStyle).toBe('style-direct');
  });

  it('未设置时留 undefined（= 跟随全局），不落成默认值', () => {
    const agent = useAgentsStore.getState().createAgent({ name: '跟随全局的助手' });

    const stored = useAgentsStore.getState().agents.find((a) => a.id === agent.id);
    expect(stored?.promptDomain).toBeUndefined();
    expect(stored?.promptStyle).toBeUndefined();
  });

  it('updateAgent 可以逐字段清除覆盖、回到跟随全局', () => {
    const agent = useAgentsStore.getState().createAgent({
      name: '先覆盖再清除',
      promptDomain: 'design',
      promptStyle: 'style-creative',
    });

    useAgentsStore.getState().updateAgent(agent.id, {
      promptDomain: undefined,
      promptStyle: undefined,
    });

    const stored = useAgentsStore.getState().agents.find((a) => a.id === agent.id);
    expect(stored?.promptDomain).toBeUndefined();
    expect(stored?.promptStyle).toBeUndefined();
  });

  it('refresh 保留用户对内置 Agent 的覆盖', () => {
    const builtin = useAgentsStore
      .getState()
      .agents.find((a) => a.source === 'builtin');
    expect(builtin).toBeTruthy();

    useAgentsStore.getState().updateAgent(builtin!.id, {
      promptDomain: 'design',
      promptStyle: 'style-socratic',
    });
    useAgentsStore.getState().refresh();

    const after = useAgentsStore.getState().agents.find((a) => a.id === builtin!.id);
    expect(after?.promptDomain).toBe('design');
    expect(after?.promptStyle).toBe('style-socratic');
  });

  it('refresh 不把用户的覆盖涂回内置默认', () => {
    const builtin = useAgentsStore
      .getState()
      .agents.find((a) => a.source === 'builtin');
    // 内置 Agent 自己没声明覆盖时，用户也不设 → 仍是 undefined（跟随全局）
    expect(builtin?.promptDomain).toBeUndefined();

    useAgentsStore.getState().updateAgent(builtin!.id, { promptDomain: 'code' });
    useAgentsStore.getState().refresh();

    const after = useAgentsStore.getState().agents.find((a) => a.id === builtin!.id);
    expect(after?.promptDomain).toBe('code');
    // 未覆盖的那一维不受影响
    expect(after?.promptStyle).toBeUndefined();
  });
});
