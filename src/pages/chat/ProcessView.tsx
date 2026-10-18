import { Children, useState } from 'react';
import { Box, CircularProgress, Collapse, Tooltip } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import PersonIcon from '@mui/icons-material/Person';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import { MarkdownView } from '@/components/MarkdownView';
import { REASONING_MD_SX, ReasoningBlock } from './ReasoningBlock';
import { describeTool } from './toolDescribe';
import { buildProcessRows } from '@/lib/processDetail';
import type {
  AggregateRow,
  MemberGroupRow,
  ProcessViewRow,
  SubagentGroupRow,
} from '@/lib/processDetail';
import type { ProcessDetailLevel, ProcessEvent, ProcessToolRow } from '@/types';

/**
 * 工具执行行：图标 + 动词 + 主信息（路径蓝）+ 次信息 + 状态。
 *
 * `live` 决定 `running` 行怎么落地——这是**回合是否还在进行**的事实，不是数据里的
 * 状态。引擎只发 `start` / `end` 两个相位，结果事件可能在链路中断时永远不到；
 * 此时数据里那条行会一直停在 `running`（事件流里确实没有结果事件，不是漏更新）。
 * 但「回合已经结束」这件事足以判定：**它不会再执行了**。所以：
 * - 回合仍在流式（`live`）→ 转圈，表示此刻正在跑；
 * - 回合已结束 → 不转圈，改说「结果未返回」。
 *
 * 早先只看 `status === 'running'` 就转圈，于是一轮超时被打断的会话里，那行会
 * 永远转下去（2026-10-01 用户截图：任务已停，最后一步还在转）。
 */
function ToolRow({ row, live }: { row: ProcessToolRow; live: boolean }) {
  const d = describeTool(row.tool, row.args, row.status);
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        py: 0.4,
        fontSize: 13,
        color: 'text.secondary',
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{d.icon}</Box>
      <Box component="span" sx={{ flexShrink: 0 }}>
        {d.verb}
      </Box>
      {d.primary && (
        <Tooltip title={d.primary} enterDelay={600}>
          <Box
            component="span"
            sx={{
              // 文件路径 / URL 的链接蓝：用语义 token（浅/深色均有足够对比度）
              color: d.primaryBlue ? 'info.main' : 'text.secondary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {d.primary}
          </Box>
        </Tooltip>
      )}
      {d.secondary && (
        <Box
          component="span"
          sx={{
            color: 'text.disabled',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {d.secondary}
        </Box>
      )}
      {row.status === 'running' && live && (
        <CircularProgress size={9} sx={{ color: 'text.secondary', flexShrink: 0 }} />
      )}
      {/* 回合结束仍未拿到结果：说「未返回」而不是「失败」——工具可能已经成功执行，
          只是结果事件没送到。把它说成失败同样是骗人。 */}
      {row.status === 'running' && !live && (
        <Box component="span" sx={{ color: 'warning.main', flexShrink: 0 }}>
          结果未返回
        </Box>
      )}
      {row.status === 'error' && (
        <Box component="span" sx={{ color: 'error.main', flexShrink: 0 }}>
          失败
        </Box>
      )}
    </Box>
  );
}

/**
 * 非关键工具的**聚合行**（「关键细节」档）：一段相邻的非关键工具行压成一行摘要，
 * 点开才逐行铺出原始行。
 *
 * 复用「标记行」语言（旋转 chevron + 摘要文字，不额外引入工具图标），与
 * `ReasoningBlock` 保持一致，以区别于工具单行。展开态用组件本地 `useState`
 * ——它是**块内独立、不持久化**的一次性视图态（PRD §4.2），刷新即丢。
 */
function AggregateRowView({ row, live }: { row: AggregateRow; live: boolean }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={open ? `收起 ${row.summary} 明细` : `展开 ${row.summary} 明细`}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.4,
          py: 0.4,
          fontSize: 13,
          color: 'text.secondary',
          cursor: 'pointer',
          userSelect: 'none',
          '&:hover': { color: 'text.primary' },
        }}
      >
        <ChevronRightIcon
          sx={{
            fontSize: 14,
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform .15s',
          }}
        />
        <span>{row.summary}</span>
      </Box>
      <Collapse in={open} unmountOnExit>
        {row.rows.map((r) => (
          <ToolRow key={r.id} row={r} live={live} />
        ))}
      </Collapse>
    </Box>
  );
}

/** `running` 时成员此刻在做什么（FR-2.4 第 3 步的相位文案） */
const MEMBER_ACTIVITY_LABEL: Record<MemberGroupRow['activity'], string> = {
  planning: '制定计划中',
  working: '执行中',
  aggregating: '汇总中',
};

