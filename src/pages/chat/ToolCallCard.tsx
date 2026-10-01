import { useState } from 'react';
import { Box, CircularProgress, Collapse, Tooltip } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { describeTool } from './toolDescribe';
import type { ToolCall, ToolCallStatus } from '@/types';

/**
 * 工具调用卡片——**渲染成一行工作步骤**，与过程时间线的工具行同形。
 *
 * ## 为什么不再是一张「卡片」
 *
 * 它原本是一个带框的块（工具名 + 敏感 Chip + 状态 Chip + 展开箭头）。但在真实
 * 会话里，**写文件 / 执行命令 / MCP 调用全是敏感工具**，于是一条长任务会垒起
 * 十几张「write_file 敏感 已批准」的卡——2026-10-01 用户截图里那堵墙就是它。
 * 每张卡的「敏感」「已批准」都恒为真，信息量趋近于零，却把真正有内容的
 * 过程时间线（已写入 D:/… / 已执行 pnpm test）挤到一边。
 *
 * 改法：**只说人话，把原始事实收进展开区**。折叠态就是一行
 * 「已执行 rm -rf /」，与它上下的工具行用同一套动词与图标；点开才给
 * 工具名 + 参数 + 结果的原始视图（调试时才需要）。
 *
 * ## 状态只在「值得看一眼」时才说话
 *
 * `pending` / `rejected` / `error` 是有内容的状态（等授权、被拒、失败），
 * 必须写在行上；`approved` / `done` 是正常路径——一次成功执行本身就是
 * 「已批准」的全部证据，再挂两个字只是噪声。`running` 用转圈表达。
 */

/**
 * 值得在行上显式说出的状态。其余状态（approved / done / running）不挂文字：
 * 前者是正常路径（会执行本身就说明批准了），后者用进度转圈表达。
 */
const NOTABLE_LABEL: Partial<Record<ToolCallStatus, string>> = {
  pending: '等待授权',
  rejected: '已拒绝',
  error: '失败',
};

const NOTABLE_COLOR: Partial<Record<ToolCallStatus, string>> = {
  pending: 'warning.main',
  rejected: 'error.main',
  error: 'error.main',
};

export function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);

  // 动词 / 目标与过程行共用一份映射：两处各写一套，同一句「已写入 D:/…」
  // 会在时间线里叫「已写入」、在卡片里叫「write_file」，用户看到的仍是两件事。
  const d = describeTool(toolCall.tool, toolCall.args);
  const label = NOTABLE_LABEL[toolCall.status];

  return (
    <Box sx={{ minWidth: 0 }}>
      <Box
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={open ? '收起工具调用详情' : '展开工具调用详情'}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          py: 0.4,
          fontSize: 13,
          color: 'text.secondary',
          cursor: 'pointer',
          userSelect: 'none',
          minWidth: 0,
          '&:hover': { color: 'text.primary' },
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
        {/* 敏感标记只留给「还没落地」的调用：它解释了这一行为什么在等授权。
            已批准 / 已完成的行不挂——非只读工具全是敏感工具，挂上去等于人人有份。 */}
        {toolCall.sensitive && toolCall.status === 'pending' && (
          <Box component="span" sx={{ color: 'warning.main', flexShrink: 0 }}>
            敏感
          </Box>
        )}
        {label && (
          <Box component="span" sx={{ color: NOTABLE_COLOR[toolCall.status], flexShrink: 0 }}>
            {label}
          </Box>
        )}
        {toolCall.status === 'running' && (
          <CircularProgress size={9} sx={{ color: 'text.secondary', flexShrink: 0 }} />
        )}
        <Box sx={{ flex: 1, minWidth: 0 }} />
        <ChevronRightIcon
          sx={{
            fontSize: 14,
            flexShrink: 0,
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform .15s',
          }}
        />
      </Box>

      <Collapse in={open} unmountOnExit>
        <Box sx={{ mt: 0.5, mb: 0.25, ml: 0.25, pl: 1.25, borderLeft: '2px solid', borderColor: 'divider' }}>
          <RawLine label="工具" value={toolCall.tool} />
          <RawBlock title="参数" body={JSON.stringify(toolCall.args, null, 2)} />
          {toolCall.result !== undefined && <RawBlock title="结果" body={toolCall.result} />}
        </Box>
      </Collapse>
    </Box>
  );
}

/**
 * 原始事实的一行标签（如工具名）。
 *
 * 工具名**只出现在展开区**：折叠态说人话（「已执行 pnpm test」），工具名
 * 是调试才要的东西，摆在行上只会把工作步骤变回「卡片」。
 */
function RawLine({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, pt: 0.25, fontSize: 11.5, color: 'text.disabled' }}>
      <Box component="span">{label}</Box>
      <Box
        component="span"
        sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
      >
        {value}
      </Box>
    </Box>
  );
}

/** 参数 / 结果原文块 */
function RawBlock({ title, body }: { title: string; body: string }) {
  return (
    <>
      <Box sx={{ pt: 0.5, fontSize: 11.5, color: 'text.disabled' }}>{title}</Box>
      <Box
        component="pre"
        sx={{
          m: 0,
          mt: 0.25,
          p: 0.75,
          maxHeight: 200,
          overflow: 'auto',
          borderRadius: 1,
          bgcolor: 'action.hover',
          fontSize: 11.5,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {body}
      </Box>
    </>
  );
}
