import type {
  ProcessDetailLevel,
  ProcessEvent,
  ProcessToolRow,
  ReasoningEvent,
  ToolCall,
} from '@/types';

/**
 * 过程时间线的「档位派生层」：把持久化的事件序列按展示档位过滤 / 聚合成一次性的
 * **渲染视图模型**。
 *
 * ## 为什么单独成纯函数模块
 *
 * 过滤 + 连续段聚合如果散落进 JSX，就既难单测又容易在组件之间漂移。这里收口成
 * 无 React 依赖的纯函数（对齐既有 `src/lib/processDigest.ts` 的派生模型先例），
 * 组件只消费结果。
 *
 * ## 持久化模型 vs 渲染视图模型（边界硬约定）
 *
 * - **持久化数据模型**：`ReasoningEvent` / `ProcessToolRow` / `ProcessEvent`
 *   （`src/types/process.ts`）——这就是 `Message.process` 的元素类型。
 * - **渲染视图模型**：`ProcessViewRow` / `AggregateRow`——本模块就地派生，
 *   只活在一次渲染里，**绝不写回 `Message.process`**。
 *
 * 派生行（`AggregateRow` / `MemberGroupRow`）刻意**不**放进 `types/process.ts`：
 * 让它们紧挨 `ProcessEvent` 会诱使他人误扩那条持久化契约的联合类型。
 */

/**
 * 非关键工具白名单：纯只读、无副作用的本机信息收集。
 *
 * ⚠️ 判定方向是「只读白名单」而非「关键名单」——不在表里的（含任何未知 / 新增工具名）
 * 一律按**关键**处理（fail-open）：宁可多展示一个动作，也不静默吞掉一个可能重要的动作。
 */
export const NON_KEY_TOOLS: readonly string[] = ['read_file', 'list_dir', 'find_files', 'grep'];

/** 单个工具行是否「关键」。fail-open：未知工具 → true。 */
export function isKeyTool(tool: string): boolean {
  return !NON_KEY_TOOLS.includes(tool);
}

/**
 * 聚合行：把一段**相邻**的非关键工具行压成一行摘要。
 * 这是渲染视图模型，**绝不写回 `Message.process`**。
 */
export interface AggregateRow {
  kind: 'aggregate';
  /** 稳定 React key：段首原始行 id（段内行增删不影响段身份） */
  id: string;
  /** 段内原始工具行（保持到达顺序；展开时逐行渲染） */
  rows: ProcessToolRow[];
  /** 摘要文案，如「已读取 2 个文件 · 已搜索 1 次」 */
  summary: string;
}

/**
 * 成员组行：把**同一个成员**的全部相位（计划 / 开始 / 完成 / 失败 / 汇总）
 * 合成一块。这是渲染视图模型，**绝不写回 `Message.process`**。
 */
export interface MemberGroupRow {
  kind: 'member-group';
  /** 稳定 React key：成员 id（同一成员多相位共用一个身份） */
  id: string;
  memberId: string;
  memberName: string;
  status: MemberGroupStatus;
  /** 最后一次观察到的动作（仅 `running` 时用于文案） */
  activity: MemberGroupActivity;
  /** 承载文本（计划或产出）；`textKind` 说明它是哪一种 */
  text?: string;
  textKind: 'plan' | 'output';
  /** 失败原因（任一相位失败即带上；失败不可折叠，见组件） */
  error?: string;
}

/** 成员组状态：仍在跑 / 已收口 / 失败 */
export type MemberGroupStatus = 'running' | 'done' | 'failed';

/**
 * 子代理组行（FR-2.5 第 4 步）：把**同一个子代理**的全部相位合成一块。
 *
 * 与 `MemberGroupRow` 的差别只有两点，且都是事实决定的、不是设计选择：
 * 1. 子代理**有**内部工具调用（成员跑在子代理里、没有回传通道），所以多一个
 *    `tools` 列表——这让「它在干什么」不必只靠一句摘要猜；
 * 2. 子代理的 `text` 是**任务摘要**（started 时给的），不是产出——产出走工具结果回注。
 */
export interface SubagentGroupRow {
  kind: 'subagent-group';
  /** 稳定 React key：`subagent:` 前缀避免与成员组撞 id */
  id: string;
  subagentId: string;
  subagentName: string;
  status: MemberGroupStatus;
  /** 任务摘要（started 载荷；没有就空——不拿工具名冒充任务） */
  task?: string;
  /** 内部依次调用过的工具（去重保序） */
  tools: string[];
  /** 迭代轮次（done 时引擎回报；仅展示用） */
  iterations?: number;
  /** 失败原因（任一相位失败即带上） */
  error?: string;
}
/** 成员当前动作（决定 `running` 文案：制定计划中 / 执行中 / 汇总中） */
export type MemberGroupActivity = 'planning' | 'working' | 'aggregating';

