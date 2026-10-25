/**
 * 助理视图的**实时过程**：轮询引擎的 `/v1/turn/progress` 并合流到占位助手消息。
 *
 * ## 为什么需要轮询（而不是继续等 4 秒的会话轮询）
 *
 * IM 会话的真值在引擎磁盘上，桌面端靠 4 秒轮询 `openExternal` 重建会话——但引擎
 * 只在**轮次结束 / 分段完成**时落盘，整轮期间磁盘上什么都没有，界面于是整段空白。
 * 任务视图没有这个问题：它走 `/v1/chat` 的 SSE，进度是逐帧推过来的。
 *
 * 引擎侧为此把同一份 `on_progress` 另存了一份内存快照（`gateway/turn_progress.py`），
 * 这里按 `since` 游标增量取回，逐条喂给 store —— 渲染层因此与任务视图**共用同一套**
 * 消息形态（`message.process` + `streams[sessionId].status`），不新增视觉分支。
 *
 * ## 三种收尾（都不是「正常完成」）
 *
 * - `unsupported`：外部托管的老网关没有这个端点 → 立刻退回旧行为（摘掉占位消息），
 *   绝不每 600ms 失败一次；
 * - `known=false` 超过宽限期：引擎始终没登记这一轮（消息被丢 / 网关刚重启）→ 摘掉；
 * - 连续多次请求失败：网关不可达 → 摘掉（真记录之后仍会经 4 秒轮询出现）。
 *
 * ## 为什么不放在组件里 useEffect
 *
 * 这一轮的进度与「用户当前看哪一页」无关：切到别的页面再回来，过程时间线仍应完整。
 * 计时器挂在模块级 `Map` 上，按会话唯一，切页不重开、也不并发多份。
 */
import { platform } from '@/platform';
import { useChannelSessionsStore } from '@/stores/channelSessionsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { setChannelTurnWatching } from '@/lib/channel/channelTurnLiveState';

/** 轮询间隔：要「看得见在动」但不能把主进程打满（一次请求只有几百字节） */
const POLL_INTERVAL_MS = 600;
/** 引擎登记宽限：`/v1/turn` 已受理但快照还没建（或这一轮被丢弃）时的等待上限 */
const UNKNOWN_GRACE_MS = 10_000;
/** 单轮最长观察时长：兜底防泄漏（引擎自身也有超时，正常走不到这里） */
const MAX_TURN_MS = 30 * 60_000;
/** 收尾后保留占位消息的时长：等 4 秒轮询把真实记录换上来 */
const KEEP_AFTER_FINISH_MS = 8_000;
/**
 * 连续失败上限：网关不可达时不要一直重试。
 * 8 次 ≈ 5 秒——单次 IPC / TCP 抖动不该让实时过程消失，但网关真挂了也没必要空转。
 */
const MAX_FAILURES = 8;

interface ChannelTurnWatch {
  messageId: string;
  channel: string;
  chatId: string;
  since: number;
  failures: number;
  startedAt: number;
  /** 引擎尚未登记该轮时的时间戳（null = 已登记） */
  unknownSince: number | null;
  /** 上一轮请求是否还在路上：避免慢网络下同一会话并发多请求、事件重复合流 */
  busy: boolean;
  timer: ReturnType<typeof setInterval>;
}

const watches = new Map<string, ChannelTurnWatch>();

/**
 * 开始观察某一轮（`runChannelTurn` 受理后调用）。
 *
 * 占位消息**在这一刻创建**（不是发送前）：发送失败时不会有这条消息需要撤回，
 * 而占位消息的 `createdAt` 正好是「已处理 Ns」的计时起点。
 */
export function watchChannelTurn(params: {
  sessionId: string;
  channel: string;
  chatId: string;
}): void {
  const { sessionId, channel, chatId } = params;
  // 同一会话上一条还没收尾的观察（极少见：上一轮的收尾兜底还没触发）
  stopChannelTurnWatch(sessionId, { drop: true });

  const messageId = useSessionsStore.getState().startChannelTurnLive(sessionId);
  // 登记「本会话正在实时观察」：4 秒的磁盘轮询据此跳过整份替换，
  // 否则引擎开工时那次落盘就会把占位消息冲掉（见 channelTurnLiveState 的头注释）。
  setChannelTurnWatching(sessionId, true);
  const watch: ChannelTurnWatch = {
    messageId,
    channel,
    chatId,
    since: 0,
    failures: 0,
    startedAt: Date.now(),
    unknownSince: null,
    busy: false,
    timer: setInterval(() => void poll(sessionId), POLL_INTERVAL_MS),
  };
  watches.set(sessionId, watch);
  // 立刻取一次：引擎可能在 POST 返回前就已经吐出整段思考
  void poll(sessionId);
}

