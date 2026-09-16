import {
  __resetRecordersForTest,
  __setEventStoreForTest,
  createMemoryEventStore,
  type EventStore,
} from '@/events';
import { __resetHydrationForTest, __resetSedimentForTest } from '@/stores/sessionsStore';

/**
 * 让事件流在测试里落到**内存实现**，并清空记录器与写队列。
 *
 * 会话数据现在只走事件流（D2 Phase C/D/E），所以：
 * - 用到 `useSessionsStore` 的用例都应在初始化时调用一次，否则事件会写进
 *   jsdom 的 localStorage，在上一个用例的残留上做断言；
 * - 记录器持有 `seq` 与链尖，跨用例不清空会导致「新会话第一条事件 seq 不是 1」；
 * - 水合标记（`hydratedSessions`）是模块级状态，不随 `setState` 归零，
 *   跨用例复用同一会话 id 时必须一并清空，否则 `send` 会跳过水合、
 *   记录器缺失（表现为「事件记录器未就绪」的告警噪音）。
 * - 自动沉淀去重集（`sedimentedSessions`）同理：它是**模块级**的，
 *   不清空会让下一个用例里「同名会话」的沉淀被静默跳过。
 *
 * @returns 本次用例使用的事件存储（可直接 `append` 预置历史）
 */
export function resetEventStream(): EventStore {
  __resetRecordersForTest();
  __resetHydrationForTest();
  __resetSedimentForTest();
  const store = createMemoryEventStore();
  __setEventStoreForTest(store);
  return store;
}