/**
 * 渲染视图行。
 *
 * ⚠️ 刻意**逐个列出**而不是写成 `ProcessEvent | …`：裸的 `MemberEvent` 永远不会
 * 单独成行——它必被合进 `MemberGroupRow`（见 `groupMemberEvents`）。把它留在联合里
 * 会让每个消费方都多出「这个 case 怎么画」的问号，而正确答案是「画不到」。
 */
export type ProcessViewRow =
  | ReasoningEvent
  | ProcessToolRow
  | AggregateRow
  | MemberGroupRow
  | SubagentGroupRow;

/**
 * 档位过滤 + 连续段聚合的**唯一入口**。
 * 纯函数：不读 store、不碰 React、不改入参，可直接单测。
 *
 * 规则（PRD §3.2 / §4.2）：
 * - reasoning：result 丢弃；key / full 保留（正文展开仍由 ReasoningBlock 自理）。
 * - tool(running | error)：档位豁免——任何档位都逐行保留，且**不参与聚合**。
 * - tool(done)：
 *     - full → 逐行保留。
 *     - result → 丢弃。
 *     - key → 关键工具逐行保留；非关键工具并入当前连续段，遇屏障 flush 成 `AggregateRow`。
 * - member（FR-2.4 第 3 步）：同一成员的全部相位合成一个 `MemberGroupRow`（跨事件分组，
 *   见下）；result 档只留**失败**的成员——「异常永不隐身」在成员这一层同样成立，
 *   否则一次「两个成员里有一个挂了」的编排，在最简档下会显示成完全成功。
 * - 屏障 = 思考段 / 关键工具 / running / error / 成员（任何「不并入当前聚合段」的行都要先 flush）。
 */
export function buildProcessRows(
  events: ProcessEvent[],
  tier: ProcessDetailLevel,
): ProcessViewRow[] {
  const out: ProcessViewRow[] = [];
  let segment: ProcessToolRow[] = [];

  const flush = () => {
    if (segment.length === 0) return;
    out.push({
      kind: 'aggregate',
      id: segment[0].id,
      rows: segment,
      summary: formatAggregateSummary(segment),
    });
    segment = [];
  };

  /*
   * 成员事件**先跨事件分组**，不能沿用「相邻段」的聚合思路：
   * `parallel` 模式下事件是交错的（A 开始 → B 开始 → A 完成 → B 完成），
   * 按相邻分组会把同一个成员劈成两块、在界面上出现两次——正是验收里要防的「事件串了」。
   */
  const groups = groupMemberEvents(events, tier);
  // [LOCAL PATCH] FR-2.5：子代理组与成员组**各自成表**。共用一张表时两个 id
  // （成员 id 与 task_id 都可能是 `a1`）会互相吸收对方的事件，界面串行。
  const subagentGroups = groupSubagentEvents(events, tier);
  const emitted = new Set<string>();

  for (const ev of events) {
    // 关键档下，非关键的 done 工具行并入当前连续段（等待屏障 flush）
    if (tier === 'key' && ev.kind === 'tool' && ev.status === 'done' && !isKeyTool(ev.tool)) {
      segment.push(ev);
      continue;
    }

    // 其余一切行都是「屏障」：先结算当前聚合段，再决定本行去留
    flush();

    if (ev.kind === 'member') {
      // 组在**首次出现处**落位，同一成员的后续相位被它吸收（不再单开一行）
      const group = groups.get(ev.memberId);
      if (group && !emitted.has(ev.memberId)) {
        emitted.add(ev.memberId);
        out.push(group);
      }
      continue;
    }

    if (ev.kind === 'subagent') {
      // 与成员同一套落位规则：组在首次出现处落位，后续相位被吸收。
      // 用 `subagent:` 前缀与成员组区分——两个 map 的键可能撞成同一个 id。
      const key = `subagent:${ev.subagentId}`;
      const group = subagentGroups.get(key);
      if (group && !emitted.has(key)) {
        emitted.add(key);
        out.push(group);
      }
      continue;
    }

    if (ev.kind === 'reasoning') {
      // 聚焦结果档丢弃思考段；key / full 原样保留
      if (tier !== 'result') out.push(ev);
      continue;
    }

    // 工具行：running / error 档位豁免（恒保留）；done 仅在 full、或 key 档的关键工具时保留
    const keep = ev.status !== 'done' || tier === 'full' || (tier === 'key' && isKeyTool(ev.tool));
    if (keep) out.push(ev);
  }

  flush();
  return out;
}

