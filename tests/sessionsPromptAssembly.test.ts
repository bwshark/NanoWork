/**
 * 会话装配的端到端行为（M3 · 提示词与注入层）。
 *
 * 这个文件守的是「装配器真的接上了发送链路」——单独测 `assemblePromptSections`
 * 只能证明函数对，证明不了 `streamAssistantReply` 有没有把它用起来、取的是不是
 * 正确的作用域与优先级。历史上本仓库在 `session_mode` 上就踩过「函数对了但没接线」。
 *
 * 另一条同样重要的性质：**注入段全部来自同步快照**。`send()` 必须同步进入流式态，
 * 所以这里不 mock 任何异步 IO —— PromptLibrary / IdentityService 都靠
 * `loadAll()` 预热，发送路径只读内存。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { useSkillsStore } from '@/stores/skillsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { waitForSessionWrites } from '@/events';
import { resetEventStream } from './helpers/eventStream';
import { MemoryService } from '@/lib/memory';
import { PromptLibrary } from '@/lib/promptLibrary';
import { IdentityService } from '@/lib/identity';
import {
  IDENTITY_TAG_OPEN,
  PRODUCT_IDENTITY_TAG_OPEN,
  TONE_STYLE_TAG_OPEN,
  USER_INSTRUCTIONS_TAG_OPEN,
} from '@/lib/constants';
import type { Agent, Skill } from '@/types';
import type { ChatHandle, ChatRequest, StreamHandlers } from '@/ai/runtime/types';
import { DEFAULT_MEMORY_POLICY } from '@/types';

let captured: ChatRequest[] = [];

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-test',
    name: '测试智能体',
    systemPrompt: '你是测试助手',
    skillIds: [],
    imBinding: null,
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function resetStores(a: Agent) {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      processDetail: 'key',
      memoryEnabled: true,
      autoSummarize: false,
      memoryRecall: true,
      memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
      transcription: DEFAULT_TRANSCRIPTION,
      desktop: DEFAULT_DESKTOP,
    },
    status: 'offline',
  });
  useSessionsStore.setState({
    sessions: [],
    activeId: null,
    streams: {},
    pendingApprovals: [],
    error: null,
  });
  useArtifactsStore.setState({ bySession: {} });
  useSkillsStore.setState({ skills: [], loaded: true });
  useAgentsStore.setState({ agents: [a], activeAgentId: a.id });
  captured = [];
  resetEventStream();
  PromptLibrary.__resetForTest();
  IdentityService.__resetForTest();
}

function mockGateway() {
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (req: ChatRequest, handlers: StreamHandlers): ChatHandle => {
      captured.push(req);
      handlers.onToken('好。');
      handlers.onStatus('done');
      handlers.onDone();
      return { done: Promise.resolve(), abort: () => {} };
    },
  );
}

/** 取本轮请求里所有 system 段的正文（保持顺序） */
function systemSections(): string[] {
  const messages = captured[0]?.messages ?? [];
  return messages
    .filter((m) => m.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content as string);
}

function joinedSystem(): string {
  return systemSections().join('\n\n');
}

/**
 * `createSession` 的记忆回填是 **fire-and-forget**（异步 IO 不阻塞建会话），
 * 所以发送前必须等它落定——否则拿到的是「尚未加载」的 `undefined`，
 * 断言记忆是否注入会得到假阴性。`memoryEnabled=false` 时它压根不回填，
 * 此时直接返回。
 */
