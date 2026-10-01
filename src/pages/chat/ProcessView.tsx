import { Children, useState } from 'react';
import { Box, CircularProgress, Collapse, Tooltip } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { ReasoningBlock } from './ReasoningBlock';
import { describeTool } from './toolDescribe';
import { buildProcessRows } from '@/lib/processDetail';
import type { AggregateRow, ProcessViewRow } from '@/lib/processDetail';
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

/**
 * 过程时间线：把**深度思考段与工具执行行按到达顺序交错**渲染成一条流。
 *
 * 顺序由数据保证（store 按 SSE 事件到达顺序 push），这里只做「按序铺开」，
 * 于是渲染结果就是模型真实的动作序列：想过一轮 → 查了两个文件 → 又想了一轮 → 再读一个文件。
 *
 * `tier` 决定「铺开多少」：过滤 / 聚合都交给纯函数 `buildProcessRows`，
 * 本组件只按产出的行模型选呈现方式（思考标记 / 工具单行 / 聚合行）。
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
        return <ToolRow key={row.id} row={row} live={live} />;
      })}
      {children}
    </Box>
  );
}