/**
 * 成员事件 → 按 `memberId` 分组，保持**首次出现顺序**（即引擎的调度顺序：
 * sequential 是成员表顺序，parallel 是 `gather` 的启动顺序）。
 *
 * 状态判定取「最强的终态」：只要出现过 `failed` 就是失败（哪怕之后又跑了一轮），
 * 否则出现过 `finished` 就是完成，都没有才是仍在跑。这样「中途失败过一次」
 * 不会被后续动作洗白——渲染层不该比事实更乐观。
 */
function groupMemberEvents(
  events: readonly ProcessEvent[],
  tier: ProcessDetailLevel,
): Map<string, MemberGroupRow> {
  const groups = new Map<string, MemberGroupRow>();
  for (const ev of events) {
    if (ev.kind !== 'member') continue;

    let group = groups.get(ev.memberId);
    if (!group) {
      group = {
        kind: 'member-group',
        id: `member:${ev.memberId}`,
        memberId: ev.memberId,
        memberName: ev.memberName,
        status: 'running',
        activity: 'working',
        textKind: 'output',
      };
      groups.set(ev.memberId, group);
    }

    /*
     * 名字取**第一个非空值**，之后不再改。
     *
     * 不用「最新一次覆盖」：引擎在成员缺名时会把 id 当名字（`_parse_member`），
     * 于是同一成员的事件里可能既有真名又有 id——「最新覆盖」会让一个没带名字的
     * 后续相位把已经拿到的真名冲掉，界面上成员名就会莫名其妙变成 `m1`。
     * 而「团内改名」在引擎侧不可能发生（成员表是本轮冻结的 spec），
     * 所以首个非空值就是终值。
     */
    if (!group.memberName && ev.memberName) group.memberName = ev.memberName;

    if (ev.text) {
      group.text = ev.text;
      group.textKind = ev.phase === 'planned' ? 'plan' : 'output';
    }

    if (ev.phase === 'failed') {
      group.status = 'failed';
      if (ev.error) group.error = ev.error;
      continue;
    }
    if (ev.phase === 'finished') {
      if (group.status !== 'failed') group.status = 'done';
      continue;
    }
    // planned / started / aggregating：仍未收口，记下「此刻在做什么」
    group.activity =
      ev.phase === 'planned' ? 'planning' : ev.phase === 'aggregating' ? 'aggregating' : 'working';
  }

  // 聚焦结果档只保留失败成员（与工具行的档位豁免同一条原则：异常不隐身）
  if (tier === 'result') {
    for (const [id, group] of groups) {
      if (group.status !== 'failed') groups.delete(id);
    }
  }
  return groups;
}

/**
 * 子代理事件 → 按 `subagentId` 分组，保持首次出现顺序（即 `spawn` 的发生顺序）。
 *
 * 状态判定与成员组同一条原则：取**最强的终态**——出现过 `error` 就是失败
 * （哪怕之后又来了一条 `done`），否则有过 `done` 就是完成，都没有才是仍在跑。
 * 渲染层不该比事实更乐观。
 */
