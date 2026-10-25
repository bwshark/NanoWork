import { beforeEach, describe, expect, it } from 'vitest';
import {
  NON_KEY_TOOLS,
  buildProcessRows,
  classifyToolCalls,
  formatAggregateSummary,
  isKeyTool,
  isToolCallRepresentedInProcess,
} from '@/lib/ui/processDetail';
import type { AggregateRow, MemberGroupRow } from '@/lib/ui/processDetail';
import { useSettingsStore } from '@/stores/settingsStore';
import type {
  MemberEvent,
  ProcessEvent,
  ProcessToolRow,
  ToolCall,
  ToolCallStatus,
} from '@/types';

/**
 * 「过程时间线的档位派生层」单测（`src/lib/ui/processDetail.ts`）。
 *
 * 锁住的不变量，以及为什么它们值得有一条会红的用例：
 * - **分类方向是「只读白名单」而非「关键名单」**：未知 / 新增工具必须落到「关键」
 *   （fail-open）。写成「关键名单」会在模型引入一个新工具时把它静默吞掉——那是
 *   最难被用户察觉的一类 bug，所以每个未知工具名都要能被证伪。
 * - **聚合只发生在「连续段」内**：屏障（思考段 / 关键工具 / running / error）必须
 *   切断聚合段。若把两侧的非关键行错误地并成一段，用户读到的「模型动作轨迹」会失真。
 * - **error / running 是档位豁免项**：任何档位都逐行保留——异常永不隐身。
 * - **桶顺序与量词是唯一契约**：`已读取 · 已浏览 · 已查找 · 已搜索` 的顺序与文案只由
 *   `formatAggregateSummary` 决定，组件不得再复制一份（复制就会两处漂移）。
 * - **纯函数不改入参**：`buildProcessRows` 产出的是一次性视图模型，绝不能就地改
 *   `Message.process` 的元素——那会让「渲染」变成「写数据」。
 */

function toolRow(
  id: string,
  tool = 'read_file',
  status: ProcessToolRow['status'] = 'done',
  args: Record<string, unknown> = {},
): ProcessToolRow {
  return { id, kind: 'tool', tool, args, status };
}

function reasoning(id: string, content = '...', closed = true): ProcessEvent {
  return { id, kind: 'reasoning', content, closed };
}

function toolCall(id: string, status: ToolCallStatus, sensitive = false): ToolCall {
  return { id, tool: 'shell', args: {}, sensitive, status };
}

