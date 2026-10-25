import { useEffect, useRef, useState } from 'react';
import { Box, Button, Collapse, IconButton, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { selectPendingApproval, useSessionsStore } from '@/stores/sessionsStore';
import type { PendingApproval } from '@/stores/sessionsStore';
import type { ApprovalDecision } from '@/ai/runtime/types';
import { chatColumnSx } from '@/pages/chat/chatColumnSx';
import { describeApproval } from '@/lib/ui/approvalSummary';

/**
 * 逐条批准卡片（FR-1.5）。
 *
 * ## 与旧弹窗的三处本质区别
 *
 * 1. **不在屏幕中央打断你**：旧版是 `Dialog`，带全屏遮罩把整页压暗，用户正在
 *    读的工具时间线被整个挡掉——而「要不要放行」这个判断恰恰需要看着那条
 *    时间线做（上一步刚做了什么、模型在解什么问题）。现在它贴在底部**覆盖
 *    输入框**：遮起来的只是用户此刻本来也没在用的那块，消息流全程可见。
 * 2. **先给结论，再给证据**：旧版正文第一眼是 200px 高的 JSON 块。现在第一眼
 *    是一句人话摘要（「修改文件 D:/.../tetris.js」），参数降级为可折叠的证据。
 * 3. **三档而不是两档**：拒绝 / 允许本次 / 本会话始终允许（下拉）。第三条是
 *    长任务里最缺的——同一个工具连环弹十几次时，用户真正想说的一句话是
 *    「知道了，这个工具别再问我」。
 *
 * ## 去掉遮罩之后，模态语义并没有丢
 *
 * 卡片没有关闭按钮、ESC 也不响应——引擎此刻正阻塞在 `before_execute_tool` 里
 * 等裁决，用户唯一能做的就是给个说法。去掉的只是那层把别的信息也一起盖住的
 * 灰，而不是「必须裁决」这件事本身。
 */
export function ApprovalCard() {
  const pending = useSessionsStore(selectPendingApproval);
  const queued = useSessionsStore((s) => s.pendingApprovals.length);
  const resolveApproval = useSessionsStore((s) => s.resolveApproval);

  if (!pending) return null;

  // 用 `key` 把「一条请求一份状态」交给 React 自己保证。
  //
  // 早先的写法是让 Body 自己持有 `reason` / `reasonOpen` / `detailsOpen` 等状态，
  // 再在渲染期比对 `lastIdRef` 手动重置。**在 `React.StrictMode` 下那是坏的**：
  // StrictMode 会把每次渲染跑两遍，而渲染期的副作用（`lastIdRef.current = id`）
  // 是**幂等的假象**——第一遍把 ref 写掉、并排队一个 `setXxx(false)`，第一遍的
  // 输出被 React 丢弃；第二遍一看 ref 已是新 id，直接跳过重置。于是那批
  // `setXxx(false)` 全部落空，「上一条点开的拒绝原因输入框」原样留在新卡片里。
  // （真机复现过：连挂两条 + 中间展开过拒绝原因，第二条仍然是 textarea。）
  //
  // 换成 `key` 之后，请求一变就是**卸载重挂**：状态天然归零，不依赖任何手写
  // 重置逻辑，也不受双渲染影响。`queued` 是唯一的例外——它描述的是队列本身
  // （「还有 N 条待处理」），不属于某一条请求，所以留在外层订阅。
  return (
    <ApprovalCardBody
      key={pending.id}
      pending={pending}
      queued={queued}
      resolveApproval={resolveApproval}
    />
  );
}

/**
 * 单条审批请求的卡片内容。状态随 `key={pending.id}` 在换请求时整体重建。
 *
 * ## 两种数据源（任务视图 / IM 会话）
 *
 * - 任务视图：`sessionsStore.pendingApprovals`（SSE 推来的），裁决走
 *   `runtime.respondApproval` → serve 进程的 `POST /v1/tool-approvals/{id}`；
 * - IM 会话：`channelApprovalsStore`（轮询 gateway 的会话快照），裁决走
 *   gateway 的 `POST /v1/approvals/resolve`。
 *
 * 两条链路的**裁决落点不同**（serve 进程 vs gateway 进程，各有一张
 * `PENDING_APPROVALS`），因此裁决函数由调用方注入而不是在这里选。
 * 但**视觉与交互**完全一致——所以共用这一个 Body，不做第二套渲染。
 */
export function ApprovalCardBody({
  pending,
  queued,
  resolveApproval,
}: {
  /** 只要 id / tool / args 三个字段：两种数据源的载荷形状不同，取交集即可 */
  pending: { id: string; tool: string; args: Record<string, unknown> };
  queued: number;
  resolveApproval: (decision: ApprovalDecision, reason?: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  /** 参数证据区是否展开 */
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** 拒绝原因输入框是否已展开（收起时只显示一行入口） */
  const [reasonOpen, setReasonOpen] = useState(false);
  /** 「允许本次」旁边的升级下拉 */
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 下拉开着时点别处收起。用原生监听而不是 MUI Menu：后者带一层 portal 与
  // 全屏遮罩，而这里要的只是「按钮下面那一小块」。
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const { summary, rows } = describeApproval(pending.tool, pending.args);
  const hasDetails = rows.length > 0;

  const settle = async (decision: 'allow' | 'deny' | 'always') => {
    if (busy) return;
    setBusy(true);
    setMenuOpen(false);
    await resolveApproval(decision, decision === 'deny' ? reason : undefined);
    setBusy(false);
  };

  return (
    <Box
      // 键盘快捷键挂在卡片上而不是全局：全局监听会在用户于设置页敲字时也抢键。
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void settle('allow');
        }
      }}
      sx={{
        // 覆盖输入框：绝对定位、贴底、与输入框共用同一个内容列宽度。
        // **不设遮罩**是刻意的，见文件头注释。
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20,
        // 这里**不能**加下内边距。
        //
        // 锚点层贴的是「会话页内容区」的底边，而输入框外面还包着一层
        // `Composer` 的 `py: 1.5`（12px 下留白）。给锚点层加 `pb` 会让卡片
        // 底边比容器底边高出同样的 12px，正好把输入卡片下面那条留白露出来
        // ——截图里是输入框 placeholder 像鬼影一样透在卡片下沿之外。
        // 让卡片贴到容器底，就与输入框「同一条底边」对齐了。
        // 卡片自己的呼吸感由内部子块的 `pb` 提供（见 Actions）。
        //
        // 卡片只在自身范围内接管指针：横带两侧的留白仍应能点到下面的消息流
        pointerEvents: 'none',
      }}
    >
      <Box
        data-testid="approval-card"
        sx={{
          ...chatColumnSx,
          pointerEvents: 'auto',
          borderRadius: 2.5,
          border: '1px solid',
          borderColor: 'warning.main',
          // 底衬用「主题纸色 + 一点暖」而不是纯 warning 底：深色下纯黄会糊成
          // 一块亮斑，浅色下又会盖掉正文对比度。描边承担「这是什么」的语义，
          // 底色只负责把它和消息流分开。
          bgcolor: (theme) =>
            theme.palette.mode === 'dark'
              ? 'rgba(38, 32, 20, 0.97)'
              : 'rgba(255, 251, 235, 0.98)',
          boxShadow: (theme) =>
            theme.palette.mode === 'dark'
              ? '0 10px 32px rgba(0,0,0,0.55)'
              : '0 10px 32px rgba(15,23,42,0.16)',
          overflow: 'hidden',
        }}
      >
        <Header tool={pending.tool} queued={queued} />

        {/* 正文：摘要句。认不出工具时退回「动作名 + 完整参数」的兜底 */}
        <Box sx={{ px: 1.75, pt: 0.75 }}>
          <Typography
            data-testid="approval-summary"
            sx={{ fontSize: 13.5, lineHeight: 1.55, wordBreak: 'break-word' }}
          >
            <Box component="span" sx={{ color: 'text.secondary' }}>
              {summary
                ? 'Agent 想执行一个会改动环境的操作：'
                : `Agent 想${hasDetails ? '执行以下操作' : '执行一个会改动环境的操作'}`}
            </Box>
            {summary && (
              <Box component="span" sx={{ fontWeight: 600 }}>
                {summary}
              </Box>
            )}
          </Typography>

          {/* 摘要与参数都拿不到：如实说明，而不是摆一个空块让用户以为界面坏了 */}
          {!summary && !hasDetails && (
            <Typography
              sx={{
                mt: 0.5,
                fontSize: 12,
                color: 'text.secondary',
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
              }}
            >
              <ErrorOutlineIcon sx={{ fontSize: 14 }} />
              该调用没有携带可展示的参数，请谨慎放行。
            </Typography>
          )}
        </Box>

        {/* 证据区：参数折叠块。摘要认得出时默认收起（不必读 JSON 就能决策），
            认不出时默认展开（参数是唯一信息源）。 */}
        {hasDetails && <Details
          summary={summary}
          rows={rows}
          open={detailsOpen}
          onToggle={() => setDetailsOpen((v) => !v)}
        />}

        {/* 拒绝原因（可选）：收起时是一行入口，点开才是输入框 */}
        <Box sx={{ px: 1.75, pt: 0.5 }}>
          <RefuseReason
            value={reason}
            onChange={setReason}
            open={reasonOpen}
            onOpen={() => setReasonOpen(true)}
          />
        </Box>

        <Actions
          busy={busy}
          menuOpen={menuOpen}
          menuRef={menuRef}
          onToggleMenu={() => setMenuOpen((v) => !v)}
          onDeny={() => void settle('deny')}
          onAllow={() => void settle('allow')}
          onAlways={() => void settle('always')}
        />
      </Box>
    </Box>
  );
}

