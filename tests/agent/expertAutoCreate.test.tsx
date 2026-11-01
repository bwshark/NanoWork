/**
 * 「AI 自动创建专家 / 专家团」的动作接线。
 *
 * 守的是三件「做错了不报错」的事：
 *
 * 1. **技能必须真的挂到会话上** —— 漏了这一步，模型拿不到蓝图规约，
 *    会写出一段自由格式的答案，而界面看起来一切正常（只是永远没有保存按钮）；
 * 2. **新会话不继承当前专家人设** —— 否则模型会顶着别人的身份去设计专家；
 * 3. **技能被停用时不静默降级** —— 直接开一条没有规约的会话等于骗用户。
 */

import { act } from 'react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { click, flush, mount, unmount } from '../helpers/reactMount';
import {
  EXPERT_BUILDER_SKILL_ID,
  useExpertAutoCreate,
} from '@/components/agents/useExpertAutoCreate';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSkillsStore } from '@/stores/skillsStore';
import { SKILLS } from '@/ai/builtinSkills';
import { DEEP_LINK_PROMPT_KEY, readDeepLinkPrompt } from '@/types/deepLink';
import { resetEventStream } from '../helpers/eventStream';

function Probe() {
  const { startAutoCreate } = useExpertAutoCreate();
  const location = useLocation();
  const prompt = readDeepLinkPrompt(location.state) ?? '';
  return (
    <div>
      <button type="button" onClick={() => startAutoCreate('agent')}>
        自动创建专家
      </button>
      <button type="button" onClick={() => startAutoCreate('team')}>
        自动创建专家团
      </button>
      <span data-testid="prompt">{prompt}</span>
    </div>
  );
}

const mountProbe = () =>
  mount(
    <MemoryRouter initialEntries={['/agents']}>
      <Probe />
    </MemoryRouter>,
  );

const promptText = (host: HTMLElement) =>
  host.querySelector('[data-testid="prompt"]')?.textContent ?? '';

beforeEach(() => {
  useSessionsStore.setState({
    sessions: [],
    activeId: null,
    streams: {},
    pendingApprovals: [],
    error: null,
  });
  useSkillsStore.setState({ skills: SKILLS.map((s) => ({ ...s })) });
  resetEventStream();
});

afterEach(() => {
  unmount();
});

describe('useExpertAutoCreate', () => {
  it('新建一条挂了「专家创建」技能的空白会话，并带开场白跳到对话页', async () => {
    const host = mountProbe();
    click(host.querySelectorAll('button')[0]);
    await flush();

    const state = useSessionsStore.getState();
    expect(state.sessions).toHaveLength(1);
    const session = state.sessions[0];
    expect(state.activeId).toBe(session.id);
    expect(session.title).toBe('创建专家');
    expect(session.skillIds).toEqual([EXPERT_BUILDER_SKILL_ID]);
    // inheritCapabilities: false → agentId 落成空串，请求里省略 agent_id
    expect(session.agentId).toBe('');
    expect(promptText(host)).toContain('帮我创建一个 XXX 专家');
  });

  it('专家团用团队版开场白，并提示补充成员角色', async () => {
    const host = mountProbe();
    click(host.querySelectorAll('button')[1]);
    await flush();

    expect(useSessionsStore.getState().sessions[0].title).toBe('创建专家团');
    expect(promptText(host)).toContain('团队成员包括');
  });

  it('技能被停用时不新建会话，只提示去启用', async () => {
    useSkillsStore.setState({
      skills: SKILLS.map((s) =>
        s.id === EXPERT_BUILDER_SKILL_ID ? { ...s, enabled: false } : { ...s },
      ),
    });
    const host = mountProbe();
    click(host.querySelectorAll('button')[0]);
    await flush();

    expect(useSessionsStore.getState().sessions).toHaveLength(0);
    // 提示走的是全局 Toast（portal 到 body），这里只改不变量：**没有**开会话
    expect(host.querySelector('[data-testid="prompt"]')?.textContent).toBe('');
  });

  it('会话上的技能是「专家创建」，不是把整段规约塞进提示词', async () => {
    const host = mountProbe();
    click(host.querySelectorAll('button')[0]);
    await flush();
    const session = useSessionsStore.getState().sessions[0];
    // 开场白保持可读的一句话，规约由技能提供（技能可被用户编辑，前端常量不能）
    expect(readDeepLinkPrompt({ [DEEP_LINK_PROMPT_KEY]: promptText(host) })?.length).toBeLessThan(
      120,
    );
    expect(session.skillIds).toContain(EXPERT_BUILDER_SKILL_ID);
  });
});

describe('内置技能 expert-builder', () => {
  it('存在且默认启用，并声明了蓝图围栏语言', () => {
    const skill = SKILLS.find((s) => s.id === EXPERT_BUILDER_SKILL_ID);
    expect(skill).toBeTruthy();
    expect(skill?.enabled).toBe(true);
    expect(skill?.prompt).toContain('```nanowork-expert');
    expect(skill?.prompt).toContain('```nanowork-expert-team');
  });
});

// `act` 被 helpers 内部使用；此处显式引用一次以表明用例确实在 act 边界内驱动状态
void act;
