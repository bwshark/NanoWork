/**
 * 助理视图（IM 会话）的逐条批准卡片。
 *
 * ## 与任务视图那张卡片的关系
 *
 * 视觉与交互**完全一致**（共用 `ApprovalCardBody`），但数据源与裁决落点不同：
 *
 * | | 任务视图 | 助理视图（IM 会话） |
 * |---|---|---|
 * | 数据来源 | SSE `approval_request` 事件 | 轮询 gateway `GET /v1/approvals` |
 * | 引擎进程 | serve | **gateway** |
 * | 裁决端点 | `POST /v1/tool-approvals/{id}` | `POST /v1/approvals/resolve` |
 *
 * 裁决端点不能混用：两进程各有一张 `PENDING_APPROVALS`，打错进程只会拿到
 * 409，而用户看到的是「点了允许，什么都没发生」。
 *
 * ## 为什么这张卡必须独立轮询（而不是等会话刷新）
 *
 * 「用户在飞书里让智能体建文件」这个轮次是**渠道入站**触发的，桌面端是
 * 旁观者：既没有 `/v1/turn` 的轮次登记（进度通道里根本没有这一轮），
 * 审批挂起时磁盘上也没有任何落盘。4 秒一次的会话刷新看不到它。
 *
 * 所以这里自己轮询**会话级审批快照**（无游标、全量语义）。
 */
import { useEffect } from 'react';
import { ApprovalCardBody } from '@/components/ApprovalCard';
import { useChannelApprovalsStore } from '@/stores/channelApprovalsStore';
import { channelChatId } from '@/lib/channel/channelSession';
import type { ApprovalDecision } from '@/types';

/**
 * 助理视图的审批卡。
 *
 * @param sessionId 本地会话 id（`nb:{channel}:{chatId}`）
 * @param channel 运行时渠道名（session key 冒号前段，如 `feishu.feishu`）
 */
export function ChannelApprovalCard({
  sessionId,
  channel,
}: {
  sessionId: string;
  channel: string;
}) {
  const approvals = useChannelApprovalsStore((s) => s.bySession[sessionId]);
  const startWatching = useChannelApprovalsStore((s) => s.startWatching);
  const stopWatching = useChannelApprovalsStore((s) => s.stopWatching);
  const resolve = useChannelApprovalsStore((s) => s.resolve);

  // 观察这个会话的待裁决审批。切走时停掉观察：否则会给每个点过的会话留一个
  // 永久计时器（每秒钟打一次网关）。
  //
  // `chatId` 从会话 id 还原而不是从 props 传：会话 id 已经是
  // `nb:{channel}:{chatId}`，拆它比再存一份更不容易走偏。
  useEffect(() => {
    const chatId = channelChatId(sessionId);
    if (!chatId) return;
    startWatching(sessionId, channel, chatId);
    return () => stopWatching(sessionId);
  }, [sessionId, channel, startWatching, stopWatching]);

  const pending = approvals?.[0];
  if (!pending) return null;

  const resolveApproval = (decision: ApprovalDecision, reason?: string) =>
    resolve(sessionId, pending.id, decision, reason);

  return (
    <ApprovalCardBody
      // 换请求即卸载重挂：拒绝原因输入框、参数展开态都天然归零。
      // 与任务视图那张卡片用同一条规则（见 ApprovalCard 的注释）。
      key={pending.id}
      pending={{ id: pending.id, tool: pending.tool, args: pending.args }}
      queued={approvals.length}
      resolveApproval={resolveApproval}
    />
  );
}
