import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { DEFAULT_MEMORY_POLICY } from '@/types';
import { resetEventStream } from '../helpers/eventStream';

beforeEach(() => {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      processDetail: 'key',
      memoryEnabled: false,
      autoSummarize: false,
      memoryRecall: false,
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
  useAgentsStore.setState({
    agents: [
      {
        id: 'agent-test',
        name: '测试专家',
        systemPrompt: '你是测试助手',
        skillIds: [],
        imBinding: null,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ],
    activeAgentId: 'agent-test',
  });
});

describe('voice discussion session record', () => {
  it('纪要同时进入当前消息视图与事件流，重启重放有据可依', async () => {
    const eventStore = resetEventStream();
    const session = useSessionsStore.getState().createSession('agent-test', '语音讨论测试');
    await useSessionsStore.getState().appendVoiceDiscussionRecord(session.id, {
      durationMs: 12_000,
      summary: '确认了入口位置与纪要落点。',
      turns: [
        { role: 'user', text: '结束后放到哪里？' },
        { role: 'assistant', text: '作为纪要写入当前会话。' },
      ],
    });

    const current = useSessionsStore.getState().sessions.find((s) => s.id === session.id);
    expect(current?.messages).toHaveLength(1);
    expect(current?.messages[0]).toMatchObject({ role: 'assistant', durationMs: 12_000 });
    expect(current?.messages[0].content).toContain('语音讨论纪要');
    expect(current?.messages[0].content).toContain('确认了入口位置与纪要落点。');

    // recordFor 的落盘是写队列；按条件等，不用固定 sleep 赌机器速度。
    let events = await eventStore.readEvents(session.id, session.workdir);
    for (let i = 0; i < 30 && !events.some((e) => e.type === 'session-end'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      events = await eventStore.readEvents(session.id, session.workdir);
    }
    const message = events.find((e) => e.type === 'message');
    expect(message).toMatchObject({
      type: 'message',
      role: 'assistant',
      messageId: current?.messages[0].id,
      durationMs: 12_000,
    });
    expect(events.some((e) => e.type === 'session-end' && e.reason === 'done')).toBe(true);
  });
});
