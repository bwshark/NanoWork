import { Fragment, useMemo, useState } from 'react';
import {
  Box,
  Button,
  IconButton,
  Paper,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useSessionsStore } from '@/stores/sessionsStore';
import { AttachmentBar } from '@/components/composer/AttachmentBar';
import { InlineAttachmentChip } from '@/components/composer/InlineAttachmentChip';
import {
  splitRichContent,
  ATT_TOKEN_OPEN,
  ATT_TOKEN_CLOSE,
} from '@/lib/editableText';
import { writeRichClipboard } from '@/lib/richClipboard';
import { toast } from '@/components/Toast';
import type { Message } from '@/types';

interface UserMessageProps {
  message: Message;
  /** 消息所属会话 id：编辑重发时用于定位 store 中的会话与消息 */
  sessionId: string;
}

/** 本地 HH:MM（如 18:52）—— 把发送时间戳按本机时区格式化为「紧贴图标左侧」的紧凑时间 */
const TIME_FMT: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};

/**
 * 用户消息气泡（右侧）。
 * - hover 时在气泡下方显示：发送时间 + 编辑 + 复制；
 * - 点击编辑进入编辑态（气泡变为可写 TextField + 「重新开始对话」提示 + 取消/发送）；
 * - 点击发送触发 resendFromMessage，清空该消息之后的内容并发起新一轮助手流式。
 */
