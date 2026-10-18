/**
 * 子代理分组（FR-2.5 第 4 步）：`processDetail` / `processDigest` 两侧的派生层单测。
 *
 * 锁住的不变量（每条都对应一个「写错了但不报错」的后果）：
 * - **按 subagentId 合组、且按首次出现顺序落位**：并行 spawn 时事件交错
 *   （A 开始 → B 开始 → A 完成），按相邻分组会把一个子代理劈成两半、界面上出现两次。
 * - **组键带 `subagent:` 前缀**：成员 id 与 task_id 可能撞成同一个字符串，
 *   共用一张 map 会互相吸收对方的事件。
 * - **最强的终态**：出现过 `error` 就一直是失败，哪怕后面又来一条 `done`——
 *   渲染层不该比事实更乐观。
 * - **digest 按「个」计数**：一次 spawn 发 started + N 个 tool + done，
 *   按相位相加会把「派了 1 个子代理」显示成「8 步」。
 * - **result 档只留失败**：与成员组、工具行同一条原则——异常不隐身。
 */

import { describe, expect, it } from 'vitest';
import { buildProcessRows } from '@/lib/processDetail';
import { digestProcess } from '@/lib/processDigest';
import type { MemberEvent, ProcessEvent, SubagentEvent } from '@/types';

function sub(
  id: string,
  phase: SubagentEvent['phase'],
  extra: { text?: string; error?: string; name?: string } = {},
): SubagentEvent {
  return {
    id: `${id}-${phase}`,
    kind: 'subagent',
    subagentId: id,
    subagentName: extra.name ?? `子代理${id}`,
    phase,
    ...(extra.text !== undefined ? { text: extra.text } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
}

describe('buildProcessRows: 子代理分组', () => {
  it('同一子代理的多个相位合成一行，且按首次出现落位', () => {
    const rows = buildProcessRows(
      [
        sub('a', 'started', { text: '查资料' }),
        sub('a', 'tool', { text: 'web_search' }),
        sub('a', 'done'),
      ],
      'full',
    );
    const groups = rows.filter((r) => r.kind === 'subagent-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      subagentId: 'a',
      status: 'done',
      task: '查资料',
      tools: ['web_search'],
    });
  });

  it('并行 spawn 交错到达也不会把一个子代理劈成两行', () => {
    const rows = buildProcessRows(
      [
        sub('a', 'started'),
        sub('b', 'started'),
        sub('a', 'tool', { text: 'exec' }),
        sub('b', 'done'),
        sub('a', 'done'),
      ],
      'full',
    );
    const groups = rows.filter((r) => r.kind === 'subagent-group');
    expect(groups).toHaveLength(2);
    // 顺序 = spawn 顺序（A 先于 B），不是完成顺序
    expect(groups.map((g) => (g.kind === 'subagent-group' ? g.subagentId : ''))).toEqual([
      'a',
      'b',
    ]);
  });

  it('工具列表去重保序（同一工具调三次只列一次）', () => {
    const rows = buildProcessRows(
      [
        sub('a', 'tool', { text: 'exec' }),
        sub('a', 'tool', { text: 'read_file' }),
        sub('a', 'tool', { text: 'exec' }),
      ],
      'full',
    );
    const group = rows.find((r) => r.kind === 'subagent-group');
    expect(group && group.kind === 'subagent-group' ? group.tools : null).toEqual([
      'exec',
      'read_file',
    ]);
  });

  it('出现过 error 就是失败，后续的 done 洗不白它', () => {
    const rows = buildProcessRows(
      [sub('a', 'started'), sub('a', 'error', { error: 'boom' }), sub('a', 'done')],
      'full',
    );
    const group = rows.find((r) => r.kind === 'subagent-group');
    expect(group?.status).toBe('failed');
    expect(group && 'error' in group ? group.error : null).toBe('boom');
  });

  it('成员组与子代理组 id 相同时互不吸收（各自成表）', () => {
    const member: MemberEvent = {
      id: 'm1',
      kind: 'member',
      memberId: 'x',
      memberName: '成员x',
      phase: 'started',
    };
    const rows = buildProcessRows([member, sub('x', 'started'), sub('x', 'done')], 'full');
    expect(rows.filter((r) => r.kind === 'member-group')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'subagent-group')).toHaveLength(1);
  });

  it('result 档只保留失败的子代理（异常不隐身）', () => {
    const rows = buildProcessRows(
      [sub('ok', 'started'), sub('ok', 'done'), sub('bad', 'started'), sub('bad', 'error')],
      'result',
    );
    const groups = rows.filter((r) => r.kind === 'subagent-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ subagentId: 'bad', status: 'failed' });
  });
});

describe('digestProcess: 子代理按个计数', () => {
  it('一次 spawn 的多相位只算 1 步', () => {
    const events: ProcessEvent[] = [
      sub('a', 'started'),
      sub('a', 'tool', { text: 'exec' }),
      sub('a', 'tool', { text: 'read_file' }),
      sub('a', 'done'),
    ];
    expect(digestProcess(events)).toMatchObject({ steps: 1, running: 0, errors: 0 });
  });

  it('未收到 done 的子代理算「仍在跑」，署名头不会永远卡在执行中', () => {
    expect(digestProcess([sub('a', 'started'), sub('a', 'tool')])).toMatchObject({
      steps: 1,
      running: 1,
    });
  });

  it('失败子代理计入 errors（不是正常步骤）', () => {
    expect(digestProcess([sub('a', 'started'), sub('a', 'error')])).toMatchObject({
      steps: 1,
      errors: 1,
      running: 0,
    });
  });
});
