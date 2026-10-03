/**
 * 记忆的**原子单位**：结构化事实的构造与校验。
 *
 * 需求：`docs/prd-memory-v2.md` FR-M1 / FR-M2；设计：`docs/architecture-memory-v2.md` §4.1。
 *
 * ## 本模块的硬约束（NFR-M1 / NFR-M12）
 *
 * **纯函数、无 platform、无 IO、不读时钟、不读 locale、不读随机数。** 所有时间来自
 * 调用方显式传入的 `now` 与 `observedAt`；所有集合在返回前排序。
 *
 * 为什么这么严：v2 的跨设备收敛依赖「同一份证据 → 逐字节相同的 canonical JSON」
 * （设计 §10）。一个读时钟的 `createMemoryFact` 会让同一份输入产出不同结果，
 * 于是「各自从证据重算」不再收敛。
 */

import type { EntryKey, FactKind, FactOrigin, FactSource, MemoryFact } from '@/types';
import { looksLikeSystemError } from '@/lib/memoryDetect';
import { compareStrings, normalizeForDedup } from '@/lib/memoryNormalize';
import { hashContent } from '@/lib/workspaceKey';

/** 事实正文的长度上限（校验用；超限则整条拒绝，不静默截断） */
export const FACT_CONTENT_MAX_CHARS = 2000;

/** 证据字段的长度上限 */
export const FACT_EVIDENCE_MAX_CHARS = 500;

/** `memory_key` 的形态：小写单词 + `.`/`_`/`-` 分隔符 */
export const MEMORY_KEY_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

/** `memory_key` 的长度上限 */
export const MEMORY_KEY_MAX_CHARS = 64;

/**
 * `observedAt` 允许超前 `now` 的容差（毫秒）。
 *
 * 为什么需要它：`observedAt` 是**替代比较的基准**（FR-M8 门槛③要求候选严格晚于
 * active 的 `lastSeen`），一个来自未来的时间戳会把该域永久锁死——此后所有正常候选
 * 都「不够新」。5 分钟足够吸收客户端与服务器的时钟漂移。
 */
export const FACT_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** 各类 kind 的缺省重要度（决定「不必重复出现也能晋升」，见 `DEFAULT_DISTILL_POLICY`） */
const DEFAULT_IMPORTANCE: Record<FactKind, number> = {
  decision: 4,
  convention: 4,
  pitfall: 4,
  // `outcome` 永不自动晋升（不在 promotableKinds 里），故缺省值偏低只是表达「当轮结果」
  outcome: 2,
};

/** 事实构造 / 校验失败的原因（可判定，便于测试与 UI 提示） */
export class MemoryFactError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'kind'
      | 'content-empty'
      | 'content-too-long'
      | 'content-system-error'
      | 'importance'
      | 'memory-key'
      | 'observed-at'
      | 'evidence-too-long'
      | 'workspace',
  ) {
    super(message);
    this.name = 'MemoryFactError';
  }
}

/** 是不是合法的 `FactKind` */
export function isFactKind(value: unknown): value is FactKind {
  return (
    value === 'decision' || value === 'convention' || value === 'pitfall' || value === 'outcome'
  );
}

/** 某个 kind 的缺省重要度 */
export function defaultImportanceFor(kind: FactKind): number {
  return DEFAULT_IMPORTANCE[kind];
}

/**
 * 事实 → 冲突域键（**唯一的键推导入口**，蒸馏按它分组）。
 *
 * 三个命名空间刻意分开，任何一个都不会与另一个互相替代：
 * - `k:` 显式 key（人会持续用同一个 key 表达同一个问题）；
 * - `d:` 派生键（无 key 时按 kind + 归一化内容；**只合并 evidence，不跨内容替代**——
 *   这正是「补充新信息」不被误当「更新」的保证）；
 * - `l:` v1 Markdown 段落（只读 legacy）；
 * - `x:` 域级墓碑（该域被用户删除）。
 *
 * `EntryKey` 是**内部键**（含 `:`），因此**不受 `MEMORY_KEY_RE` 约束**——那条正则管的是
 * 人/模型提供的 `memoryKey`。
 */
export function entryKeyForFact(fact: Pick<MemoryFact, 'kind' | 'content' | 'memoryKey'>): EntryKey {
  if (fact.memoryKey) return `k:${fact.memoryKey}` as EntryKey;
  return `d:${fact.kind}:${hashContent(normalizeForDedup(fact.content))}` as EntryKey;
}