export function UserMessage({ message, sessionId }: UserMessageProps) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);

  const resendFromMessage = useSessionsStore((s) => s.resendFromMessage);

  // —— 富文本内联混排：richContent 存在且含徽章 token 时，气泡按输入时的原始位置渲染徽章 ——
  const richSegments = useMemo(
    () => (message.richContent ? splitRichContent(message.richContent) : null),
    [message.richContent],
  );
  const attById = useMemo(
    () => new Map((message.attachments ?? []).map((a) => [a.id, a])),
    [message.attachments],
  );
  const hasInlineChips =
    !!richSegments && richSegments.some((s) => s.type === 'att');
  /** 未被 richContent 引用的附件（旧数据兜底）：仍走底部预览条 */
  const unreferenced = useMemo(() => {
    if (!hasInlineChips || !richSegments) return message.attachments ?? [];
    const referenced = new Set(
      richSegments
        .filter((s): s is { type: 'att'; id: string } => s.type === 'att')
        .map((s) => s.id),
    );
    return (message.attachments ?? []).filter((a) => !referenced.has(a.id));
  }, [hasInlineChips, richSegments, message.attachments]);

  const timeText = new Date(message.createdAt).toLocaleTimeString([], TIME_FMT);

  const enterEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(message.content);
  };

  const submitEdit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      toast.error('消息内容不能为空');
      return;
    }
    if (trimmed !== message.content) {
      // 内容有变化：从该消息处重新发起流式；store 内部负责截断后续消息 + 追加助手占位
      void resendFromMessage(sessionId, message.id, trimmed);
    }
    setEditing(false);
  };

  /**
   * 复制用户消息到剪贴板。复用输入框的富复制链路 `writeRichClipboard`
   * （三段降级：ClipboardItem 富复制 → writeText + 应用层缓存 → execCommand 兜底），
   * 任一成功即提示，全部失败才报 `复制失败：<原因>`。
   */
  const handleCopy = async () => {
    const text = message.content;
    const rich =
      message.richContent ??
      message.content +
        (message.attachments ?? [])
          .map((a) => `${ATT_TOKEN_OPEN}${a.id}${ATT_TOKEN_CLOSE}`)
          .join('');
    const payload = JSON.stringify({
      rich,
      attachments: message.attachments ?? [],
    });
    const hasAttachment = (message.attachments ?? []).length > 0;
    /** 复制成功提示：带附件时强调「本应用内粘贴可还原附件」 */
    const successToast = () =>
      toast.success(
        hasAttachment ? '已复制（在本应用内粘贴可还原附件）' : '已复制',
      );

    try {
      const ok = await writeRichClipboard(text, payload, hasAttachment);
      if (!ok) throw new Error('浏览器剪贴板 API 全部不可用');
      setCopied(true);
      successToast();
      // 1.5s 后还原复制图标
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      toast.error(`复制失败：${reason}`);
    }
  };

  // hover 仅在非编辑态展示操作行；编辑时该区域被「提示 + 按钮」替代，避免视觉冗余
  const actionSx = {
    opacity: !editing && hovered ? 1 : 0,
    transition: 'opacity .15s',
    pointerEvents: !editing && hovered ? ('auto' as const) : ('none' as const),
  };

  return (
    <Box
      sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1.5 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 0.5,
          maxWidth: '75%',
        }}
      >
        {editing ? (
          // —— 编辑态：可写气泡 + 重新开始对话的提示 + 取消/发送 ——
          <>
            <Paper
              elevation={0}
              sx={{
                width: '100%',
                px: 1.5,
                py: 1,
                // 用户气泡改为黑/灰风格，深色主题深灰底+白字，浅色主题中灰底+深灰字
                bgcolor: (theme) =>
                  theme.palette.mode === 'dark' ? '#2a2d35' : '#e2e8f0',
                color: (theme) =>
                  theme.palette.mode === 'dark' ? '#ffffff' : '#1f2430',
                borderRadius: '12px 12px 2px 12px',
              }}
            >
              <TextField
                multiline
                fullWidth
                autoFocus
                variant="standard"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Esc 取消 / Ctrl+Enter 提交（Enter 仍按换行，方便多行编辑）
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    submitEdit();
                  }
                }}
                InputProps={{
                  disableUnderline: true,
                  sx: {
                    fontSize: 14,
                    color: 'inherit',
                    '& .MuiInputBase-input': {
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      p: 0,
                      '&::placeholder': { color: 'inherit', opacity: 0.6 },
                    },
                  },
                }}
                placeholder="输入消息内容…"
              />
            </Paper>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 0.25,
                pt: 0.25,
              }}
            >
              <InfoOutlinedIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                编辑后将从此处重新开始对话，已有产物不会被删除
              </Typography>
              <Box sx={{ flex: 1 }} />
              <Button size="small" onClick={cancelEdit} sx={{ minWidth: 64 }}>
                取消
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={submitEdit}
                disabled={!draft.trim()}
                sx={{ minWidth: 72 }}
              >
                发送
              </Button>
            </Box>
          </>
        ) : (
          // —— 展示态：气泡 + hover 出现「时间 / 编辑 / 复制」 ——
          <>
            <Paper
              elevation={0}
              sx={{
                px: 1.5,
                py: 1,
                // 用户气泡改为黑/灰风格，深色主题深灰底+白字，浅色主题中灰底+深灰字
                bgcolor: (theme) =>
                  theme.palette.mode === 'dark' ? '#2a2d35' : '#e2e8f0',
                color: (theme) =>
                  theme.palette.mode === 'dark' ? '#ffffff' : '#1f2430',
                borderRadius: '12px 12px 2px 12px',
              }}
            >
              {hasInlineChips ? (
                // 内联混排：徽章保持在输入时的原始位置（对齐参考应用）
                <Box
                  sx={{
                    whiteSpace: 'pre-wrap',
                    fontSize: 14,
                    wordBreak: 'break-word',
                    '& [data-att-id]': {
                      verticalAlign: 'middle',
                      margin: '0 3px',
                    },
                  }}
                >
                  {richSegments!.map((seg, i) =>
                    seg.type === 'text' ? (
                      <Fragment key={i}>{seg.text}</Fragment>
                    ) : attById.get(seg.id) ? (
                      <InlineAttachmentChip
                        key={`${seg.id}-${i}`}
                        attachment={attById.get(seg.id)!}
                        readonly
                        onPrimary
                      />
                    ) : null,
                  )}
                </Box>
              ) : (
                <Typography
                  sx={{ whiteSpace: 'pre-wrap', fontSize: 14, wordBreak: 'break-word' }}
                >
                  {message.content}
                </Typography>
              )}
              {/* 随消息上传的附件：只读展示（不传 onRemove 即无删除按钮）；
                  内联混排时仅兜底渲染未被 token 引用的附件 */}
              {(hasInlineChips ? unreferenced : message.attachments ?? [])
                .length > 0 && (
                <AttachmentBar
                  attachments={
                    hasInlineChips ? unreferenced : message.attachments ?? []
                  }
                  maxWidth={180}
                  inset
                />
              )}
            </Paper>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.25,
                ...actionSx,
              }}
            >
              <Typography
                sx={{
                  fontSize: 11,
                  color: 'text.secondary',
                  fontVariantNumeric: 'tabular-nums',
                  mr: 0.5,
                  userSelect: 'none',
                }}
              >
                {timeText}
              </Typography>
              <Tooltip title="编辑">
                <IconButton
                  size="small"
                  onClick={enterEdit}
                  aria-label="编辑消息"
                  sx={{ color: 'text.secondary' }}
                >
                  <EditIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title={copied ? '已复制' : '复制'}>
                <IconButton
                  size="small"
                  onClick={handleCopy}
                  aria-label="复制消息"
                  sx={{ color: 'text.secondary' }}
                >
                  {copied ? (
                    <CheckIcon sx={{ fontSize: 16 }} />
                  ) : (
                    <ContentCopyIcon sx={{ fontSize: 16 }} />
                  )}
                </IconButton>
              </Tooltip>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}