/** 构造成员事件（FR-2.4 第 3 步） */
function member(
  id: string,
  memberId: string,
  phase: MemberEvent['phase'],
  extra: { name?: string; text?: string; error?: string } = {},
): ProcessEvent {
  return {
    id,
    kind: 'member',
    memberId,
    memberName: extra.name ?? memberId,
    phase,
    ...(extra.text !== undefined ? { text: extra.text } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
}

beforeEach(() => {
  // 这些纯函数本身不读 store，但档位默认值来自 settings；显式复位以固定基线，
  // 避免将来把档位读取下沉进这些函数时，用例之间互相串味。
  useSettingsStore.getState().setSettings({ processDetail: 'key' });
});

describe('isKeyTool：只读白名单 + fail-open', () => {
  it('白名单四件套全部判为「非关键」', () => {
    for (const tool of NON_KEY_TOOLS) {
      expect(isKeyTool(tool), `${tool} 应判为非关键`).toBe(false);
    }
  });

  it('联网 / 写入 / 执行 / 定时 / MCP 工具全部判为「关键」', () => {
    const keyTools = [
      'web_search',
      'web_fetch',
      'x_search',
      'exec',
      'write_file',
      'edit',
      'edit_file',
      'cron',
      'mcp_github__search',
    ];
    for (const tool of keyTools) {
      expect(isKeyTool(tool), `${tool} 应判为关键`).toBe(true);
    }
  });

  it('任意未知 / 新增工具名按「关键」处理（fail-open）', () => {
    expect(isKeyTool('brand_new_tool')).toBe(true);
    expect(isKeyTool('')).toBe(true);
  });
});

describe('formatAggregateSummary：桶顺序固定 + 只列 >0 的桶', () => {
  it('输入顺序颠倒时，输出仍是「已读取 → … → 已搜索」的固定顺序', () => {
    const summary = formatAggregateSummary([toolRow('g', 'grep'), toolRow('r', 'read_file')]);
    expect(summary).toBe('已读取 1 个文件 · 已搜索 1 次');
  });

  it('每个桶单独出现时，量词与 PRD 一致', () => {
    expect(formatAggregateSummary([toolRow('r1'), toolRow('r2')])).toBe('已读取 2 个文件');
    expect(formatAggregateSummary([toolRow('d', 'list_dir')])).toBe('已浏览 1 个目录');
    expect(formatAggregateSummary([toolRow('f', 'find_files')])).toBe('已查找 1 次');
    expect(
      formatAggregateSummary([toolRow('g1', 'grep'), toolRow('g2', 'grep')]),
    ).toBe('已搜索 2 次');
  });

  it('多个桶都有计数时，按固定顺序用「 · 」连接', () => {
    const summary = formatAggregateSummary([
      toolRow('g', 'grep'),
      toolRow('f', 'find_files'),
      toolRow('d', 'list_dir'),
      toolRow('r', 'read_file'),
    ]);
    expect(summary).toBe('已读取 1 个文件 · 已浏览 1 个目录 · 已查找 1 次 · 已搜索 1 次');
  });

  it('空输入返回空串（没有可列的桶，不留占位）', () => {
    expect(formatAggregateSummary([])).toBe('');
  });
});

describe('buildProcessRows：result 档 —— 只留异常', () => {
  it('done 的工具行与思考段全部丢弃', () => {
    const rows = buildProcessRows(
      [
        reasoning('r1'),
        toolRow('a', 'read_file'),
        toolRow('b', 'write_file'),
        toolRow('c', 'exec'),
      ],
      'result',
    );
    expect(rows).toEqual([]);
  });

  it('running / error 行恒保留，且保持到达顺序', () => {
    const rows = buildProcessRows(
      [
        toolRow('a', 'read_file'), // done → 丢弃
        toolRow('m', 'exec', 'running'),
        reasoning('r1'), // result 档丢弃思考段
        toolRow('e', 'write_file', 'error'),
        toolRow('b', 'grep'), // done → 丢弃
      ],
      'result',
    );
    expect(rows.map((r) => r.id)).toEqual(['m', 'e']);
    expect(rows.some((r) => r.kind === 'aggregate')).toBe(false);
  });
});

describe('buildProcessRows：key 档 —— 连续段聚合与屏障', () => {
  it('中间的关键工具切断聚合段（PRD §4.3 示例）', () => {
    const rows = buildProcessRows(
      [
        toolRow('a', 'read_file'),
        toolRow('b', 'read_file'),
        toolRow('g', 'grep'),
        toolRow('c', 'edit'),
        toolRow('d', 'read_file'),
      ],
      'key',
    );
    expect(rows).toHaveLength(3);

    const first = rows[0] as AggregateRow;
    expect(first.kind).toBe('aggregate');
    expect(first.id).toBe('a'); // id 取段首行 id
    expect(first.summary).toBe('已读取 2 个文件 · 已搜索 1 次');
    expect(first.rows.map((r) => r.id)).toEqual(['a', 'b', 'g']); // 段内保持到达顺序

    // 关键工具逐行保留，且不并入任何聚合段
    expect(rows[1]).toMatchObject({ kind: 'tool', id: 'c', tool: 'edit' });

    const last = rows[2] as AggregateRow;
    expect(last.kind).toBe('aggregate');
    expect(last.id).toBe('d');
    expect(last.summary).toBe('已读取 1 个文件');
    expect(last.rows.map((r) => r.id)).toEqual(['d']);
  });

  it('段内行保持到达顺序，摘要按桶归并（不按输入顺序改文案）', () => {
    const rows = buildProcessRows(
      [toolRow('z1', 'grep'), toolRow('z2', 'read_file'), toolRow('z3', 'list_dir')],
      'key',
    );
    expect(rows).toHaveLength(1);
    const agg = rows[0] as AggregateRow;
    expect(agg.id).toBe('z1');
    expect(agg.rows.map((r) => r.id)).toEqual(['z1', 'z2', 'z3']);
    expect(agg.summary).toBe('已读取 1 个文件 · 已浏览 1 个目录 · 已搜索 1 次');
  });

  it('思考段切断聚合：两侧非关键行各自成段，不跨段合并', () => {
    const rows = buildProcessRows(
      [toolRow('a', 'read_file'), reasoning('r1'), toolRow('b', 'read_file')],
      'key',
    );
    expect(rows.map((r) => r.kind)).toEqual(['aggregate', 'reasoning', 'aggregate']);
    expect((rows[0] as AggregateRow).rows.map((r) => r.id)).toEqual(['a']);
    expect((rows[2] as AggregateRow).rows.map((r) => r.id)).toEqual(['b']);
  });

  it('running / error 行是屏障且自身不参与聚合（两侧非关键行不得合并）', () => {
    const rows = buildProcessRows(
      [
        toolRow('a', 'read_file'),
        // 即便是白名单工具，进入 running / error 后也变成「豁免行」：逐行 + 切断聚合
        toolRow('m', 'read_file', 'running'),
        toolRow('b', 'read_file'),
        toolRow('e', 'read_file', 'error'),
        toolRow('c', 'read_file'),
      ],
      'key',
    );
    expect(rows.map((r) => r.kind)).toEqual([
      'aggregate',
      'tool',
      'aggregate',
      'tool',
      'aggregate',
    ]);
    expect((rows[0] as AggregateRow).rows.map((r) => r.id)).toEqual(['a']);
    expect(rows[1]).toMatchObject({ kind: 'tool', id: 'm', status: 'running' });
    expect((rows[2] as AggregateRow).rows.map((r) => r.id)).toEqual(['b']);
    expect(rows[3]).toMatchObject({ kind: 'tool', id: 'e', status: 'error' });
    expect((rows[4] as AggregateRow).rows.map((r) => r.id)).toEqual(['c']);
  });
});

describe('buildProcessRows：full 档 —— 原样同序', () => {
  it('全部事件原样同序返回，且不含任何聚合行', () => {
    const events: ProcessEvent[] = [
      reasoning('r1'),
      toolRow('a', 'read_file'),
      toolRow('c', 'edit'),
      toolRow('m', 'exec', 'running'),
      reasoning('r2'),
    ];
    const rows = buildProcessRows(events, 'full');
    expect(rows).toEqual(events);
    expect(rows.some((r) => r.kind === 'aggregate')).toBe(false);
  });

  it('空输入在三档下都返回空数组', () => {
    expect(buildProcessRows([], 'result')).toEqual([]);
    expect(buildProcessRows([], 'key')).toEqual([]);
    expect(buildProcessRows([], 'full')).toEqual([]);
  });
});

/**
 * 成员分组（FR-2.4 第 3 步）。
 *
 * 这一组的核心不变量是**跨事件归组**：成员事件在 `parallel` 下是交错的
 * （A 开始 → B 开始 → A 完成 → B 完成），一旦退化成「按相邻段聚合」，
 * 同一个成员就会在界面上出现两次——验收里那条「事件不串」说的正是它。
 */
describe('buildProcessRows：专家团成员分组', () => {
  it('同一成员的多个相位合成一块（不逐相位铺开）', () => {
    const rows = buildProcessRows(
      [
        member('e1', 'm1', 'planned', { name: '架构师', text: '先看现状再动手' }),
        member('e2', 'm1', 'aggregating'),
      ],
      'key',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'member-group',
      id: 'member:m1',
      memberId: 'm1',
      memberName: '架构师',
      status: 'running',
      activity: 'aggregating',
      text: '先看现状再动手',
      textKind: 'plan',
    });
  });

  it('parallel 交错到达：按 memberId 归组，两组各归各', () => {
    const rows = buildProcessRows(
      [
        member('e1', 'a', 'started', { name: 'A' }),
        member('e2', 'b', 'started', { name: 'B' }),
        member('e3', 'a', 'finished', { name: 'A', text: 'A 的结论' }),
        member('e4', 'b', 'finished', { name: 'B', text: 'B 的结论' }),
      ],
      'key',
    );
    expect(rows.map((r) => r.id)).toEqual(['member:a', 'member:b']);
    expect(rows.map((r) => (r as MemberGroupRow).status)).toEqual(['done', 'done']);
    expect(rows.map((r) => (r as MemberGroupRow).text)).toEqual(['A 的结论', 'B 的结论']);
    // 完成后不再显示「在做什么」
    expect(rows.map((r) => (r as MemberGroupRow).activity)).toEqual(['working', 'working']);
  });

  it('失败优先：之后又完成的成员仍判失败（不洗白）', () => {
    const rows = buildProcessRows(
      [
        member('e1', 'm1', 'started'),
        member('e2', 'm1', 'failed', { error: 'provider 429' }),
        member('e3', 'm1', 'finished', { text: '补救产出' }),
      ],
      'key',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'provider 429' });
  });

  it('result 档只留失败成员（异常永不隐身）', () => {
    const rows = buildProcessRows(
      [
        member('e1', 'ok', 'finished', { name: '正常成员', text: '产出' }),
        member('e2', 'bad', 'failed', { name: '翻车成员', error: 'boom' }),
      ],
      'result',
    );
    expect(rows.map((r) => r.id)).toEqual(['member:bad']);
    expect(rows[0]).toMatchObject({ kind: 'member-group', status: 'failed', error: 'boom' });
  });

  it('成员是屏障：两侧非关键工具行不得跨它合并成一段', () => {
    const rows = buildProcessRows(
      [
        toolRow('a', 'read_file'),
        member('e1', 'm1', 'started'),
        member('e2', 'm1', 'finished', { text: 'x' }),
        toolRow('b', 'read_file'),
      ],
      'key',
    );
    expect(rows.map((r) => r.kind)).toEqual(['aggregate', 'member-group', 'aggregate']);
    expect((rows[0] as AggregateRow).rows.map((r) => r.id)).toEqual(['a']);
    expect((rows[2] as AggregateRow).rows.map((r) => r.id)).toEqual(['b']);
  });

  it('显示名取第一个非空值：后续相位缺名不得把已拿到的真名冲掉', () => {
    const rows = buildProcessRows(
      [
        member('e1', 'm1', 'planned', { name: '架构师', text: '计划' }),
        // 引擎在缺名时把 id 当名字，所以真实事件里可能混着 id——
        // 「最新覆盖」的写法会在这里把「架构师」冲成 `m1`
        member('e2', 'm1', 'aggregating'),
      ],
      'key',
    );
    expect((rows[0] as MemberGroupRow).memberName).toBe('架构师');
  });

  it('full 档同样合成一块（分组是结构，不是档位压缩的产物）', () => {
    const rows = buildProcessRows(
      [
        member('e1', 'm1', 'started'),
        member('e2', 'm1', 'finished', { text: 'z' }),
      ],
      'full',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'member-group', textKind: 'output', text: 'z' });
  });

  it('入参冻结时调用不抛错（成员分组同样不得就地改写）', () => {
    const events: ProcessEvent[] = [
      member('e1', 'm1', 'started'),
      member('e2', 'm1', 'finished', { text: 'z' }),
    ];
    for (const ev of events) Object.freeze(ev);
    Object.freeze(events);

    expect(() => buildProcessRows(events, 'key')).not.toThrow();
    expect(() => buildProcessRows(events, 'result')).not.toThrow();
  });
});