/** 由 `entryKey` 反推「用于展示的 memoryKey 字符串」（`k:` 去掉前缀，其余原样） */
export function displayKeyOf(entryKey: EntryKey): string {
  return entryKey.startsWith('k:') ? entryKey.slice(2) : entryKey;
}

/** 构造事实的入参（`factId` / `schema` / `observedAt` 由函数补齐或规范化） */
export interface CreateFactInput {
  workspaceId: string;
  kind: FactKind;
  content: string;
  /** 缺省按 kind 推定（见 `defaultImportanceFor`） */
  importance?: number;
  memoryKey?: string;
  source?: FactSource;
  /**
   * 事实来源。**唯一的生产调用点**（`memoryEdit.ts` 的手编保存）显式传 `'manual'`，
   * 其余情况不该依赖缺省值——见下面 `createMemoryFact` 里缺省取 `'sediment'` 的理由。
   */
  origin?: FactOrigin;
  evidence?: string;
  /** Harness provenance（事件流 event id）。**调用方负责不把模型的提交透传进来** */
  sourceEventId?: string;
  /** 观测时刻；缺省取 `now` */
  observedAt?: string;
}

/** 校验并规范化一条事实；任何一项不合格即**整条拒绝**（不部分写入） */
export function createMemoryFact(input: CreateFactInput, now: Date): MemoryFact {
  const workspaceId = (input.workspaceId ?? '').trim();
  if (workspaceId === '') {
    throw new MemoryFactError('事实缺少工作区归属（workspaceId）', 'workspace');
  }

  if (!isFactKind(input.kind)) {
    throw new MemoryFactError(`非法事实类型：${String(input.kind)}`, 'kind');
  }

  const content = (input.content ?? '').trim();
  if (content === '') {
    throw new MemoryFactError('事实正文为空', 'content-empty');
  }
  if (content.length > FACT_CONTENT_MAX_CHARS) {
    throw new MemoryFactError(
      `事实正文超过 ${FACT_CONTENT_MAX_CHARS} 字（${content.length}）`,
      'content-too-long',
    );
  }
  // 系统报错不得成为长期记忆：网关会把错误原文当正常 content 吐进 SSE 流，
  // 通道层面分不出，只能在内容层拦（v1 的真实事故，见 `memoryDetect` 的文件头）。
  if (looksLikeSystemError(content)) {
    throw new MemoryFactError('正文像系统报错，不写入长期记忆', 'content-system-error');
  }

  const importance = input.importance ?? defaultImportanceFor(input.kind);
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new MemoryFactError(`重要度必须是 1–5 的整数，收到 ${String(input.importance)}`, 'importance');
  }

  let memoryKey: string | undefined;
  if (input.memoryKey !== undefined && input.memoryKey !== null && `${input.memoryKey}`.trim() !== '') {
    const key = `${input.memoryKey}`.trim();
    if (key.length > MEMORY_KEY_MAX_CHARS) {
      throw new MemoryFactError(
        `memory_key 超过 ${MEMORY_KEY_MAX_CHARS} 字（${key.length}）`,
        'memory-key',
      );
    }
    if (!MEMORY_KEY_RE.test(key)) {
      throw new MemoryFactError(
        `memory_key 形态非法（只允许小写字母、数字与 . _ -）：${key}`,
        'memory-key',
      );
    }
    memoryKey = key;
  }

  const observedAt = normalizeObservedAt(input.observedAt, now);

  const evidenceRaw = (input.evidence ?? '').trim();
  if (evidenceRaw.length > FACT_EVIDENCE_MAX_CHARS) {
    throw new MemoryFactError(
      `证据字段超过 ${FACT_EVIDENCE_MAX_CHARS} 字（${evidenceRaw.length}）`,
      'evidence-too-long',
    );
  }

  const fact: MemoryFact = {
    factId: '',
    workspaceId,
    kind: input.kind,
    content,
    importance,
    ...(memoryKey ? { memoryKey } : {}),
    source: input.source ?? 'user',
    // 缺省取 `'sediment'`（模型自动沉淀）而**不是** `'manual'`。
    //
    // `'manual'` 现在是一个**特权值**：蒸馏时豁免 `retentionDays` 年龄门槛
    // （见 `memoryDistill.ts` 的 `isAgeExempt`），因为它是用户显式写下的输入。
    // 让它当兜底就是 fail-open——任何忘记传 `origin` 的调用方都会静默拿到
    // 「绕过年龄门槛」的待遇。缺省值必须是**最弱**的那个来源。
    origin: input.origin ?? 'sediment',
    ...(evidenceRaw ? { evidence: evidenceRaw } : {}),
    ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
    observedAt,
    schema: 2,
  };
  return { ...fact, factId: factIdFor(fact) };
}