/** 标题行：圆点 + 「等待审批」+ 待处理计数 + 工具名 */
function Header({ tool, queued }: { tool: string; queued: number }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.75, pt: 1.25 }}>
      <Box
        sx={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          bgcolor: 'warning.main',
          flexShrink: 0,
        }}
      />
      <Typography sx={{ fontSize: 12.5, fontWeight: 600, color: 'warning.main' }}>
        等待审批
      </Typography>
      {queued > 1 && (
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          · 还有 {queued - 1} 条待处理
        </Typography>
      )}
      <Box sx={{ flex: 1 }} />
      <Typography
        sx={{
          fontSize: 11.5,
          color: 'text.secondary',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        }}
      >
        {tool}
      </Typography>
    </Box>
  );
}

/** 参数折叠块 */
function Details({
  summary,
  rows,
  open,
  onToggle,
}: {
  summary: string | null;
  rows: Array<{ label: string; value: string }>;
  open: boolean;
  onToggle: () => void;
}) {
  const expanded = open || !summary;
  return (
    <Box sx={{ px: 1.75, pt: summary ? 0.25 : 0.75 }}>
      {summary && (
        <Button
          size="small"
          aria-expanded={expanded}
          onClick={onToggle}
          endIcon={
            expanded ? (
              <KeyboardArrowUpIcon sx={{ fontSize: 16 }} />
            ) : (
              <ExpandMoreIcon sx={{ fontSize: 16 }} />
            )
          }
          sx={{
            minWidth: 0,
            px: 0.5,
            fontSize: 12,
            color: 'text.secondary',
            '&:hover': { color: 'text.primary', bgcolor: 'transparent' },
          }}
        >
          {expanded ? '收起参数' : '查看参数'}
        </Button>
      )}
      <Collapse in={expanded}>
        <Box
          component="pre"
          data-testid="approval-args"
          sx={{
            m: 0,
            mt: summary ? 0 : 0.25,
            p: 1,
            maxHeight: 168,
            overflow: 'auto',
            borderRadius: 1.5,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 11.5,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            bgcolor: (theme) =>
              theme.palette.mode === 'dark'
                ? 'rgba(0,0,0,0.35)'
                : 'rgba(15,23,42,0.045)',
            color: 'text.primary',
          }}
        >
          {rows.map((r) => `${r.label}: ${r.value}`).join('\n')}
        </Box>
      </Collapse>
    </Box>
  );
}

