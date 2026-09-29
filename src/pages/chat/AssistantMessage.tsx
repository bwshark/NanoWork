import { useEffect, useState } from 'react';
import {
  Avatar,
  Box,
  CircularProgress,
  Collapse,
  IconButton,
  Paper,
  Tooltip,
  Typography,
} from '@mui/material';
import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { parseCronJobId } from '@/ai/cronTaskMirror';
import { MemoryService } from '@/lib/memory';
import { useSessionsStore, selectSessionStreamStatus } from '@/stores/sessionsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';
import { avatarGlyph, entityAvatarSx } from '@/lib/cardSx';
import { digestProcess, formatDuration } from '@/lib/processDigest';
import { toast } from '@/components/Toast';
import { CreateTaskDialog } from '@/components/chat/CreateTaskDialog';
import { CronTaskCard } from '@/components/chat/CronTaskCard';
import { MarkdownView } from '@/components/MarkdownView';
import { ArtifactRenderer } from '@/components/ArtifactRenderer';
import { ProcessView } from './ProcessView';
import { ToolCallCard } from './ToolCallCard';
import { PlanCard } from './PlanCard';
import type { Message, ProcessToolRow } from '@/types';

interface AssistantMessageProps {
  message: Message;
  /** 来自 session.agentId，用于创建定时任务的预填目标 Agent，同时用于消息头署名 */
  agentId: string;
  /** 消息所属会话 id，用于按会话读取独立流式状态 */
  sessionId: string;
}

/**
 * 流式状态 → 消息底部状态行文案。
 *
 * `reasoning` 必须与 `thinking` 分开：前者是模型正在回吐深度思考正文
 * （用户已能看见思考在滚动），后者才是「请求已发出、首帧未到」的真空等待。
 * 若合并，深度思考期间状态行会误报为「等待模型响应」。
 */
function streamStatusText(status: string): string {
  if (status === 'streaming') return '生成回复中';
  if (status === 'reasoning') return '深度思考中';
  if (status === 'tooling') return '执行工具';
  return '等待模型响应';
}

/**
 * 助手消息（左侧）：署名头 + 过程开关行 + 过程时间线 + 流式 Markdown + 富产物。
 *
 * 过程（深度思考标记行 + 工具执行行）的可见性跟着**对话是否还在进行**：
 * - **流式中**：自动铺开，用户要看到此刻在做什么；
 * - **结束后**：整块收起，只留一行「已完成 1m12s ›」——回答才是结果，
 *   过程是回溯用的证据。实测里一条长任务的思考标记 + 工具行能顶掉一整屏，
 *   铺开后真正的结论被推到屏幕之外，所以完成后必须收。
 *
 * 收起走 `Collapse unmountOnExit`，即**过程整块从 DOM 卸载**（含已写完的思考正文），
 * 而不是仅仅视觉隐藏；点开才重新挂载。用户手动点过之后以其选择为准，
 * 不再被「是否流式中」的自动行为覆盖。
 */