async function waitForMemoryLoaded(sessionId: string) {
  if (!useSettingsStore.getState().settings.memoryEnabled) return;
  for (let i = 0; i < 50; i++) {
    const current = useSessionsStore.getState().sessions.find((s) => s.id === sessionId);
    if (current?.memory !== undefined) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function sendOnce(prompt = '你好') {
  const session = useSessionsStore.getState().createSession('agent-test', '装配会话');
  await waitForMemoryLoaded(session.id);
  await useSessionsStore.getState().send(prompt, session.id);
  await waitForSessionWrites(session.id);
  await new Promise((r) => setTimeout(r, 0));
  return session;
}

beforeEach(() => {
  window.localStorage.clear();
  resetStores(agent());
  mockGateway();
});

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------

describe('会话装配：基线（未做任何配置）', () => {
  it('人设独占首段', async () => {
    await sendOnce();
    expect(systemSections()[0]).toBe('你是测试助手');
  });

  it('产品身份段始终存在', async () => {
    await sendOnce();
    const text = joinedSystem();
    expect(text).toContain(PRODUCT_IDENTITY_TAG_OPEN);
    expect(text).toContain('红涨绿跌');
  });

  it('没有任何身份文件时不产生 identity_context 段', async () => {
    await sendOnce();
    expect(joinedSystem()).not.toContain(IDENTITY_TAG_OPEN);
  });

  it('时间提示收尾且含时区与 ISO', async () => {
    await sendOnce();
    const last = systemSections().at(-1) ?? '';
    expect(last).toContain('当前本地时间');
    expect(last).toMatch(/时区/);
    expect(last).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('会话装配：身份文件（FR-4.3）', () => {
  it('身份文件注入 <identity_context>，且在记忆块之前', async () => {
    await IdentityService.save('soul', '我的行事原则');
    await IdentityService.save('identity', '我是 ReviewBot');
    await IdentityService.save('user', '用户偏好中文');
    await IdentityService.loadAll();
    await MemoryService.save('旧记忆内容');

    await sendOnce();

    const text = joinedSystem();
    expect(text).toContain(IDENTITY_TAG_OPEN);
    expect(text).toContain('我的行事原则');
    expect(text).toContain('ReviewBot');
    expect(text).toContain('用户偏好中文');
    expect(text.indexOf(IDENTITY_TAG_OPEN)).toBeLessThan(text.indexOf('旧记忆内容'));
  });

  it('只有一段身份文件时也注入', async () => {
    await IdentityService.save('user', '仅用户画像');
    await IdentityService.loadAll();
    await sendOnce();
    expect(joinedSystem()).toContain('仅用户画像');
  });

  it('引导态：BOOTSTRAP 正文与引导指令一起进块', async () => {
    await IdentityService.save('bootstrap', '先了解我是谁');
    await IdentityService.loadAll();
    await sendOnce();

    const text = joinedSystem();
    expect(text).toContain('先了解我是谁');
    expect(text).toContain('一次性引导');
  });

  it('未加载身份文件时不进入引导态（不能因为没读盘就把会话推进引导）', async () => {
    await window.localStorage.setItem(
      'nanowork.identity.bootstrap',
      JSON.stringify('磁盘上的引导文件'),
    );
    await sendOnce();
    expect(joinedSystem()).not.toContain('磁盘上的引导文件');
  });
});

describe('会话装配：提示词模板（§13.1 / §13.4）', () => {
  it('风格槽位套 <tone_and_style>', async () => {
    await PromptLibrary.loadAll();
    await sendOnce();
    const text = joinedSystem();
    expect(text).toContain(TONE_STYLE_TAG_OPEN);
    expect(text).toContain('语气风格');
  });

  it('磁盘覆盖的风格生效（改提示词不重编译）', async () => {
    await PromptLibrary.save('style', 'style-professional', '用我的风格说话');
    await PromptLibrary.loadAll();
    await sendOnce();
    expect(joinedSystem()).toContain('用我的风格说话');
  });

  it('领域模板随全局设置切换', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, promptDomain: 'code' },
    }));
    await PromptLibrary.loadAll();
    await sendOnce();
    const text = joinedSystem();
    expect(text).toContain('软件工程');
    expect(text).not.toContain('产品设计');
  });

  it('Agent 级领域覆盖优先于全局设置', async () => {
    resetStores(agent({ promptDomain: 'design' }));
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, promptDomain: 'code' },
    }));
    await PromptLibrary.loadAll();
    await sendOnce();
    const text = joinedSystem();
    expect(text).toContain('产品设计');
    expect(text).not.toContain('软件工程');
  });

  it('Agent 未覆盖时跟随全局（字段省略 ≠ 落成确定值）', async () => {
    resetStores(agent());
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, promptDomain: 'design' },
    }));
    await PromptLibrary.loadAll();
    await sendOnce();
    expect(joinedSystem()).toContain('产品设计');
  });

  it('执行模式模板取自会话的 mode', async () => {
    await PromptLibrary.loadAll();
    const session = useSessionsStore.getState().createSession('agent-test', '规划会话');
    await waitForMemoryLoaded(session.id);
    useSessionsStore.getState().setSessionMode(session.id, 'plan');
    await useSessionsStore.getState().send('先规划', session.id);
    await waitForSessionWrites(session.id);
    await new Promise((r) => setTimeout(r, 0));

    expect(joinedSystem()).toContain('规划');
  });

  it('未知的风格值时跳过该段，不猜近似模板', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, promptStyle: 'style-already-removed' },
    }));
    await PromptLibrary.loadAll();
    await sendOnce();
    const text = joinedSystem();
    expect(text).not.toContain(TONE_STYLE_TAG_OPEN);
    // 其余装配不受影响
    expect(text).toContain(PRODUCT_IDENTITY_TAG_OPEN);
  });
});