/**
 * 成员组的状态文案 + 颜色。
 *
 * `live`（回合是否仍在进行）是**事实**，不是数据里的状态——引擎只发相位，不发终局；
 * 结果事件可能在链路中断时永远不到，此时数据里那组会一直停在 `running`（事件流里确实
 * 没有终局相位，不是漏更新）。但「回合已经结束」足以判定：它不会再动了。所以：
 * - 回合仍在流式 → 转圈 + 动作文案；
 * - 回合已结束且最后动作是**汇总** → 说「已结束」：汇总的产出就是下面那条最终回答，
 *   再写「结果未返回」会与用户正读到的正文自相矛盾；
 * - 回合已结束但成员停在中途 → 「结果未返回」（成员结果确实没回来，这不是「失败」，
 *   把它说成失败同样是骗人——与 `ToolRow` 同一条规则）。
 */
function memberStatus(group: MemberGroupRow, live: boolean): { label: string; color: string } {
  if (group.status === 'failed') return { label: '失败', color: 'error.main' };
  if (group.status === 'done') return { label: '完成', color: 'text.disabled' };
  if (live) return { label: MEMBER_ACTIVITY_LABEL[group.activity], color: 'text.secondary' };
  if (group.activity === 'aggregating') return { label: '已结束', color: 'text.disabled' };
  return { label: '结果未返回', color: 'warning.main' };
}

/**
 * 成员产出正文的最大高度：超出即内部滚动（与思考正文同一档）。
 * 成员产出动辄上千字，不设上限会把最终回答顶出屏幕。
 */
const MEMBER_BODY_MAX_HEIGHT = 200;

/**
 * 专家团成员行（FR-2.4 第 3 步）：成员名 + 此刻状态 + 按需展开的产出/计划。
 *
 * 为什么是**独立一类行**而不是「工具行加个 memberId」：成员产出没有对应的工具行
 * （既不是工具调用、也不是深度思考），硬塞进工具行会让「工具」这个词再也说不清
 * 自己指什么。详见 `@/types/process` 的 `MemberEvent`。
 *
 * 版式复用过程区的**标记行语言**（图标 + 名称 + 状态 + 悬停浮出的 chevron），
 * 与 `ReasoningBlock` / 聚合行一致，交错渲染出来才是一条连续的流。
 */
function MemberGroupView({
  group,
  live,
  tier,
}: {
  group: MemberGroupRow;
  live: boolean;
  tier: ProcessDetailLevel;
}) {
  /** 用户手动开关：null = 尚未表态，跟随档位（与 ReasoningBlock 同一模式） */
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const canExpand = Boolean(group.text);
  const open = canExpand && (manualOpen ?? tier === 'full');
  const { label, color } = memberStatus(group, live);
  const bodyLabel = group.textKind === 'plan' ? '团队计划' : '成员产出';

  const toggle = () => {
    if (canExpand) setManualOpen(!open);
  };

  return (
    <Box sx={{ minWidth: 0 }}>
      <Box
        {...(canExpand
          ? {
              role: 'button' as const,
              tabIndex: 0,
              'aria-expanded': open,
              'aria-label': open ? `收起${bodyLabel}` : `展开${bodyLabel}`,
              onClick: toggle,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle();
                }
              },
            }
          : {})}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          py: 0.4,
          fontSize: 13,
          color: 'text.secondary',
          cursor: canExpand ? 'pointer' : 'default',
          userSelect: 'none',
          '&:hover': canExpand ? { color: 'text.primary' } : undefined,
          '&:hover .member-chevron': { opacity: 1 },
        }}
      >
        <PersonIcon sx={{ fontSize: 14, flexShrink: 0, color: 'text.disabled' }} />
        <Box component="span" sx={{ color: 'text.primary', flexShrink: 0 }}>
          {group.memberName}
        </Box>
        <Box component="span" sx={{ color, flexShrink: 0 }}>
          {label}
        </Box>
        {group.status === 'running' && live && (
          <CircularProgress size={9} sx={{ color: 'text.secondary', flexShrink: 0 }} />
        )}
        {canExpand && (
          <ChevronRightIcon
            className="member-chevron"
            sx={{
              fontSize: 14,
              opacity: open ? 1 : 0,
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform .15s, opacity .15s',
            }}
          />
        )}
      </Box>
      {/* 失败原因**不折叠**：异常永不隐身，藏进一次点击里就等于把它藏起来了 */}
      {group.status === 'failed' && group.error && (
        <Box
          sx={{
            ml: 0.25,
            pl: 1.25,
            py: 0.25,
            fontSize: 12.5,
            lineHeight: 1.6,
            color: 'error.main',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {group.error}
        </Box>
      )}
      {canExpand && (
        <Collapse in={open} unmountOnExit>
          <Box
            sx={{
              mt: 0.5,
              mb: 0.25,
              ml: 0.25,
              pl: 1.25,
              pr: 1,
              py: 0.75,
              borderLeft: '2px solid',
              borderColor: 'divider',
              bgcolor: 'action.hover',
              borderRadius: '0 8px 8px 0',
              maxHeight: MEMBER_BODY_MAX_HEIGHT,
              overflowY: 'auto',
              // 滚动条出现/消失不引起正文横向跳动
              scrollbarGutter: 'stable',
              overscrollBehavior: 'contain',
              '&::-webkit-scrollbar': { width: 6 },
            }}
          >
            {/* 产出是模型写的 Markdown，与深度思考同一套排版覆盖 */}
            <MarkdownView content={group.text ?? ''} sx={REASONING_MD_SX} />
          </Box>
        </Collapse>
      )}
    </Box>
  );
}

