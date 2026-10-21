/**
 * IM 会话的**待裁决审批**（助理视图那张审批卡的数据源）。
 *
 * ## 为什么是独立的一条通道（而不是复用任务视图那套）
 *
 * 任务视图的审批来自 SSE（`/v1/chat` 的 `approval_request` 事件），走
 * `sessionsStore.pendingApprovals` → `runtime.respondApproval` →
 * serve 进程的 `POST /v1/tool-approvals/{id}`。
 *
 * IM 会话的审批**跑在 gateway 进程**，注册表是另一张表：
 *
 * - 轮次登记只覆盖「桌面端自己发起的轮次」。`turn_progress.begin()` 只由
 *   `/v1/turn` 调用，而「用户在飞书里让智能体建文件」是渠道入站触发的——
 *   桌面端是旁观者，那一轮根本没登记。**这就是为什么进度通道里看不到它**。
 * - 审批的生命周期独立于轮次：它挂在「某个工具调用正等着裁决」这件事上，
 *   不是一个事件流里的第 N 条。
 * - 裁决端点也必须落在 gateway 进程：两进程各有一张 `PENDING_APPROVALS`，
 *   打到 serve 进程只会 409，而用户看到的是「点了允许，什么都没发生」。
 *
 * 因此这里走独立的**会话快照**通道（无游标、全量）：每次拿到的都是当前
 * 挂着的全部待裁决请求。
 *
 * ## 「先到先得」是刻意的
 *
 * 飞书侧文本裁决与桌面端裁决指向**同一个挂起的 future**。谁先裁决，另一边
 * 拿到的都是「已处理 / 已过期 / 不属于该会话」。允许两边都生效，等于把
 * 一次放行算成两次。
 *
 * ## 轮询节奏
 *
 * 审批是「有人在等你拍板」的高优先信号，比 4 秒一次的会话刷新快得多。
 * 1 秒一轮：本地回环、几百字节，用户感知不到延迟。
 */
import { create } from 'zustand';
import { platform } from '@/platform';
import type { ApprovalDecision } from '@/types';
import type { ChannelApproval } from '@/platform/types';
import { toast } from '@/components/Toast';

/** 轮询间隔（毫秒）：比会话刷新的 4 秒快，因为审批在等人 */
const POLL_INTERVAL_MS = 1000;

/**
 * 连续失败上限：网关不可达时不要一直重试。
 *
 * 8 次 ≈ 8 秒——单次 IPC / TCP 抖动不该让审批卡消失，但网关真挂了也没必要空转。
 */
const MAX_FAILURES = 8;

/** 一个被观察的 IM 会话 */
interface Watcher {
  /** 运行时渠道名（session key 冒号前段，如 `feishu.feishu`） */
  channel: string;
  /** IM 会话 id（session key 冒号后段，如飞书 open_id） */
  chatId: string;
  /** 连续失败次数 */
  failures: number;
  /** 上一轮请求是否还在路上：避免慢网络下同一会话并发多请求 */
  busy: boolean;
  timer: ReturnType<typeof setInterval>;
}

/** 观察者登记表（模块级，按会话唯一） */
const watchers = new Map<string, Watcher>();

interface ChannelApprovalsState {
  /** 会话 id → 该会话当前挂着的待裁决请求（按注册顺序） */
  bySession: Record<string, ChannelApproval[]>;

  /** 开始观察某个 IM 会话的待裁决审批 */
  startWatching: (sessionId: string, channel: string, chatId: string) => void;
  /** 停止观察某个 IM 会话 */
  stopWatching: (sessionId: string) => void;
  /** 裁决一条待裁决请求（乐观出队；真值由下一轮轮询带回） */
  resolve: (
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
  ) => Promise<void>;
}

export const useChannelApprovalsStore = create<ChannelApprovalsState>()((set) => ({
  bySession: {},

  startWatching: (sessionId, channel, chatId) => {
    // 同一会话已在观察：换目标就换配置，不开第二份计时器
    const existing = watchers.get(sessionId);
    if (existing) {
      existing.channel = channel;
      existing.chatId = chatId;
      return;
    }
    const watcher: Watcher = {
      channel,
      chatId,
      failures: 0,
      busy: false,
      timer: setInterval(() => void poll(sessionId), POLL_INTERVAL_MS),
    };
    watchers.set(sessionId, watcher);
    // 立刻取一次：切回一个已有挂起的会话时，卡片应当**马上**出现，
    // 而不是先空 1 秒再冒出来。
    void poll(sessionId);
  },

  stopWatching: (sessionId) => {
    const watcher = watchers.get(sessionId);
    if (!watcher) return;
    clearInterval(watcher.timer);
    watchers.delete(sessionId);
  },

  resolve: async (sessionId, requestId, decision, reason) => {
    const watcher = watchers.get(sessionId);
    if (!watcher) {
      toast.error('该会话的审批通道已关闭，无法裁决');
      return;
    }
    // 裁决只能生效一次，先出队避免重复点击发两次请求。
    // 真值由下一轮轮询带回（失败时这张卡会重新出现——引擎那边其实没放行）。
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: (s.bySession[sessionId] ?? []).filter((a) => a.id !== requestId),
      },
    }));
    const result = await platform.resolveChannelApproval({
      channel: watcher.channel,
      chatId: watcher.chatId,
      requestId,
      decision,
      reason,
    });
    if (!result.ok) {
      // 409 = 已被裁决 / 已过期 / 不属于该会话。这三种情况下一轮轮询都不会
      // 再把它带回来（它已经不在引擎的注册表里了），所以不必恢复卡片。
      toast.error(result.error ?? '审批裁决失败');
    }
  },
}));

/** 拉一次某个会话的待裁决快照并写入 store */
async function poll(sessionId: string): Promise<void> {
  const watcher = watchers.get(sessionId);
  if (!watcher || watcher.busy) return;
  watcher.busy = true;
  try {
    const result = await platform.getChannelApprovals({
      channel: watcher.channel,
      chatId: watcher.chatId,
    });
    // 期间可能被换掉（切了会话）：旧请求的结果必须整份丢弃
    if (watchers.get(sessionId) !== watcher) return;

    if (result.unsupported) {
      // 外部托管的老网关不认这个端点：停止观察，别每秒钟失败一次。
      // IM 侧（飞书）仍有审批卡，流程不会断。
      useChannelApprovalsStore.getState().stopWatching(sessionId);
      return;
    }
    if (!result.ok) {
      watcher.failures += 1;
      if (watcher.failures >= MAX_FAILURES) {
        useChannelApprovalsStore.getState().stopWatching(sessionId);
      }
      return;
    }
    watcher.failures = 0;
    useChannelApprovalsStore.setState((s) => ({
      bySession: { ...s.bySession, [sessionId]: result.approvals },
    }));
  } catch {
    // 抛出（IPC 层异常）按一次失败计：不弹 toast，用户看得见的是「卡没出现」，
    // 而真正的失败信号由会话轮询给出，重复提示只会更吵。
    watcher.failures += 1;
    if (watcher.failures >= MAX_FAILURES) {
      useChannelApprovalsStore.getState().stopWatching(sessionId);
    }
  } finally {
    watcher.busy = false;
  }
}

/** 仅供测试：清掉所有观察者（模块级状态在用例之间必须归零） */
export function resetChannelApprovalWatchersForTest(): void {
  for (const watcher of watchers.values()) {
    clearInterval(watcher.timer);
  }
  watchers.clear();
  useChannelApprovalsStore.setState({ bySession: {} });
}