/**
 * 规范化 `observedAt`：缺省取 `now`，非法或**超前过多**一律拒绝。
 *
 * 超前检查的理由见 `FACT_CLOCK_SKEW_MS`。**落后不设限**：一条三年前的决策仍然是有效的
 * 证据（它恰恰是蒸馏最想要的输入）。
 */
export function normalizeObservedAt(
  observedAt: string | undefined,
  now: Date,
): string {
  const raw = (observedAt ?? '').trim();
  if (raw === '') return now.toISOString();
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new MemoryFactError(`observedAt 不是可解析的时间：${raw}`, 'observed-at');
  }
  if (ms - now.getTime() > FACT_CLOCK_SKEW_MS) {
    throw new MemoryFactError(
      `observedAt 超出现在过多（可能是时钟漂移）：${raw}`,
      'observed-at',
    );
  }
  return new Date(ms).toISOString();
}

/**
 * 事实的稳定 id：`f_<hash8>`。
 *
 * 用途有两个，都依赖「同值推出同 id」：
 * 1. **去重**：同一事实被重复写入（自动沉淀 + 模型主动写 + 例行重放）时按 id 命中；
 * 2. **证据引用**：`CuratedEntry.evidenceIds` 存的是它，重算时才能对上。
 *
 * ## `evidence` 必须参与哈希（一处真实的 bug）
 *
 * 最初这里只算 `content + observedAt`，于是「同一分钟里从两个不同来源确认同一件事」
 * （`evidence: 'a'` / `evidence: 'b'`）会得到**同一个 factId**，被当成同一条事实——
 * 而 FR-M8 的替代门槛恰恰要求「独立事实数 ≥ 2」。撞 id 的直接后果是**任何替代都凑不够
 * 独立证据**：门槛永远差一条，但报告里看不出为什么（只看到 `skipped`）。
 *
 * 加入 `evidence` 后，「一条事实」= 内容 + 时刻 + 来源，三者任一不同即是两条独立事实。
 * 代价是**同一时刻、同一内容、无 evidence 的两次调用仍会撞 id**——这是刻意的：
 * 那种输入本身不可区分，去重比重复入库好。
 *
 * ## 位宽
 *
 * `hashContent` 是 32 位 djb2、最多 **8** 个十六进制字符（见 `workspaceKey.ts`）——
 * **不是 16 位**。若将来要更宽的 id，做法是换一个哈希函数，而不是拼接两个 8 位
 * （那会破坏「同值同 id」）。
 *
 * ## 跨设备
 *
 * 事实日志是本机证据、**不参与同步**（设计 §10），因此「各设备各自推出的 id」不会
 * 互相碰撞；`evidenceIds` 只在同一台设备的证据集内解释。
 */
export function factIdFor(
  fact: Pick<
    MemoryFact,
    'workspaceId' | 'kind' | 'content' | 'memoryKey' | 'observedAt' | 'evidence'
  >,
): string {
  const material = [
    fact.workspaceId,
    fact.kind,
    fact.memoryKey ?? '',
    normalizeForDedup(fact.content),
    fact.observedAt,
    fact.evidence ?? '',
  ].join('\u0000');
  return `f_${hashContent(material)}`;
}

/**
 * 从一段 JSONL 行解析事实；解析失败或**归属不符**时返回 null。
 *
 * 归属校验不是可选的：`daily/*.jsonl` 的名字里带的是**本地日期**，而文件可能被拷到
 * 另一个工作区的目录下（用户手动搬、或者同步落地）。此时默默读入会把 A 项目的事实
 * 注入到 B 项目的会话里——这类串味比「没记忆」难排查得多。
 */
