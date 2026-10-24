/**
 * 专家卡片上的知识库标记（FR-2.3 第四条）。
 *
 * 这个芯片存在的原因是「绑错了完全看不出来」：绑定只影响回答里会不会引用组织资料，
 * 没有芯片时唯一的现象是「这个专家好像不用资料」。所以用例断言的是
 * **两档文案必须能区分**（整个组织 vs 指定 N 个），以及未绑定时不占位。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { AgentKnowledgeChip } from '@/components/agents/AgentKnowledgeChip';
import { flush, mount, unmount } from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  await flush();
  unmount();
});

describe('AgentKnowledgeChip', () => {
  it('未绑定 / 组织为空时不渲染（不占一个空芯片位）', async () => {
    expect(mount(<AgentKnowledgeChip knowledge={undefined} />).textContent).toBe('');
    await flush();
    unmount();
    expect(mount(<AgentKnowledgeChip knowledge={{ orgId: '  ', kbIds: [] }} />).textContent).toBe(
      '',
    );
  });

  it('「整个组织可见范围」（kbIds 为空）说成组织知识库，而不是「0 个知识库」', async () => {
    const host = mount(<AgentKnowledgeChip knowledge={{ orgId: 'o1', kbIds: [] }} />);
    await flush();
    expect(host.textContent).toContain('组织知识库');
    expect(host.textContent).not.toContain('0');
  });

  it('指定库时给出数量（与「整个组织」是两种状态，不能都写「已绑定」）', async () => {
    const host = mount(<AgentKnowledgeChip knowledge={{ orgId: 'o1', kbIds: ['k1', 'k2'] }} />);
    await flush();
    expect(host.textContent).toContain('知识库 2 个');
  });
});