/**
 * 子代理状态文案。
 *
 * 与 `memberStatus` 同一条判据：**流式结束后仍没收到终态就说「结果未返回」**——
 * 那时侯把它说成「完成」是骗人（后台 spawn 的结果可能走 bus 回注，也可能压根没回来）。
 */
function subagentStatus(group: SubagentGroupRow, live: boolean): { label: string; color: string } {
  if (group.status === 'failed') return { label: '失败', color: 'error.main' };
  if (group.status === 'done') return { label: '完成', color: 'text.disabled' };
  if (live) return { label: '执行中', color: 'text.secondary' };
  return { label: '结果未返回', color: 'warning.main' };
}

/**
 * 子代理行（FR-2.5 第 4 步）：名字 + 此刻状态 + 按需展开的任务摘要与工具链。
 *
 * 形态与 `MemberGroupView` 刻意一致（同一份时间线的同级行不该长得不一样），
 * 差别只在展开体：成员展开的是**产出 Markdown**，子代理展开的是**任务摘要 + 依次
 * 调用过的工具**——子代理的产出走工具结果回注成主对话内容，不是这里的一行文本。
 */
function SubagentGroupView({
  group,
  live,
}: {
  group: SubagentGroupRow;
  live: boolean;
}) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const hasBody = Boolean(group.task) || group.tools.length > 0;
  const open = hasBody && (manualOpen ?? false);
  const { label, color } = subagentStatus(group, live);

  const toggle = () => {
    if (hasBody) setManualOpen(!open);
  };

  return (
    <Box sx={{ minWidth: 0 }}>
      <Box
        {...(hasBody
          ? {
              role: 'button' as const,
              tabIndex: 0,
              'aria-expanded': open,
              'aria-label': open ? '收起子代理详情' : '展开子代理详情',
              onClick: toggle,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle();
                }
              },
            }
          : {})}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          py: 0.4,
          fontSize: 13,
          color: 'text.secondary',
          cursor: hasBody ? 'pointer' : 'default',
          userSelect: 'none',
          '&:hover': hasBody ? { color: 'text.primary' } : undefined,
          '&:hover .subagent-chevron': { opacity: 1 },
        }}
      >
        <SmartToyIcon sx={{ fontSize: 14, flexShrink: 0, color: 'text.disabled' }} />
        <Box component="span" sx={{ color: 'text.primary', flexShrink: 0 }}>
          {group.subagentName}
        </Box>
        <Box component="span" sx={{ color, flexShrink: 0 }}>
          {label}
        </Box>
        {group.status === 'running' && live && (
          <CircularProgress size={9} sx={{ color: 'text.secondary', flexShrink: 0 }} />
        )}
        {hasBody && (
          <ChevronRightIcon
            className="subagent-chevron"
            sx={{
              fontSize: 14,
              opacity: open ? 1 : 0,
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform .15s, opacity .15s',
            }}
          />
        )}
      </Box>
      {/* 失败原因**不折叠**：异常永不隐身（与成员行同一条原则） */}
      {group.status === 'failed' && group.error && (
        <Box
          sx={{
            ml: 0.25,
            pl: 1.25,
            py: 0.25,
            fontSize: 12.5,
            lineHeight: 1.6,
            color: 'error.main',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {group.error}
        </Box>
      )}
      {hasBody && (
        <Collapse in={open} unmountOnExit>
          <Box
            sx={{
              mt: 0.5,
              mb: 0.25,
              ml: 0.25,
              pl: 1.25,
              pr: 1,
              py: 0.75,
              borderLeft: '2px solid',
              borderColor: 'divider',
              bgcolor: 'action.hover',
              borderRadius: '0 8px 8px 0',
              maxHeight: MEMBER_BODY_MAX_HEIGHT,
              overflowY: 'auto',
              scrollbarGutter: 'stable',
              overscrollBehavior: 'contain',
              '&::-webkit-scrollbar': { width: 6 },
            }}
          >
            {group.task && (
              <Box sx={{ fontSize: 12.5, lineHeight: 1.6, color: 'text.primary' }}>
                {group.task}
              </Box>
            )}
            {group.tools.length > 0 && (
              <Box
                sx={{
                  mt: group.task ? 0.5 : 0,
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: 'text.secondary',
                  wordBreak: 'break-word',
                }}
              >
                调用工具：{group.tools.join(' → ')}
                {group.iterations !== undefined && ` · ${group.iterations} 轮迭代`}
              </Box>
            )}
          </Box>
        </Collapse>
      )}
    </Box>
  );
}