export function AssistantMessage({ message, agentId, sessionId }: AssistantMessageProps) {
  const [hovered, setHovered] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  /** 过程开关的用户手动表态：null = 未表态，跟随「是否流式中」自动决策 */
  const [manualProcessOpen, setManualProcessOpen] = useState<boolean | null>(null);

  // 按「所属会话」读取独立流式状态：仅该会话流式期间、且本消息是其最后一条时
  // 显示过程状态行，避免历史中断遗留的空消息被误判为思考中
  const streamStatus = useSessionsStore((s) =>
    selectSessionStreamStatus(s, sessionId),
  );
  const isLastOfSession = useSessionsStore((s) => {
    const msgs = s.sessions.find((x) => x.id === sessionId)?.messages;
    return msgs?.[msgs.length - 1]?.id === message.id;
  });
  const isStreaming = streamStatus !== 'idle' && isLastOfSession;
  // 「记住这条」的落点是**这条消息所属会话**的工作区，而不是当前活跃会话：
  // 全局搜索结果里对旧会话的消息做操作时，两者并不相同。
  const activeTitle = useSessionsStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.title ?? '会话',
  );
  // `?? null` 不能省：`undefined` 在 MemoryService 里表示「按当前工作区」，
  // 而这里要表达的是「这条消息所属会话的工作目录，没有就是没有」。
  const memoryWorkspace = useSessionsStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.workdir ?? null,
  );

  // 署名：会话绑定的专家 / 专家团（找不到时退回「助手」）
  const agent = useAgentsStore((s) => s.agents.find((a) => a.id === agentId));
  const group = useExpertGroupsStore((s) => s.groups.find((g) => g.id === agentId));
  const displayName = agent?.name ?? group?.name ?? '助手';
  const { glyph, isEmoji } = avatarGlyph(agent?.avatar ?? group?.icon, displayName);

  // 流式中的实时耗时：每秒走一格；结束后改读冻结下来的 durationMs
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isStreaming || message.durationMs !== undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming, message.durationMs]);

  const startedAt = Date.parse(message.createdAt);
  const elapsedMs =
    message.durationMs ??
    (isStreaming && !Number.isNaN(startedAt) ? Math.max(now - startedAt, 0) : 0);
  const elapsedText = formatDuration(elapsedMs);

  const hasContent = message.content.trim().length > 0;

  // 筛出「cron add 成功且可解析出引擎 job id」的工具行 → 渲染任务确认卡片；
  // 这些行从过程时间线中排除，避免与卡片重复展示同一创建事件。
  const cronCardRows: ProcessToolRow[] = (message.process ?? []).filter(
    (ev): ev is ProcessToolRow =>
      ev.kind === 'tool' &&
      ev.tool === 'cron' &&
      ev.status === 'done' &&
      ev.args.action === 'add' &&
      parseCronJobId(ev.result) !== null,
  );
  const cronCardIds = new Set(cronCardRows.map((r) => r.id));
  const processEvents = (message.process ?? []).filter(
    (ev) => !(ev.kind === 'tool' && cronCardIds.has(ev.id)),
  );
  // 工具调用卡片与过程行同属「执行细节」，一起挂在时间线末尾，不再单独占尾部空间
  const toolCalls = message.toolCalls ?? [];

  // 失败步数提到署名头：过程收起后失败行看不见了，
  // 而「哪一轮跑挂了」是唯一值得在头行就暴露的异常信号。
  const failedSteps = digestProcess(processEvents).errors;

  // 搜索激活时强制展开过程：命中项藏在折叠区里会搜不到，也会定位不到
  const searchSessionId = useSessionUiStore((s) => s.searchSessionId);
  const searchQuery = useSessionUiStore((s) => s.searchQuery);
  const searchForcesOpen = searchSessionId === sessionId && searchQuery.trim() !== '';

  const hasProcess = processEvents.length > 0 || toolCalls.length > 0;
  const processOpen = searchForcesOpen || (manualProcessOpen ?? isStreaming);
  const toggleProcess = () => {
    if (!hasProcess) return;
    setManualProcessOpen(!processOpen);
  };
  /** 开关行文案：结束后是「已完成」——过程在这里是回溯入口，不是进行中的事 */
  const processStateText = isStreaming ? '已处理' : message.aborted ? '已停止' : '已完成';

  const saveAsMemory = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await MemoryService.append(
        message.content,
        { source: activeTitle },
        'workspace',
        memoryWorkspace,
      );
      toast.success('已保存到记忆');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`保存记忆失败：${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const actionSx = {
    opacity: hovered ? 1 : 0,
    transition: 'opacity .15s',
    pointerEvents: hovered ? 'auto' : 'none' as const,
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        mb: 1.5,
        alignItems: 'flex-start',
        // 占满消息列宽度，右边界与用户气泡（靠右对齐，右边界即列右边界）齐平。
        // 曾用 maxWidth: '85%' 限制行宽，结果整块内容右边空出一条竖带，
        // 与用户气泡的右边界错开 139px——同一个对话列左右不对齐，非常显眼。
        // 回归：tasks/verify-chat-column-align.mjs
        width: '100%',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* 署名行：头像 + 名称 */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          mb: hasProcess ? 0.25 : 0.5,
          minWidth: 0,
          width: '100%',
        }}
      >
        <Avatar
          sx={{
            ...entityAvatarSx(displayName, isEmoji),
            width: 22,
            height: 22,
            fontSize: isEmoji ? 13 : 11,
          }}
        >
          {glyph}
        </Avatar>
        <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
          {displayName}
        </Typography>
      </Box>

      {/* 过程开关行：流式中「已处理 33s」并自动铺开，结束后收成「已完成 1m41s ›」 */}
      {hasProcess && (
        <Box
          role="button"
          tabIndex={0}
          aria-expanded={processOpen}
          aria-label={processOpen ? '收起执行过程' : '展开执行过程'}
          onClick={toggleProcess}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleProcess();
            }
          }}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.4,
            mb: 0.5,
            fontSize: 12.5,
            color: 'text.disabled',
            cursor: 'pointer',
            userSelect: 'none',
            transition: 'color .15s',
            '&:hover': { color: 'text.primary' },
          }}
        >
          {isStreaming && !elapsedText && (
            <CircularProgress size={9} sx={{ color: 'text.secondary' }} />
          )}
          <span>
            {processStateText}
            {elapsedText ? ` ${elapsedText}` : ''}
          </span>
          {failedSteps > 0 && (
            <Box component="span" sx={{ color: 'error.main' }}>
              · {failedSteps} 步失败
            </Box>
          )}
          <ChevronRightIcon
            sx={{
              fontSize: 14,
              transform: processOpen ? 'rotate(90deg)' : 'none',
              transition: 'transform .15s',
            }}
          />
        </Box>
      )}

      <Collapse in={processOpen} unmountOnExit>
        <ProcessView events={processEvents} live={isStreaming}>
          {toolCalls.length > 0
            ? toolCalls.map((t) => <ToolCallCard key={t.id} toolCall={t} />)
            : null}
        </ProcessView>
      </Collapse>

      {cronCardRows.map((row) => (
        <CronTaskCard key={row.id} row={row} />
      ))}

      {hasContent && (
        <Paper
          elevation={0}
          sx={{
            width: '100%',
            px: 1.5,
            py: 1,
            bgcolor: 'background.paper',
            borderRadius: '12px 12px 12px 2px',
          }}
        >
          <MarkdownView content={message.content} />
        </Paper>
      )}

      {message.aborted && (
        <Typography
          sx={{
            fontSize: 12,
            color: 'text.disabled',
            mt: 0.5,
            fontStyle: 'italic',
          }}
        >
          （已停止）
        </Typography>
      )}

      {isStreaming && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            mt: 0.5,
            px: 0.5,
            color: 'text.secondary',
            fontSize: 12.5,
          }}
        >
          <CircularProgress size={9} sx={{ color: 'text.secondary' }} />
          {streamStatusText(streamStatus)}
        </Box>
      )}

      {message.artifacts?.map((a) => (
        <ArtifactRenderer key={a.id} artifact={a} />
      ))}

      {/* 计划清单（FR-1.5）：与正文同级而非藏在「过程」折叠里——
          它是本轮唯一需要用户做决定的东西，收起来等于没给入口 */}
      {message.plan && (
        <PlanCard
          sessionId={sessionId}
          messageId={message.id}
          planId={message.plan.planId}
        />
      )}

      <Box
        sx={{
          display: 'flex',
          gap: 0.5,
          mt: 0.5,
          alignSelf: 'flex-start',
          ...actionSx,
        }}
      >
        <Tooltip title="保存为记忆">
          <IconButton
            size="small"
            onClick={saveAsMemory}
            disabled={saving}
            aria-label="保存为记忆"
          >
            <BookmarkAddIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="创建定时任务">
          <IconButton
            size="small"
            onClick={() => setCreateOpen(true)}
            aria-label="创建定时任务"
          >
            <ScheduleIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>

      <CreateTaskDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        message={message}
        agentId={agentId}
      />
    </Box>
  );
}
