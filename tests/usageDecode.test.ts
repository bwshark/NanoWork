/**
 * 用量域解码：首字延迟字段（FR-11.7）。
 *
 * **背景澄清**：B4 计划里把「补 `ttftMs` / `stream`」写成 wire → 类型 → 落库
 * **三处同改**。实测后只有一处——引擎侧 `llm_usage/store.py` 的 `_AGGREGATE_SQL`
 * 早就聚合了 `ttft_ms` / `timed_requests`，`_as_int_row` 又把它们全量映射进
 * `days`（含 `sources`）与 `providers_30d`；**缺的只是客户端把它读出来**。
 * 所以这里钉的是「读得出来、脏值收敛得住」，而不是「抄一份聚合口径」。
 *
 * 收敛方向必须朝「未测到」：报一个偏小的假数字比报「—」危险得多，
 * 因为没人会去怀疑一个更好看的数字。
 */

import { describe, expect, it } from 'vitest';
import { decodeUsagePayload } from '@/ai/runtime/nanobotHttp/usage';

describe('decodeUsagePayload：首字延迟（FR-11.7）', () => {
  it('days 与 providers_30d 两侧都解出 ttft_ms / timed_requests', () => {
    const stats = decodeUsagePayload({
      days: [
        {
          date: '2026-10-16',
          ttft_ms: 4800,
          timed_requests: 3,
          sources: { user: { ttft_ms: 4800, timed_requests: 3 } },
        },
      ],
      providers_30d: [
        { provider: 'sciherd', model: 'Qwen3.8-Flash', ttft_ms: 4800, timed_requests: 3 },
      ],
    });

    expect(stats.days[0].ttftMs).toBe(4800);
    expect(stats.days[0].timedRequests).toBe(3);
    expect(stats.days[0].bySource.user.ttftMs).toBe(4800);
    expect(stats.days[0].bySource.user.timedRequests).toBe(3);
    expect(stats.providers[0].ttftMs).toBe(4800);
    expect(stats.providers[0].timedRequests).toBe(3);
  });

  it('引擎没给这两个字段时收敛为 0（＝未测到），不是 NaN / undefined', () => {
    // 老版本网关 / 只跑过非流式请求时就是这个形态。收敛到 0 之后，
    // `formatTtft` 会把 `timedRequests === 0` 判成「—」而不是「0 ms」。
    const stats = decodeUsagePayload({ days: [{ date: '2026-10-16' }] });
    expect(stats.days[0].ttftMs).toBe(0);
    expect(stats.days[0].timedRequests).toBe(0);
  });

  it('脏值（负数 / 字符串 / 非有限数）一律收敛为 0', () => {
    const stats = decodeUsagePayload({
      days: [{ date: '2026-10-16', ttft_ms: -5, timed_requests: 'x' }],
      providers_30d: [
        { provider: 'p', model: 'm', ttft_ms: Number.POSITIVE_INFINITY, timed_requests: 2.7 },
      ],
    });
    expect(stats.days[0].ttftMs).toBe(0);
    expect(stats.days[0].timedRequests).toBe(0);
    expect(stats.providers[0].ttftMs).toBe(0);
    // 2.7 → 截断到 2（不是四舍五入：请求数是计数，不能凭空多一个）
    expect(stats.providers[0].timedRequests).toBe(2);
  });
});