describe('会话装配：用户自定义指令与记忆', () => {
  it('用户自定义指令套 <user_custom_instructions>', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, userCustomPrompt: '总是用中文，别写总结' },
    }));
    await sendOnce();
    const text = joinedSystem();
    expect(text).toContain(USER_INSTRUCTIONS_TAG_OPEN);
    expect(text).toContain('别写总结');
  });

  it('未设置时没有该段', async () => {
    await sendOnce();
    expect(joinedSystem()).not.toContain(USER_INSTRUCTIONS_TAG_OPEN);
  });

  it('关闭记忆开关时不注入记忆块', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, memoryEnabled: false },
    }));
    await MemoryService.save('不该出现的记忆');
    await sendOnce();
    expect(joinedSystem()).not.toContain('不该出现的记忆');
  });

  it('开启记忆开关时注入会话快照', async () => {
    await MemoryService.save('应该出现的记忆');
    await sendOnce();
    expect(joinedSystem()).toContain('应该出现的记忆');
  });

  /**
   * P0 修复的端到端形态：**两层都要进请求**。
   *
   * 只测 `loadForInjection` 能合并没有用——历史教训是「函数对了但没接线」。
   * 这里断言真正发出去的 system 段里两段都在、且用户级在前。
   */
  it('用户级与工作区级记忆一并注入，用户级在前（P0 修复）', async () => {
    await MemoryService.save('用户叫明明，跨项目成立', 'user');
    // 会话没有绑定工作目录（`createSession` 未传 opts）→ 工作区级记忆落产品目录
    // 下的兜底位置。这里的 `null` 不能写成字符串 `'default'`：那会被当成一个名为
    // 「default」的**工作目录**，于是写进去的内容与装配时读取的位置不是同一处。
    await MemoryService.save('本项目决定先修 P0', 'workspace', null);

    await sendOnce();

    const text = joinedSystem();
    expect(text).toContain('用户叫明明，跨项目成立');
    expect(text).toContain('本项目决定先修 P0');
    expect(text.indexOf('用户叫明明，跨项目成立')).toBeLessThan(
      text.indexOf('本项目决定先修 P0'),
    );
  });

  it('只有用户级记忆时也能注入（修复前只读工作区级 → 空块）', async () => {
    await MemoryService.save('用户叫明明，跨项目成立', 'user');

    await sendOnce();

    const text = joinedSystem();
    expect(text).toContain('用户叫明明，跨项目成立');
    expect(text).toContain('【用户级记忆');
  });
});

