import { useEffect, useRef, useState } from "react";
import {
  Box,
  IconButton,
  InputBase,
  Tooltip,
  Typography,
} from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import { useSessionsStore } from "@/stores/sessionsStore";
import { useSessionUiStore } from "@/stores/sessionUiStore";
import { MemoryBar } from "@/components/MemoryBar";
import { SessionQuickActions } from "@/components/session/SessionQuickActions";
import { ChatSearchBar } from "@/components/chat/ChatSearchBar";

/** 会话头部：当前任务名称（可编辑）/ 模型 / 记忆提示 / 消息数 / 会话快捷入口 */
export function ChatHeader() {
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const memoryLoaded = useSessionsStore((s) => s.memoryLoaded);
  const dismissMemoryBar = useSessionsStore((s) => s.dismissMemoryBar);
  const renameSession = useSessionsStore((s) => s.renameSession);
  // 搜索条展开时占据消息数的位置（参考图：标题右侧直接换成搜索框）
  const searchSessionId = useSessionUiStore((s) => s.searchSessionId);

  const session = sessions.find((s) => s.id === activeId);
  const showMemoryBar = memoryLoaded.injected && !memoryLoaded.dismissed;
  const searchOpen = searchSessionId !== null && searchSessionId === activeId;

  return (
    <Box
      sx={{
        px: 2,
        py: 1,
        borderBottom: "1px solid",
        borderColor: "divider",
        display: "flex",
        alignItems: "center",
        gap: 1,
      }}
    >
      {session && (
        <EditableSessionTitle
          title={session.title}
          onRename={(title) => renameSession(session.id, title)}
        />
      )}
      <Box sx={{ flex: 1 }} />
      {showMemoryBar && (
        <MemoryBar count={memoryLoaded.count} onDismiss={dismissMemoryBar} />
      )}
      {searchOpen ? (
        <ChatSearchBar />
      ) : (
        <Typography
          sx={{ fontSize: 12, color: "text.secondary", flexShrink: 0 }}
        >
          共 {session?.messages.length ?? 0} 条消息
        </Typography>
      )}
      {session && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
          <SessionQuickActions sessionId={session.id} size="md" />
        </Box>
      )}
    </Box>
  );
}

interface EditableSessionTitleProps {
  /** 当前会话（任务）标题 */
  title: string;
  /** 重命名回调（参数为 trim 后的非空标题） */
  onRename: (title: string) => void;
}

/**
 * 头部任务标题：单行省略展示，显示不全时 hover 弹出完整标题；
 * 点击右侧笔形图标进入行内编辑，Enter / 失焦确认，Esc 取消。
 */
function EditableSessionTitle({ title, onRename }: EditableSessionTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  /** 标题是否被省略截断（决定是否启用 Tooltip） */
  const [truncated, setTruncated] = useState(false);
  const textRef = useRef<HTMLElement | null>(null);
  /** 防止 Enter 确认后失焦再次触发提交 */
  const committedRef = useRef(false);

  // 测量标题是否截断；标题变化 / 窗口尺寸变化时重新测量
  useEffect(() => {
    const measure = () => {
      const el = textRef.current;
      if (el) setTruncated(el.scrollWidth > el.clientWidth);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [title, editing]);

  /** 进入编辑态：重置草稿与提交标记 */
  const startEdit = () => {
    committedRef.current = false;
    setDraft(title);
    setEditing(true);
  };

  /** 提交重命名：空标题忽略，未变化不调用回调 */
  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) onRename(next);
  };

  if (editing) {
    return (
      <InputBase
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        inputProps={{ maxLength: 50, "aria-label": "任务名称" }}
        sx={{ fontWeight: 600, minWidth: 120, maxWidth: 360 }}
      />
    );
  }

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
      <Tooltip title={title} disableHoverListener={!truncated}>
        <Typography
          ref={textRef}
          fontWeight={600}
          noWrap
          sx={{ maxWidth: 360 }}
        >
          {title}
        </Typography>
      </Tooltip>
      <Tooltip title="重命名">
        <IconButton size="small" onClick={startEdit} sx={{ p: 0.25 }}>
          <EditIcon sx={{ fontSize: 14, color: "text.secondary" }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
