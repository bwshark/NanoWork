import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { resolveArtifactContent, useArtifactsStore } from '@/stores/artifactsStore';
import { mapRecordsToMessages } from '@/lib/sessionImport';
import { fileArtifactId } from '@/lib/fileArtifact';
import type { Message, Session } from '@/types';

/**
 * 导入会话（助理频道 / 定时任务执行）的产物补齐。
 *
 * 这两类会话的推理发生在引擎侧，本地只有磁盘 JSONL 的重放、**没有**流式 Runtime
 * 回调（`onProcessTool`）——产物登记缺了这一环，于是消息里写着「已创建 📄 文件:
 * abc.txt」，消息流却没有产物卡片，右侧「产物」面板恒为「暂无内容」。
 *
 * 补齐点收在 `openExternal`（所有导入会话的唯一入口），判据与任务会话的
 * `handleProcessTool` 同一套，故这里钉的是「两类会话表现一致」。
 */

const SESSION_ID = 'nb:feishu:oc_abc';
const ENGINE_KEY = 'feishu:oc_abc';
const PATH = 'D:/work/abc.txt';

/** 一条 `write_file` 调用在 nanobot JSONL 里的三行结构（含 tool 结果行） */
function writeRecord(callId: string, path: string, content: string): Record<string, unknown>[] {
  return [
    {
      role: 'assistant',
      content: '',
      timestamp: '2026-10-18T10:00:01',
      tool_calls: [
        {
          id: callId,
          function: { name: 'write_file', arguments: JSON.stringify({ path, content }) },
        },
      ],
    },
    { role: 'tool', tool_call_id: callId, content: 'Successfully wrote to', timestamp: '2026-10-18T10:00:02' },
  ];
}

function sessionFrom(records: Record<string, unknown>[]): Session {
  const messages: Message[] = mapRecordsToMessages(ENGINE_KEY, records);
  return {
    id: SESSION_ID,
    agentId: '',
    channel: 'feishu',
    title: '飞书会话',
    messages,
    permissionLog: [],
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:02.000Z',
  };
}

/** 打开导入会话（走 `channelSessionsStore` 同款入口） */
function open(records: Record<string, unknown>[]): Session {
  const session = sessionFrom(records);
  useSessionsStore.getState().openExternal(session);
  return session;
}

function panelArtifacts() {
  return useArtifactsStore.getState().bySession[SESSION_ID] ?? [];
}

beforeEach(() => {
  useArtifactsStore.setState({ bySession: {}, index: {}, bodies: {}, indexTombstones: {} });
  useSessionsStore.setState({
    sessions: [],
    activeId: null,
    streams: {},
    pendingApprovals: [],
    error: null,
  });
});

