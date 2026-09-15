/**
 * 聊天内「定时任务已创建」确认卡片。
 *
 * 数据链路：
 * - 从工具行结果解析引擎 job id（parseCronJobId），从入参映射任务草稿
 *   （cronToolArgsToTaskDraft，复用 cronTaskMirror，绝不自造 id）；
 * - 订阅 useTasksStore 按 jobId 查找镜像任务：
 *   - 存在 → 显示「已设置 ✓」（禁用态显示「已停用」），并优先使用
 *     store 中任务的实时数据（名称 / 调度 / 提示词 / 状态）；
 *   - 不存在（镜像失败等）→ 回退展示草稿信息，标注「已创建（引擎侧）」；
 *   - 草稿也缺失时，从结果字符串 `Created job '<name>' (id: <id>)` 提取名称兜底。
 * - 「打开」按钮跳转任务页（本期不做执行会话跳转）。
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Paper, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { cronToolArgsToTaskDraft, parseCronJobId } from '@/ai/cronTaskMirror';
import { describeSchedule } from '@/lib/cron';
import { ROUTES } from '@/lib/constants';
import { useTasksStore } from '@/stores/tasksStore';
import type { ProcessToolRow } from '@/types';

interface CronTaskCardProps {
  /** cron 工具执行行（调用方已保证 status='done' 且可解析出 job id） */
  row: ProcessToolRow;
}

/** 从引擎成功结果字符串中提取任务名（`Created job '<name>' ...`），仅作兜底展示 */
function nameFromResult(result: string | undefined): string | null {
  const m = result?.match(/^Created job '([^']*)'/);
  return m?.[1] || null;
}

export function CronTaskCard({ row }: CronTaskCardProps) {
  const navigate = useNavigate();

  // 解析 job id 与任务草稿（纯函数，结果随行内容稳定，useMemo 缓存）
  const { jobId, draft } = useMemo(
    () => ({
      jobId: parseCronJobId(row.result),
      draft: cronToolArgsToTaskDraft(row.args),
    }),
    [row],
  );

  // 按引擎 job id 订阅镜像任务（store 为任务唯一数据源，实时反映改名/启停）
  const task = useTasksStore((s) =>
    jobId ? s.tasks.find((t) => t.id === jobId) ?? null : null,
  );

  // 展示数据：镜像任务优先，草稿回退，结果字符串名称兜底
  const name = task?.name || draft?.name || nameFromResult(row.result) || '定时任务';
  const schedule = task?.schedule ?? draft?.schedule;
  const prompt = task?.prompt || draft?.prompt || '';
  const inStore = Boolean(task);
  const disabled = inStore && task!.status === 'disabled';

  return (
    <Paper
      variant="outlined"
      sx={{
        width: '100%',
        mt: 0.5,
        px: 1.5,
        py: 1.25,
        bgcolor: 'background.paper',
        borderColor: 'divider',
        borderRadius: 2.5,
        transition: 'border-color .15s',
        '&:hover': { borderColor: 'primary.main' },
      }}
    >
      {/* 顶行：调度标签（左）+ 状态徽标（右） */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            minWidth: 0,
            color: 'text.secondary',
            fontSize: 12,
          }}
        >
          <ScheduleIcon sx={{ fontSize: 13, flexShrink: 0 }} />
          <Box
            component="span"
            sx={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {schedule ? describeSchedule(schedule) : '定时执行'}
          </Box>
        </Box>
        <Box sx={{ flex: 1 }} />
        {inStore && !disabled && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.4,
              flexShrink: 0,
              color: 'success.main',
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            <CheckCircleIcon sx={{ fontSize: 14 }} />
            已设置
          </Box>
        )}
        {inStore && disabled && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.4,
              flexShrink: 0,
              color: 'warning.main',
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            <PauseCircleOutlineIcon sx={{ fontSize: 14 }} />
            已停用
          </Box>
        )}
        {!inStore && (
          <Box
            sx={{
              flexShrink: 0,
              color: 'text.secondary',
              fontSize: 12.5,
            }}
          >
            已创建（引擎侧）
          </Box>
        )}
      </Box>

      {/* 中间行：加粗任务名 + 灰色提示词摘要（单行截断）+ 「打开」按钮 */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 0.75 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            sx={{
              fontSize: 14,
              fontWeight: 600,
              color: 'text.primary',
            }}
            noWrap
          >
            {name}
          </Typography>
          {prompt && (
            <Typography
              sx={{
                fontSize: 12.5,
                color: 'text.secondary',
                mt: 0.25,
              }}
              noWrap
            >
              {prompt}
            </Typography>
          )}
        </Box>
        <Button
          size="small"
          variant="outlined"
          onClick={() => navigate(ROUTES.tasks)}
          sx={{
            flexShrink: 0,
            borderRadius: 1.5,
            borderColor: 'divider',
            color: 'text.secondary',
            px: 1.5,
            minWidth: 52,
            '&:hover': {
              borderColor: 'primary.main',
              color: 'primary.main',
              bgcolor: 'transparent',
            },
          }}
        >
          打开
        </Button>
      </Box>
    </Paper>
  );
}