function groupSubagentEvents(
  events: readonly ProcessEvent[],
  tier: ProcessDetailLevel,
): Map<string, SubagentGroupRow> {
  const groups = new Map<string, SubagentGroupRow>();
  for (const ev of events) {
    if (ev.kind !== 'subagent') continue;

    const key = `subagent:${ev.subagentId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        kind: 'subagent-group',
        id: key,
        subagentId: ev.subagentId,
        subagentName: ev.subagentName,
        status: 'running',
        tools: [],
      };
      groups.set(key, group);
    }

    // 名字取第一个非空值，之后不再改（后续相位不带名字时会退化成 id）
    if (!group.subagentName) group.subagentName = ev.subagentName;

    if (ev.phase === 'error') {
      group.status = 'failed';
      if (ev.error) group.error = ev.error;
      continue;
    }
    if (ev.phase === 'done') {
      if (group.status !== 'failed') group.status = 'done';
      continue;
    }
    if (ev.phase === 'started') {
      // 任务摘要只在 started 相位带；工具名与它语义不同，不能混进同一个字段
      if (ev.text) group.task = ev.text;
      continue;
    }
    if (ev.phase === 'tool' && ev.text && !group.tools.includes(ev.text)) {
      group.tools.push(ev.text);
    }
  }

  // 聚焦结果档只保留失败的子代理（与成员组同一条原则：异常不隐身）
  if (tier === 'result') {
    for (const [key, group] of groups) {
      if (group.status !== 'failed') groups.delete(key);
    }
  }
  return groups;
}

/**
 * 聚合摘要：按桶计数、固定顺序「已读取 → 已浏览 → 已查找 → 已搜索」，
 * 只列计数 > 0 的桶，以 ` · ` 连接。
 *
 * 摘要文案的**唯一出处**在此：`ProcessView` 只渲染返回值，不复制任何文案。
 * 只可能收到 4 种白名单工具（非白名单工具永远走「关键」分支、不聚合），无需为未知工具兜底。
 */
export function formatAggregateSummary(rows: ProcessToolRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.tool, (counts.get(row.tool) ?? 0) + 1);

  const parts: string[] = [];
  const readCount = counts.get('read_file') ?? 0;
  if (readCount > 0) parts.push(`已读取 ${readCount} 个文件`);
  const dirCount = counts.get('list_dir') ?? 0;
  if (dirCount > 0) parts.push(`已浏览 ${dirCount} 个目录`);
  const findCount = counts.get('find_files') ?? 0;
  if (findCount > 0) parts.push(`已查找 ${findCount} 次`);
  const grepCount = counts.get('grep') ?? 0;
  if (grepCount > 0) parts.push(`已搜索 ${grepCount} 次`);
  return parts.join(' · ');
}

/**
 * 这次工具调用是不是**已经出现在过程时间线里**了。
 *
 * 审批门控留下的工具调用（`Message.toolCalls`）与过程行（`Message.process`）说的是
 * **同一件事的两份记录**——引擎的 `approval_request` 与 `tool` 进度事件共用同一个
 * `call_id`（见 `src/ai/runtime/types.ts` 的 `ApprovalRequestEvent.callId`，以及事件流
 * 投影 `src/events/project.ts` 的 permission-decision 分支：它直接拿 `callId` 当
 * ToolCall 的 id）。过程行已经把它渲染成一条工作步骤，再叠一张卡片就是同一动作
 * 出现两次——2026-10-01 用户截图里那堵卡片墙正是这么来的。
 *
 * ⚠️ **回退不可省**：引擎在 `approval_request` 里不带 `call_id` 时（老数据、退化路径），
 * 两侧 id 对不上，此时退化为「同名工具 + 同参数」比较。宁可多渲染一张卡片，
 * 也不能把一次真实发生过的动作藏起来——多一张是噪声，少一张是欺骗。
 */
export function isToolCallRepresentedInProcess(
  toolCall: ToolCall,
  rows: readonly ProcessEvent[],
): boolean {
  for (const row of rows) {
    if (row.kind !== 'tool') continue;
    if (row.id === toolCall.id) return true;
    if (row.tool === toolCall.tool && sameArgs(row.args, toolCall.args)) return true;
  }
  return false;
}

/**
 * 参数浅比较。
 *
 * 刻意只做浅层 `===`：深层比较要处理嵌套对象 / 数组 / 循环引用，代价远大于收益，
 * 而这里**判错的方向是安全的**——浅比较失败只会让卡片多渲染一次（见上）。
 */
function sameArgs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/**
 * `ToolCallCard` 的档位分类（PRD §3.2 G / H）。
 * - pinned（折叠区**之外**、恒渲染）：`sensitive` 为真、或 status ∈ {pending, rejected, error}。
 * - inline（折叠区**之内**）：其余；result 档过滤为空，key / full 档全部保留。
 *
 * ⚠️ error 也归入 pinned 是「异常永不隐身」原则的延伸：失败不能被折叠吃掉。
 */
export function classifyToolCalls(
  toolCalls: ToolCall[],
  tier: ProcessDetailLevel,
): { pinned: ToolCall[]; inline: ToolCall[] } {
  const pinned: ToolCall[] = [];
  const inline: ToolCall[] = [];
  for (const tc of toolCalls) {
    if (tc.sensitive === true || tc.status === 'pending' || tc.status === 'rejected' || tc.status === 'error') {
      pinned.push(tc);
    } else if (tier !== 'result') {
      inline.push(tc);
    }
  }
  return { pinned, inline };
}