describe('classifyToolCalls：pinned / inline 分类', () => {
  it('sensitive 为真 → pinned（与状态无关）', () => {
    const { pinned, inline } = classifyToolCalls([toolCall('t', 'done', true)], 'full');
    expect(pinned.map((t) => t.id)).toEqual(['t']);
    expect(inline).toEqual([]);
  });

  it('status 为 pending / rejected → pinned', () => {
    const { pinned } = classifyToolCalls(
      [toolCall('p', 'pending'), toolCall('r', 'rejected')],
      'key',
    );
    expect(pinned.map((t) => t.id)).toEqual(['p', 'r']);
  });

  it('error 即使非敏感也归 pinned（异常永不隐身的延伸）', () => {
    const { pinned, inline } = classifyToolCalls([toolCall('e', 'error', false)], 'key');
    expect(pinned.map((t) => t.id)).toEqual(['e']);
    expect(inline).toEqual([]);
  });

  it('done / approved / running 且非敏感 → inline', () => {
    const { pinned, inline } = classifyToolCalls(
      [toolCall('d', 'done'), toolCall('a', 'approved'), toolCall('x', 'running')],
      'key',
    );
    expect(pinned).toEqual([]);
    expect(inline.map((t) => t.id)).toEqual(['d', 'a', 'x']);
  });

  it('result 档：inline 收敛为空，pinned 不受档位影响', () => {
    const calls = [
      toolCall('d', 'done'), // 非敏感 done → result 档被过滤
      toolCall('p', 'pending'),
      toolCall('s', 'done', true),
      toolCall('e', 'error'),
    ];
    const { pinned, inline } = classifyToolCalls(calls, 'result');
    expect(inline).toEqual([]);
    expect(pinned.map((t) => t.id)).toEqual(['p', 's', 'e']);
  });
});

