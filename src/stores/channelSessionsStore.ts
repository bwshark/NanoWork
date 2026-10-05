import { create } from 'zustand';
import { platform } from '@/platform';
import { mapRecordsToMessages, toIso } from '@/lib/sessionImport';
import {
  CHANNEL_SESSION_ID_PREFIX,
  channelSessionKey,
  isExternalSession,
} from '@/lib/channelSession';
import { useSessionsStore } from './sessionsStore';
import type { NanobotChannelSessionDetail, NanobotChannelSessionSummary } from '@/platform/types';
import type { Session } from '@/types';

/** 轮询间隔（毫秒）：IM 新消息以秒级延迟出现在智能体侧 */
const POLL_INTERVAL_MS = 4000;

/** 轮询定时器句柄（模块级单例，避免重复启动） */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 已打开会话最近一次见到的 updatedAt（用于轮询时判断是否需要刷新详情） */
const seenUpdatedAt = new Map<string, string>();

interface ChannelSessionsState {
  /** nanobot 磁盘上的 IM 频道会话摘要列表（按更新时间倒序） */
  summaries: NanobotChannelSessionSummary[];
  /** 列表是否正在拉取 */
  loading: boolean;

  /** 拉取一次频道会话列表（并发安全，失败静默） */
  refresh: () => Promise<void>;
  /** 若当前激活的频道会话在磁盘上有更新，重新拉取详情替换（轮询内部调用） */
  refreshActiveIfChanged: (summaries: NanobotChannelSessionSummary[]) => Promise<void>;
  /** 打开（或刷新）某个频道会话：拉取完整历史并注入 sessionsStore 激活 */
  openSession: (summary: NanobotChannelSessionSummary) => Promise<void>;
  /** 启动列表轮询（含活跃频道会话的增量刷新） */
  startPolling: () => void;
  /** 停止轮询 */
  stopPolling: () => void;
}

/** 频道会话详情 → 本地 Session（只读展示用，channel 有值即被识别为频道会话） */
function detailToSession(detail: NanobotChannelSessionDetail): Session {
  return {
    id: CHANNEL_SESSION_ID_PREFIX + detail.key,
    agentId: '',
    channel: detail.channel,
    title: detail.title,
    messages: mapRecordsToMessages(detail.key, detail.messages),
    permissionLog: [],
    createdAt: toIso(detail.createdAt),
    updatedAt: toIso(detail.updatedAt),
  };
}

export const useChannelSessionsStore = create<ChannelSessionsState>()((set, get) => ({
  summaries: [],
  loading: false,

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const summaries = await platform.listNanobotChannelSessions();
      set({ summaries });
      // 当前激活的是频道会话且磁盘有更新 → 增量刷新详情，实现 IM 新消息实时上屏
      await get().refreshActiveIfChanged(summaries);
    } catch {
      /* 列表拉取失败静默：下次轮询重试 */
    } finally {
      set({ loading: false });
    }
  },

  /** 若当前激活会话为频道会话且其 updatedAt 变化，重新拉取详情并替换 */
  refreshActiveIfChanged: async (summaries: NanobotChannelSessionSummary[]) => {
    const { activeId, sessions } = useSessionsStore.getState();
    const active = sessions.find((s) => s.id === activeId);
    if (!isExternalSession(active) || !active) return;
    const key = channelSessionKey(active.id);
    if (!key) return;
    const summary = summaries.find((s) => s.key === key);
    if (!summary) return;
    if (seenUpdatedAt.get(key) === summary.updatedAt) return;
    const detail = await platform.getNanobotChannelSession(key);
    if (!detail) return; // 详情拉取失败不记录，下次轮询重试
    seenUpdatedAt.set(key, summary.updatedAt);
    useSessionsStore.getState().openExternal(detailToSession(detail));
  },

  openSession: async (summary) => {
    const detail = await platform.getNanobotChannelSession(summary.key);
    if (!detail) return; // 详情拉取失败不记录，与 refreshActiveIfChanged 一致，下次轮询重试
    seenUpdatedAt.set(summary.key, summary.updatedAt);
    useSessionsStore.getState().openExternal(detailToSession(detail));
  },

  startPolling: () => {
    if (pollTimer) return;
    void get().refresh();
    pollTimer = setInterval(() => void get().refresh(), POLL_INTERVAL_MS);
  },

  stopPolling: () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  },
}));