export function parseMemoryFactLine(line: string, expectedWorkspaceId: string): MemoryFact | null {
  const raw = (line ?? '').trim();
  if (raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  if (obj.schema !== 2) return null;
  if (!isFactKind(obj.kind)) return null;
  if (typeof obj.content !== 'string' || obj.content.trim() === '') return null;
  if (typeof obj.factId !== 'string' || obj.factId === '') return null;
  if (typeof obj.observedAt !== 'string' || !Number.isFinite(Date.parse(obj.observedAt))) return null;
  if (typeof obj.workspaceId !== 'string' || obj.workspaceId !== expectedWorkspaceId) return null;
  if (typeof obj.importance !== 'number' || !Number.isInteger(obj.importance)) return null;
  if (obj.importance < 1 || obj.importance > 5) return null;
  if (obj.memoryKey !== undefined && typeof obj.memoryKey !== 'string') return null;
  if (obj.evidence !== undefined && typeof obj.evidence !== 'string') return null;
  if (obj.sourceEventId !== undefined && typeof obj.sourceEventId !== 'string') return null;

  const source: FactSource =
    obj.source === 'agent' || obj.source === 'user' || obj.source === 'auto' || obj.source === 'remote'
      ? obj.source
      : 'user';
  const origin: FactOrigin =
    obj.origin === 'manual' ||
    obj.origin === 'memory-save' ||
    obj.origin === 'sediment' ||
    obj.origin === 'legacy' ||
    obj.origin === 'import' ||
    obj.origin === 'dream'
      ? obj.origin
      : 'manual';

  return {
    factId: obj.factId,
    workspaceId: obj.workspaceId,
    kind: obj.kind,
    content: obj.content,
    importance: obj.importance,
    ...(typeof obj.memoryKey === 'string' && obj.memoryKey !== '' ? { memoryKey: obj.memoryKey } : {}),
    source,
    origin,
    ...(typeof obj.evidence === 'string' && obj.evidence !== '' ? { evidence: obj.evidence } : {}),
    ...(typeof obj.sourceEventId === 'string' && obj.sourceEventId !== ''
      ? { sourceEventId: obj.sourceEventId }
      : {}),
    observedAt: new Date(Date.parse(obj.observedAt)).toISOString(),
    schema: 2,
  };
}

/** 事实序列化为一行 JSONL（字段顺序固定，保证同一事实产出同一行） */
export function serializeMemoryFact(fact: MemoryFact): string {
  // 手写字段顺序而不是 JSON.stringify(fact)：对象键序影响逐字节比较，
  // 而 v2 的跨设备收敛依赖「同一份证据 → 同一份文件」（设计 §4.3.1）。
  const parts: string[] = [
    `"schema":2`,
    `"factId":${JSON.stringify(fact.factId)}`,
    `"workspaceId":${JSON.stringify(fact.workspaceId)}`,
    `"kind":${JSON.stringify(fact.kind)}`,
    `"content":${JSON.stringify(fact.content)}`,
    `"importance":${fact.importance}`,
  ];
  if (fact.memoryKey) parts.push(`"memoryKey":${JSON.stringify(fact.memoryKey)}`);
  parts.push(`"source":${JSON.stringify(fact.source)}`);
  parts.push(`"origin":${JSON.stringify(fact.origin)}`);
  if (fact.evidence) parts.push(`"evidence":${JSON.stringify(fact.evidence)}`);
  if (fact.sourceEventId) parts.push(`"sourceEventId":${JSON.stringify(fact.sourceEventId)}`);
  parts.push(`"observedAt":${JSON.stringify(fact.observedAt)}`);
  return `{${parts.join(',')}}`;
}

/**
 * 事实去重键（同一「事实」的判据）。
 *
 * 与 `factIdFor` 的差别：`factId` 含 `observedAt`（同一句话在不同时刻说两次是两条证据，
 * 各自有 id），而去重键**不含时间**——「同一句话是不是已经记过了」不该因为又过了一天
 * 就变成新内容。两者用途不同，刻意分开。
 */
export function factDedupKey(fact: Pick<MemoryFact, 'kind' | 'content' | 'memoryKey'>): string {
  return `${fact.kind}\u0000${fact.memoryKey ?? ''}\u0000${normalizeForDedup(fact.content)}`;
}

/** 按 `factId` 去重并保持稳定顺序（`observedAt` 升序、同刻按 id 升序） */
export function dedupeFacts(facts: readonly MemoryFact[]): MemoryFact[] {
  const byId = new Map<string, MemoryFact>();
  for (const fact of facts ?? []) {
    if (!fact || typeof fact.factId !== 'string') continue;
    if (!byId.has(fact.factId)) byId.set(fact.factId, fact);
  }
  return [...byId.values()].sort((a, b) => {
    const d = Date.parse(a.observedAt) - Date.parse(b.observedAt);
    return d !== 0 ? d : compareStrings(a.factId, b.factId);
  });
}