/**
 * 过程时间线：把**深度思考段与工具执行行按到达顺序交错**渲染成一条流。
 *
 * 顺序由数据保证（store 按 SSE 事件到达顺序 push），这里只做「按序铺开」，
 * 于是渲染结果就是模型真实的动作序列：想过一轮 → 查了两个文件 → 又想了一轮 → 再读一个文件。
 *
 * `tier` 决定「铺开多少」：过滤 / 聚合都交给纯函数 `buildProcessRows`，
 * 本组件只按产出的行模型选呈现方式（思考标记 / 工具单行 / 聚合行 / 成员组行）。
 *
 * **自己不做折叠、不设整体限高**——可见性由调用方决定（`AssistantMessage` 用
 * `Collapse unmountOnExit` 在「流式中铺开 / 结束后收起」之间切换）。
 * 之所以不在这一层折叠：折叠会连带把「深度思考」标记一起卸掉，
 * 思考在列表里就凭空消失了；整体限高又会让思考正文（自带 200px 上限与滚动）
 * 落进「滚动条套滚动条」的窘境。过程本身已经很轻：思考正文写完即卸载，
 * 工具行一行一条，不需要再靠折叠压长度。
 *
 * `children` 用于挂载同类别的次要信息（如工具调用卡片），让它们跟随时间线排列，
 * 而不是各自占据消息尾部。
 */
export function ProcessView({
  events,
  live,
  tier,
  children,
}: {
  /** 已按到达顺序排好的过程事件（思考段与工具行交错） */
  events: ProcessEvent[];
  /** 所属消息是否仍在流式输出（只有流式中的最后一段思考会展开正文） */
  live: boolean;
  /**
   * 展示档位（**必填**）。档位决定渲染契约，缺省若给个默认值会静默退回「全量铺开」，
   * 与本需求默认档 `key` 不一致——这是最容易被漏测的形态。因此不给默认值，
   * 强制每个调用点在 `tsc` 阶段显式表态。
   */
  tier: ProcessDetailLevel;
  children?: React.ReactNode;
}) {
  // 末尾那段未闭合的思考才是「此刻仍在写」：只有它展开正文、转圈、自动贴底。
  // 仍扫**原始 `events`**：key/full 下 reasoning 全量保留，结果与过滤后的行一致；
  // result 档不渲染 reasoning，该值无用。
  let liveReasoningId: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === 'reasoning' && !ev.closed) {
      liveReasoningId = ev.id;
      break;
    }
  }

  // 档位过滤 + 聚合（纯函数派生层）：渲染视图模型，永不写回 Message.process
  const rows: ProcessViewRow[] = buildProcessRows(events, tier);

  // 用 Children.count 而不是 `!children`：调用方传 `{arr.map(...)}` 时，
  // 空数组在 JS 里是**真值**，直接判 falsy 会渲染出一个空的过程容器。
  // 判据用 `rows`（过滤后）而非 `events`：result 档可能把全部行过滤掉，
  // 此时若仍有 children 才渲染，否则整块不出现。
  if (rows.length === 0 && Children.count(children) === 0) return null;

  return (
    <Box sx={{ width: '100%', px: 0.5, pb: 0.5, minWidth: 0 }}>
      {rows.map((row) => {
        if (row.kind === 'reasoning') {
          return (
            <ReasoningBlock
              key={row.id}
              content={row.content}
              live={live && row.id === liveReasoningId}
            />
          );
        }
        if (row.kind === 'aggregate') {
          return <AggregateRowView key={row.id} row={row} live={live} />;
        }
        if (row.kind === 'member-group') {
          return <MemberGroupView key={row.id} group={row} live={live} tier={tier} />;
        }
        if (row.kind === 'subagent-group') {
          return <SubagentGroupView key={row.id} group={row} live={live} />;
        }
        return <ToolRow key={row.id} row={row} live={live} />;
      })}
      {children}
    </Box>
  );
}