/** 操作行：拒绝 / 允许本次（+ 升级下拉） */
function Actions({
  busy,
  menuOpen,
  menuRef,
  onToggleMenu,
  onDeny,
  onAllow,
  onAlways,
}: {
  busy: boolean;
  menuOpen: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggleMenu: () => void;
  onDeny: () => void;
  onAllow: () => void;
  onAlways: () => void;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 0.75,
        px: 1.75,
        pt: 1,
        pb: 1.5,
      }}
    >
      <Typography sx={{ fontSize: 11, color: 'text.disabled', mr: 'auto' }}>
        Ctrl + Enter 快速允许
      </Typography>

      <Button
        size="small"
        disabled={busy}
        onClick={onDeny}
        sx={{
          minWidth: 72,
          color: 'text.secondary',
          border: '1px solid',
          borderColor: 'divider',
          '&:hover': {
            color: 'text.primary',
            borderColor: 'text.secondary',
            bgcolor: 'action.hover',
          },
        }}
      >
        拒绝
      </Button>

      {/* 「允许本次」+ 升级箭头拆成两个可点区，而不是一个按钮加菜单：
          用户绝大多数时候要的就是「本次」，多一次点击是净损失。 */}
      <Box
        ref={menuRef}
        sx={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'stretch',
          borderRadius: 1,
          overflow: 'visible',
        }}
      >
        <Box
          sx={{
            display: 'inline-flex',
            alignItems: 'stretch',
            borderRadius: 1,
            overflow: 'hidden',
            bgcolor: 'primary.main',
            opacity: busy ? 0.6 : 1,
          }}
        >
          <Button
            size="small"
            disabled={busy}
            onClick={onAllow}
            sx={{
              minWidth: 84,
              borderRadius: 0,
              color: 'primary.contrastText',
              bgcolor: 'transparent',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.14)' },
            }}
          >
            允许本次
          </Button>
          <Box sx={{ width: '1px', bgcolor: 'rgba(255,255,255,0.22)', my: 0.75 }} />
          <IconButton
            size="small"
            disabled={busy}
            aria-label="更多允许方式"
            aria-expanded={menuOpen}
            onClick={onToggleMenu}
            sx={{
              borderRadius: 0,
              width: 30,
              color: 'primary.contrastText',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.14)' },
            }}
          >
            <KeyboardArrowDownIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>

        <Collapse
          in={menuOpen}
          unmountOnExit
          sx={{ position: 'absolute', bottom: '100%', right: 0, mb: 0.5 }}
        >
          <Box
            role="button"
            tabIndex={0}
            aria-label="本会话始终允许该工具"
            onClick={onAlways}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onAlways();
              }
            }}
            sx={{
              minWidth: 256,
              px: 1.25,
              py: 0.75,
              borderRadius: 1.5,
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.paper',
              boxShadow: 6,
              cursor: 'pointer',
              '&:hover': { bgcolor: 'action.hover' },
              '&:focus-visible': { outline: '1px solid', outlineColor: 'primary.main' },
            }}
          >
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
              本会话始终允许
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
              仅限本会话与这个工具；换会话、换工具仍会确认。
            </Typography>
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
}