describe('buildProcessRows 是纯函数：不改动入参', () => {
  it('调用前后入参 events 及其元素对象均未被就地改动', () => {
    const events: ProcessEvent[] = [
      reasoning('r1', '想一下'),
      toolRow('a', 'read_file', 'done', { path: 'a.ts' }),
      toolRow('c', 'edit', 'done', { path: 'c.ts' }),
      toolRow('m', 'exec', 'running'),
    ];
    const snapshot = JSON.parse(JSON.stringify(events)) as ProcessEvent[];

    buildProcessRows(events, 'key');

    expect(events).toEqual(snapshot);
  });

  it('入参被冻结时调用不抛错（就地改写会在此暴露）', () => {
    const events: ProcessEvent[] = [reasoning('r1'), toolRow('a', 'read_file')];
    // 运行时冻结：任何就地改写都会在严格模式下抛错
    Object.freeze(events[0]);
    Object.freeze(events[1]);
    Object.freeze(events);

    expect(() => buildProcessRows(events, 'key')).not.toThrow();
    expect(() => buildProcessRows(events, 'full')).not.toThrow();
    // result 档会丢弃全部行，同样不得触碰入参
    expect(() => buildProcessRows(events, 'result')).not.toThrow();
  });
});

/**
 * `isToolCallRepresentedInProcess`：同一次动作在时间线里是否已有记录。
 *
 * 它守的是一条**用户直接看得见**的线：审批门控的工具调用与过程行是同一件事的
 * 两份记录，判定失败就会让一次 write_file 同时以「已写入 D:/…」和一张卡片出现
 * ——2026-10-01 用户截图里那堵卡片墙正是这么来的。
 *
 * 两条判定路径都要能证伪：
 * 1. **id 相同**（引擎给了 call_id，两侧对齐后的正常路径）；
 * 2. **工具名 + 参数相同**（老数据里 call_id 缺失时的兜底）。
 */
