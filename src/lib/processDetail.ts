import type { ProcessDetailLevel, ProcessEvent, ProcessToolRow, ToolCall } from '@/types';

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
 * 聚合行（`AggregateRow`）是派生产物，所以它刻意不放进 `types/process.ts`：
 * 让它紧挨 `ProcessEvent` 会诱使他人误扩那条持久化契约的联合类型。
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

/** 渲染视图行：思考段原样保留；工具行或为单行、或被聚合行替代。 */
export type ProcessViewRow = ProcessEvent | AggregateRow;

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
 * - 屏障 = 思考段 / 关键工具 / running / error（任何「不并入当前聚合段」的行都要先 flush）。
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

  for (const ev of events) {
    // 关键档下，非关键的 done 工具行并入当前连续段（等待屏障 flush）
    if (tier === 'key' && ev.kind === 'tool' && ev.status === 'done' && !isKeyTool(ev.tool)) {
      segment.push(ev);
      continue;
    }

    // 其余一切行都是「屏障」：先结算当前聚合段，再决定本行去留
    flush();

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