/** 停止观察（`drop` 同时摘掉占位消息） */
export function stopChannelTurnWatch(sessionId: string, options?: { drop?: boolean }): void {
  const watch = watches.get(sessionId);
  if (!watch) return;
  clearInterval(watch.timer);
  watches.delete(sessionId);
  setChannelTurnWatching(sessionId, false);
  useSessionsStore
    .getState()
    .settleChannelTurnLive(sessionId, watch.messageId, { drop: options?.drop === true });
}

async function poll(sessionId: string): Promise<void> {
  const watch = watches.get(sessionId);
  if (!watch || watch.busy) return;
  watch.busy = true;
  try {
    const progress = await platform.getChannelTurnProgress({
      channel: watch.channel,
      chatId: watch.chatId,
      since: watch.since,
    });
    // 期间可能被新的一轮顶掉（用户连发两条）：旧请求的结果必须整份丢弃
    if (watches.get(sessionId) !== watch) return;

    // 占位消息已被真实记录替换（轮询重建会话）→ 没有什么可合流的了
    if (!hasLiveMessage(sessionId, watch.messageId)) {
      clearInterval(watch.timer);
      watches.delete(sessionId);
      setChannelTurnWatching(sessionId, false);
      return;
    }

    if (progress.unsupported) {
      finish(sessionId, watch, { drop: true });
      return;
    }
    if (!progress.ok) {
      watch.failures += 1;
      if (watch.failures >= MAX_FAILURES) finish(sessionId, watch, { drop: true });
      return;
    }
    watch.failures = 0;

    if (!progress.known) {
      watch.unknownSince ??= Date.now();
      if (Date.now() - watch.unknownSince > UNKNOWN_GRACE_MS) {
        finish(sessionId, watch, { drop: true });
      }
      return;
    }
    watch.unknownSince = null;

    for (const event of progress.events) {
      useSessionsStore.getState().applyChannelTurnLiveEvent(sessionId, watch.messageId, event);
    }
    // 游标以**服务端 seq** 为准（不是「本地最大事件 seq」）：客户端一次取回多条时
    // 两者相同；服务端因缓冲裁剪丢过事件时，只有前者能保证不重复取。
    watch.since = Math.max(watch.since, progress.seq);

    if (!progress.active) {
      finish(sessionId, watch, { drop: false });
      return;
    }
    if (Date.now() - watch.startedAt > MAX_TURN_MS) {
      finish(sessionId, watch, { drop: false, interrupted: true });
    }
  } catch {
    // 抛出（IPC 层异常）按一次失败计：不弹 toast，用户看得见的是「过程停住了」，
    // 而真正的失败信号由会话轮询 / 发送链路给出，重复提示只会更吵。
    watch.failures += 1;
    if (watch.failures >= MAX_FAILURES) finish(sessionId, watch, { drop: true });
  } finally {
    watch.busy = false;
  }
}

function finish(
  sessionId: string,
  watch: ChannelTurnWatch,
  options: { drop: boolean; interrupted?: boolean },
): void {
  clearInterval(watch.timer);
  watches.delete(sessionId);
  // 先解除抑制再收尾：真实记录要能立刻接管（`refresh` 内部会读这个登记表）
  setChannelTurnWatching(sessionId, false);
  useSessionsStore
    .getState()
    .settleChannelTurnLive(sessionId, watch.messageId, options);
  if (options.drop) return;

  // 引擎刚结束 → 立刻拉一次真实记录替换占位消息，别让用户白等满 4 秒。
  // 注意这是**尽力而为**：`refresh` 有自己的并发短路，失败时下一个周期会补上。
  void useChannelSessionsStore.getState().refresh();

  // 兜底：真实记录迟迟没到（该会话的 updatedAt 没变等）就摘掉占位消息。
  // 留一条「只有过程、没有回答」的助手气泡，比空着更容易被读成「回答丢了」。
  setTimeout(() => {
    if (hasLiveMessage(sessionId, watch.messageId)) {
      useSessionsStore
        .getState()
        .settleChannelTurnLive(sessionId, watch.messageId, { drop: true });
    }
  }, KEEP_AFTER_FINISH_MS);
}

function hasLiveMessage(sessionId: string, messageId: string): boolean {
  return (
    useSessionsStore
      .getState()
      .sessions.find((session) => session.id === sessionId)
      ?.messages.some((message) => message.id === messageId) ?? false
  );
}

/** 仅供测试：清掉所有观察（模块级状态在用例之间必须归零） */
export function resetChannelTurnWatchesForTest(): void {
  for (const [sessionId, watch] of watches) {
    clearInterval(watch.timer);
    watches.delete(sessionId);
    setChannelTurnWatching(sessionId, false);
  }
}
