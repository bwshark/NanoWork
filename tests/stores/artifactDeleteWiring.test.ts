import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { fileArtifactId } from '@/lib/artifact/fileArtifact';
import type { Artifact, Message, Session } from '@/types';

/**
 * `delete_file` 删除接线：引擎把文件删掉后，产物必须跟着从面板与消息卡片上消失。
 *
 * 2026-09-30 用户报的 bug：模型写完临时脚本（%TEMP%/snake-test.js）、跑完自己
 * `delete_file` 清理，产物面板却留着一张卡片 —— 内容快照还在（预览看着正常），
 * 点「在资源管理器打开」却报「路径不存在」。事件流里那两条 `delete_file`
 * 就是漏掉的信号。
 */

const SESSION_ID = 's-del';
const MESSAGE_ID = 'm-del';
/** 用真实的 %TEMP% 形态：这条路径当年确实被删了 */
const PATH = 'C:/Users/xinmi/AppData/Local/Temp/snake-test.js';

function fileArtifact(): Artifact {
  return {
    id: fileArtifactId(SESSION_ID, PATH),
    type: 'file',
    title: 'snake-test.js',
    content: '',
    path: PATH,
    size: 5596,
    change: 'created',
    createdAt: '2026-09-29T15:22:08.306Z',
  };
}

function sessionWith(artifacts: Artifact[]): Session {
  const message: Message = {
    id: MESSAGE_ID,
    role: 'assistant',
    content: '已写入测试脚本',
    artifacts,
    createdAt: '2026-09-29T15:22:08.000Z',
  };
  const now = '2026-09-29T15:22:08.000Z';
  return {
    id: SESSION_ID,
    agentId: 'agent-test',
    title: '贪吃蛇',
    messages: [message],
    permissionLog: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 种一条已登记的产物（等价于「写文件成功」之后的状态） */
function seed(): Artifact {
  const artifact = fileArtifact();
  useArtifactsStore.getState().recordArtifact(SESSION_ID, MESSAGE_ID, artifact);
  useSessionsStore.setState({
    sessions: [sessionWith([artifact])],
    activeId: SESSION_ID,
    streams: {},
    pendingApprovals: [],
    error: null,
  });
  return artifact;
}

/** 派发一个工具事件（默认成功） */
function toolEvent(tool: string, args: Record<string, unknown>, phase: 'end' | 'error' = 'end') {
  useSessionsStore.getState().handleProcessTool(SESSION_ID, MESSAGE_ID, {
    id: `ev-${tool}-${phase}`,
    tool,
    args,
    phase,
  });
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

describe('delete_file → 产物收回', () => {
  it('删除成功后：面板引用、索引、消息卡片三处一起摘，并写墓碑', () => {
    const artifact = seed();
    expect(useArtifactsStore.getState().bySession[SESSION_ID]).toHaveLength(1);

    toolEvent('delete_file', { path: PATH }, 'end');

    const state = useArtifactsStore.getState();
    expect(state.bySession[SESSION_ID] ?? []).toHaveLength(0);
    expect(state.index[artifact.id]).toBeUndefined();
    // 墓碑是删除可跨端传播的前提（与 clearSession 同款）
    expect(state.indexTombstones[artifact.id]?.deletedAt).toBeTruthy();

    const message = useSessionsStore.getState().sessions[0].messages[0];
    expect(message.artifacts ?? []).toHaveLength(0);
  });

  it('路径参数写成 file_path 同样识别（引擎两种叫法都出现过）', () => {
    seed();
    toolEvent('delete_file', { file_path: PATH }, 'end');
    expect(useArtifactsStore.getState().bySession[SESSION_ID] ?? []).toHaveLength(0);
  });

  it('工具失败（phase=error）不摘产物：失败的执行不能改状态', () => {
    seed();
    toolEvent('delete_file', { path: PATH }, 'error');
    expect(useArtifactsStore.getState().bySession[SESSION_ID]).toHaveLength(1);
  });

  it('删一个没登记过的路径：不报错、也不留空墓碑', () => {
    seed();
    toolEvent('delete_file', { path: 'D:/aa/never-written.js' }, 'end');
    const state = useArtifactsStore.getState();
    expect(state.bySession[SESSION_ID]).toHaveLength(1);
    expect(Object.keys(state.indexTombstones)).toHaveLength(0);
  });

  it('缺 path 参数时什么都不做（不误删整会话的产物）', () => {
    seed();
    toolEvent('delete_file', {}, 'end');
    expect(useArtifactsStore.getState().bySession[SESSION_ID]).toHaveLength(1);
  });

  it('写文件链路不受影响：write_file 成功仍然照常登记', () => {
    useSessionsStore.setState({ sessions: [sessionWith([])], activeId: SESSION_ID });
    toolEvent('write_file', { path: PATH, content: "'use strict';" }, 'end');
    const list = useArtifactsStore.getState().bySession[SESSION_ID] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe(PATH);
  });
});