describe('isToolCallRepresentedInProcess：同一次动作不与时间线重复', () => {
  const args = { path: 'D:\\aaa\\bubble_sort.py' };

  function call(
    id: string,
    tool = 'write_file',
    callArgs: Record<string, unknown> = args,
  ): ToolCall {
    return { id, tool, args: callArgs, sensitive: true, status: 'approved' };
  }

  it('id 相同即认定为已出现（正常路径：两侧都按引擎的 call_id 对齐）', () => {
    const rows = [toolRow('call-1', 'write_file', 'done', args)];
    expect(isToolCallRepresentedInProcess(call('call-1'), rows)).toBe(true);
  });

  it('id 不同但工具名 + 参数相同也认定（老数据缺 call_id 时的兜底）', () => {
    const rows = [toolRow('call-1', 'write_file', 'done', args)];
    expect(isToolCallRepresentedInProcess(call('appr-1'), rows)).toBe(true);
  });

  it('同名工具但参数不同 → 不算已出现（宁可多渲染一张卡片，也不藏起一次动作）', () => {
    const rows = [toolRow('call-1', 'write_file', 'done', args)];
    expect(isToolCallRepresentedInProcess(call('appr-2', 'write_file', { path: 'other.ts' }), rows)).toBe(
      false,
    );
  });

  it('时间线里只有思考段时不算已出现', () => {
    expect(isToolCallRepresentedInProcess(call('call-1'), [reasoning('r1')])).toBe(false);
  });

  it('时间线为空时不算已出现', () => {
    expect(isToolCallRepresentedInProcess(call('call-1'), [])).toBe(false);
  });
});
