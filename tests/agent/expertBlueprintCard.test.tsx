/**
 * 专家蓝图卡片：消息里的「保存」按钮到底落没落库。
 *
 * 这条链路的每一环都可能静默失败：解析出来但按钮没接上、点了一直新建副本、
 * 或者把「已保存」显示成「保存」让人重复点。所以断言只盯**可观察结果**：
 * store 里多没多、多几条、按钮文案变没变。
 */

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { buttonByText, click, flush, mount, unmount } from '../helpers/reactMount';
import { ExpertBlueprintCard } from '@/components/agents/ExpertBlueprintCard';
import { normalizeExpertBlueprint } from '@/lib/agent/expertBlueprint';
import { useAgentsStore } from '@/stores/agentsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';

const mountCard = (payload: Record<string, unknown>) =>
  mount(
    <MemoryRouter>
      <ExpertBlueprintCard blueprint={normalizeExpertBlueprint(payload)!} />
    </MemoryRouter>,
  );

beforeEach(() => {
  useAgentsStore.setState({ agents: [], tombstones: {}, activeAgentId: null });
  useExpertGroupsStore.setState({ groups: [], tombstones: {}, activeGroupId: null });
});

describe('ExpertBlueprintCard', () => {
  it('点「保存为专家」后落入 agents store，按钮变成已保存', async () => {
    const host = mountCard({
      kind: 'agent',
      name: '跨境电商合规顾问',
      description: '帮跨境卖家过合规',
      systemPrompt: '你是跨境电商合规顾问。',
    });

    click(buttonByText(host, '保存为专家'));
    await flush();

    const agents = useAgentsStore.getState().agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('跨境电商合规顾问');
    expect(agents[0].systemPrompt).toBe('你是跨境电商合规顾问。');
    expect(buttonByText(host, '保存为专家')).toBeNull();
    expect(host.textContent).toContain('已保存到「我的专家」');
  });

  it('连点不会造出两份同名专家（保存后按钮已消失）', async () => {
    const host = mountCard({ kind: 'agent', name: '甲', systemPrompt: 'p' });
    click(buttonByText(host, '保存为专家'));
    await flush();
    // 已保存态下保存按钮不再存在 —— 这才是「点不到第二次」的真正保证，
    // 比在 onClick 里加个 flag 更可靠（后者在重渲染后仍可能被连点穿透）。
    expect(buttonByText(host, '保存为专家')).toBeNull();
    expect(useAgentsStore.getState().agents).toHaveLength(1);
  });

  it('专家团一次落成「N 位成员 + 1 个团」', async () => {
    const host = mountCard({
      kind: 'team',
      name: '选品作战团',
      description: '全流程',
      members: [
        { name: '齐活林', role: '交付总监', systemPrompt: 'a' },
        { name: '许清楚', role: '产品经理', systemPrompt: 'b' },
      ],
    });

    expect(host.textContent).toContain('齐活林');
    expect(host.textContent).toContain('许清楚');

    click(buttonByText(host, '保存为专家团'));
    await flush();

    expect(useAgentsStore.getState().agents).toHaveLength(2);
    const groups = useExpertGroupsStore.getState().groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toHaveLength(2);
  });

  it('降级说明可见（否则用户以为模型少写了内容）', () => {
    const host = mountCard({
      kind: 'team',
      name: '团',
      members: [{ name: '甲', role: '研究员' }],
    });
    expect(host.textContent).toContain('没有提示词');
  });
});