describe('会话装配：技能段', () => {
  it('挂载的技能各成一段，且排在记忆之后', async () => {
    const skills: Skill[] = [
      {
        id: 'sk-1',
        name: '技能一',
        description: '',
        category: 'general',
        icon: '🔧',
        prompt: '技能一的正文',
        source: 'builtin',
        enabled: true,
      },
      {
        id: 'sk-2',
        name: '技能二',
        description: '',
        category: 'general',
        icon: '🔧',
        prompt: '技能二的正文',
        source: 'builtin',
        enabled: true,
      },
    ];
    resetStores(agent({ skillIds: ['sk-1', 'sk-2'] }));
    useSkillsStore.setState({ skills, loaded: true });
    await MemoryService.save('记忆正文');

    await sendOnce();

    const text = joinedSystem();
    expect(text).toContain('技能一的正文');
    expect(text).toContain('技能二的正文');
    expect(text.indexOf('记忆正文')).toBeLessThan(text.indexOf('技能一的正文'));
  });

  it('未启用的技能不注入', async () => {
    const skills: Skill[] = [
      {
        id: 'sk-off',
        name: '停用技能',
        description: '',
        category: 'general',
        icon: '🔧',
        prompt: '不该出现的技能正文',
        source: 'builtin',
        enabled: false,
      },
    ];
    resetStores(agent({ skillIds: ['sk-off'] }));
    useSkillsStore.setState({ skills, loaded: true });
    await sendOnce();
    expect(joinedSystem()).not.toContain('不该出现的技能正文');
  });
});

describe('会话装配：记忆快照失效（2026-09-17 修复）', () => {
  /**
   * 事故复现：模型在同一个会话里写下 `<memory-save scope="user">`（用户刚说了
   * 「我擅长前端 GIS 开发」），13 秒后用户再问「我擅长什么」——注入的仍是会话
   * 创建时那份快照，新记忆完全看不到。事件流里存着完整请求体，两次请求的
   * MEMORY 块逐字节相同，都只有写入前的那一条。
   *
   * 根因不在模型，而在快照**永不失效**：`Session.memory` 只在 createSession /
   * loadSession 生成一次，而 send 明确不补读。所以这里守的是「写完立刻可见」。
   */
  it('模型本轮写下的记忆，下一轮发送立即生效（无需重开会话）', async () => {
    // `<memory-save>` 落盘的前提是 memoryEnabled && autoSummarize 同时打开
    useSettingsStore.getState().setSettings({ autoSummarize: true });
    vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
      (req: ChatRequest, handlers: StreamHandlers): ChatHandle => {
        captured.push(req);
        const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
        const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
        handlers.onToken(
          /GIS/.test(text)
            ? '收到。\n<memory-save scope="user">用户擅长前端 GIS 开发。</memory-save>'
            : '好。',
        );
        handlers.onStatus('done');
        handlers.onDone();
        return { done: Promise.resolve(), abort: () => {} };
      },
    );

    const session = useSessionsStore.getState().createSession('agent-test', '记忆快照会话');
    await waitForMemoryLoaded(session.id);
    await useSessionsStore.getState().send('我擅长前端 GIS 开发', session.id);
    await waitForSessionWrites(session.id);

    // 落盘是 fire-and-forget（记不住一条不该阻塞本轮回答），所以等它真的落定
    await vi.waitFor(async () => {
      expect(await MemoryService.load('user')).toContain('前端 GIS 开发');
    });

    // 第二轮：同一个会话，不重开、不重建
    captured = [];
    await useSessionsStore.getState().send('我擅长什么开发', session.id);
    await waitForSessionWrites(session.id);

    expect(joinedSystem()).toContain('用户擅长前端 GIS 开发');
  });

  it('记忆未变化时不重读（快路径仍是纯同步快照）', async () => {
    await MemoryService.save('已有记忆');
    const session = useSessionsStore.getState().createSession('agent-test', '无写入会话');
    await waitForMemoryLoaded(session.id);
    // 预热后没有任何写入 → 快照即最新
    expect(useSessionsStore.getState().isMemorySnapshotStale(session.id)).toBe(false);
  });
});