describe('导入会话 → 文件产物', () => {
  it('write_file 完成的行同时补齐消息卡片与右侧面板两处数据源', () => {
    const session = open([
      { role: 'user', content: '新建一个文件 abc.txt', timestamp: '2026-10-18T10:00:00' },
      ...writeRecord('call_1', PATH, 'hello world'),
      { role: 'assistant', content: `已创建 📄 文件: abc.txt 位置: ${PATH}`, timestamp: '2026-10-18T10:00:03' },
    ]);

    // 1) 消息流卡片的数据源：产物挂在触发写入的那条助手消息上
    const titled = session.messages.find((m) => (m.artifacts ?? []).length > 0);
    expect(titled, '携带 write_file 的助手消息没有挂上产物').toBeTruthy();
    const artifact = titled!.artifacts![0];
    expect(artifact.id).toBe(fileArtifactId(SESSION_ID, PATH));
    expect(artifact.type).toBe('file');
    expect(artifact.title).toBe('abc.txt');
    expect(artifact.path).toBe(PATH);
    expect(artifact.change).toBe('created');
    expect(artifact.size).toBe(11); // 'hello world' 的 UTF-8 字节数
    expect(artifact.content).toBe('hello world');

    // 2) 右侧面板的数据源：索引切片
    expect(panelArtifacts()).toHaveLength(1);
    expect(useArtifactsStore.getState().index[artifact.id]?.sessionId).toBe(SESSION_ID);
  });

  it('同路径二次写入 = 同一产物升一版，且标记为改写', () => {
    open([
      ...writeRecord('call_1', PATH, 'first'),
      ...writeRecord('call_2', PATH, 'second'),
    ]);

    const list = panelArtifacts();
    expect(list, '同路径应当收敛成一条产物').toHaveLength(1);
    expect(list[0].change).toBe('modified');
    expect(useArtifactsStore.getState().index[list[0].id]?.version).toBe(2);
  });

  it('重复打开同一份历史（轮询重放）不重复入库、不反复升版', () => {
    const records = [
      ...writeRecord('call_1', PATH, 'hello world'),
      ...writeRecord('call_2', PATH, 'hello again'),
    ];
    open(records);
    open(records); // 第二次：模拟 IM 轮询在会话更新后重建 Session

    const list = panelArtifacts();
    expect(list).toHaveLength(1);
    // 升版到 2 之后必须停在 2：否则每 4 秒轮询一次就多一版
    expect(useArtifactsStore.getState().index[list[0].id]?.version).toBe(2);
  });

  it('delete_file 之后：卡片与面板都不留（避免点开报「路径不存在」）', () => {
    open([
      ...writeRecord('call_1', 'D:/work/tmp.js', 'console.log(1)'),
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-10-18T10:00:04',
        tool_calls: [
          {
            id: 'call_2',
            function: { name: 'delete_file', arguments: JSON.stringify({ path: 'D:/work/tmp.js' }) },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_2', content: 'ok', timestamp: '2026-10-18T10:00:05' },
    ]);

    expect(panelArtifacts()).toHaveLength(0);
    const leaked = useSessionsStore
      .getState()
      .sessions[0]
      .messages.some((m) => (m.artifacts ?? []).length > 0);
    expect(leaked, '消息上仍留着已删除文件的卡片').toBe(false);
  });

  it('只读工具（read_file）不产出产物', () => {
    open([
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-10-18T10:00:01',
        tool_calls: [
          {
            id: 'call_1',
            function: { name: 'read_file', arguments: JSON.stringify({ path: PATH }) },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok', timestamp: '2026-10-18T10:00:02' },
    ]);

    expect(panelArtifacts()).toHaveLength(0);
  });
});

describe('导入会话 → 文本产物（渲染对齐任务会话）', () => {
  /** 一句带 ```mermaid 围栏的回复（IM 里常见的画流程图场景） */
  const fenced = [
    { role: 'user', content: '画个流程图', timestamp: '2026-10-18T11:00:00' },
    {
      role: 'assistant',
      content: '好的\n```mermaid\ngraph TD\n  A --> B\n```\n就这样',
      timestamp: '2026-10-18T11:00:01',
    },
  ];

  it('围栏代码块同样入产物（任务会话里它已经是一次 artifact）', () => {
    const session = open(fenced);

    const list = panelArtifacts();
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('mermaid');
    // 面板里只存引用，正文在内容池（`bySession` 去 content 的设计），按同样口径回填
    const { index, bodies } = useArtifactsStore.getState();
    const entry = index[list[0].id];
    expect(resolveArtifactContent(entry.contentHash, bodies, '')).toContain('graph TD');
    // 消息上要挂着产物，AssistantMessage 才会渲染内联卡片
    expect(session.messages[1].artifacts ?? []).toHaveLength(1);
  });

  it('反复重放同一句回复不会叠出重复条目', () => {
    open(fenced);
    open(fenced);
    open(fenced);

    expect(panelArtifacts()).toHaveLength(1);
  });
});

describe('同一轮合并为一条助手消息（对齐任务视图）', () => {
  it('assistant(工具) + tool + assistant(正文) 不再裂成两个气泡', () => {
    const session = open([
      { role: 'user', content: '创建一个文件 kkk.txt', timestamp: '2026-10-18T12:00:00' },
      ...writeRecord('call_1', PATH, 'a'.repeat(191)),
      {
        role: 'assistant',
        content: '已创建 ✅\n文件: kkk.txt 位置: D:/work/abc.txt',
        timestamp: '2026-10-18T12:00:03',
      },
    ]);

    const assistants = session.messages.filter((m) => m.role === 'assistant');
    expect(assistants, '同一轮的助手消息没有被合并').toHaveLength(1);
    // 合并后的形状与任务会话的流式聚合一致：toolCalls 驱动过程行与产物卡片，content 是正文
    expect(assistants[0].toolCalls).toHaveLength(1);
    expect(assistants[0].content).toContain('已创建');
    expect(assistants[0].artifacts ?? []).toHaveLength(1);
  });

  it('user 是轮边界：相邻两轮各自成条，不跨轮合并', () => {
    const session = open([
      ...writeRecord('call_1', PATH, 'a'),
      { role: 'assistant', content: '第一轮完成', timestamp: '2026-10-18T12:00:03' },
      { role: 'user', content: '再写一个', timestamp: '2026-10-18T12:01:00' },
      ...writeRecord('call_2', 'D:/work/def.txt', 'b'),
      { role: 'assistant', content: '第二轮完成', timestamp: '2026-10-18T12:01:03' },
    ]);

    expect(session.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(session.messages[0].content).toBe('第一轮完成');
    expect(session.messages[2].content).toBe('第二轮完成');
    expect(panelArtifacts()).toHaveLength(2);
  });
});