/**
 * 拒绝原因输入。
 *
 * 收起时是一行可点的提示、点开才给输入框：批准是主路径，不该被一个可选
 * 输入框占掉一行视觉重心。但入口的存在感不能太弱——拒绝时说清理由能让模型
 * 立刻改道，比默默拒绝有效得多。
 *
 * 展开态由父组件持有（而不是这里自己 `useState`）：换到下一条请求时父组件
 * 要把它和 reason 一起清掉，自己持有时父组件够不着，于是「上一条点开的输入框
 * 会在新卡片里继续开着」。
 */
function RefuseReason({
  value,
  onChange,
  open,
  onOpen,
}: {
  value: string;
  onChange: (v: string) => void;
  /** 展开态由父组件持有：换到下一条请求时它要能一起被重置 */
  open: boolean;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  if (!open && value.trim() === '') {
    return (
      <Button
        size="small"
        onClick={onOpen}
        sx={{
          minWidth: 0,
          px: 0.5,
          fontSize: 12,
          color: 'text.secondary',
          '&:hover': { color: 'text.primary', bgcolor: 'transparent' },
        }}
      >
        拒绝原因（可选，会告诉 Agent 你的意图）
      </Button>
    );
  }

  return (
    <Box
      component="textarea"
      ref={ref}
      rows={2}
      value={value}
      placeholder="拒绝原因（可选）：告诉 Agent 你的意图，它会据此改道"
      onChange={(e) => onChange((e.target as HTMLTextAreaElement).value)}
      sx={{
        width: '100%',
        resize: 'vertical',
        px: 1,
        py: 0.75,
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        color: 'text.primary',
        fontSize: 12.5,
        fontFamily: 'inherit',
        lineHeight: 1.5,
        outline: 'none',
        '&::placeholder': { color: 'text.secondary', opacity: 0.75 },
        '&:focus': { borderColor: 'primary.main' },
      }}
    />
  );
}
