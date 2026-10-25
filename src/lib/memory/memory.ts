import { platform } from '@/platform';
import { connectionManager } from '@/ai/connectionManager';
import {
  MEMORY_KEY_PREFIX,
  MEMORY_TAG_CLOSE,
  MEMORY_TAG_OPEN,
  USER_MEMORY_KEY,
} from '@/lib/core/constants';
// 工作区记忆的目录约定与合并规则：渲染层要与主进程、Web 端「看到同一份事实」，
// 故这三件事集中在 workspaceMemory.ts，不在这里各写一遍。
import {
  CURATED_MEMORY_FILE,
  dailyMemoryFileName,
  mergeMemoryFiles,
  workspaceMemoryDirPath,
} from '@/lib/memory/workspaceMemory';
import { hashContent } from '@/lib/workspace/workspaceKey';
import { fileKeyOf, snapshotBeforeWrite } from '@/lib/artifact/fileBackup';
// 归一化 / 正文提取的实现在纯模块 `memoryMerge`（本文件要用，同时转出给既有调用方）
import { normalizeForDedup, parseEntryBodies } from '@/lib/memory/memoryMerge';
// `workspaceKeyFor` / `DEFAULT_WORKSPACE_KEY` 已搬去 workspaceKey.ts（主进程做旧数据
// 懒迁移时要算同一个 key，而主进程 import 不了渲染层的 platform）。这里转出，
// 让既有 `from '@/lib/memory/memory'` 的引用继续可用。
export { DEFAULT_WORKSPACE_KEY, workspaceKeyFor } from '@/lib/workspace/workspaceKey';
import type {
  ChatMessageParam,
  MemoryAppendOptions,
  MemoryMeta,
  MemoryScope,
  MemoryScopeSummary,
} from '@/types';
import type { ChatRequest } from '@/ai/runtime/types';

/** 自动摘要的**单节**字数上限（对应 PRD：≤150 字） */
const SUMMARY_MAX_CHARS = 150;

/** 结构化摘要的两节标签；解析见 parseSummary */
const SUMMARY_IDENTITY_TAG = '[身份]';
const SUMMARY_TASK_TAG = '[任务]';

/**
 * 自动摘要提示模板：要求**分节**输出，而不是一段笼统摘要。
 *
 * 分节不是格式洁癖——「落到哪一层」由内容性质决定，不能由调用方一刀切切：
 * 用户的称呼 / 职业是**跨项目**事实（L2 用户级），换一个工作区依然成立；
 * 而项目决策与待办只对**当前工作区**有意义（L3）。
 *
 * 旧版只输出一段文本（且限定「决策 / 偏好 / 待办」三类），带来两个后果：
 * 身份类事实要么被写进工作区记忆（换个工作区就丢），要么压根不属于那三类而被
 * 整段丢弃 —— 后者正是「我告诉过它我叫什么，新会话却不知道」的直接原因。
 */
const SUMMARY_SYSTEM_PROMPT = [
  '你是会话记忆归纳助手。请把下面的对话压缩为用于长期记忆存档的中文摘要。',
  '严格按下面两节输出，两节都必须出现；某一节没有内容就写「无」：',
  '',
  `${SUMMARY_IDENTITY_TAG} 用户的称呼或姓名、年龄段、职业与专业背景、所在组织与角色、稳定的个人偏好。`,
  `${SUMMARY_TASK_TAG} 本次会话的关键决策、已确认方案、待办事项、项目专有事实。`,
  '',
  `要求：全文不超过 ${SUMMARY_MAX_CHARS} 字；只保留跨会话仍有价值的信息；`,
  '只写**新增的**或**发生变化**的事实（这类事实出现两次会让记忆里堆满复述）；',
  // 「当前工作目录」看着像项目专有事实，其实是**每轮会变的运行时值**：写进长期记忆
  // 就等于给后续每个会话埋一个错的默认目录（引擎侧同款事故见 MEMORY.md 里的
  // `Current working directory: D:\test`）。写入侧拦一道，比事后清理便宜。
  '不要记录当前工作目录、盘符或本机绝对路径（这类信息换一个会话就不成立）；',
  '不要输出解释性文字，不要使用 Markdown 标题，不要复述本条要求。',
].join('\n');

/**
 * 归纳时附带的「已有长期记忆」上下文（见 `summarize` 的 `knownFacts`）。
 *
 * 为什么非要把它喂给归纳模型：模型只能判断「这条是不是已经记过」，前提是**它知道
 * 已经记过什么**。此前 `summarize` 只看得到本次会话，于是每次会话结束都把
 * 「用户叫明明」重新归纳一遍——16:55 自动沉淀写一条、16:56 与 17:14 模型又各写
 * 一条，三份措辞不同的同一事实就是这么来的。字符级的近似判定救不了这种改写式
 * 重复（见 `isSameStatement` 的实测表），只有模型能救。
 *
 * 措辞刻意区分「新增」与「变化」：单纯说「不要重复」会让模型把**更新**也当成
 * 重复丢掉（`20岁` → `25岁` 恰恰是最该记的一类）。
 */
const KNOWN_FACTS_HEADING = '以下是已经存在于长期记忆中的内容：';
const KNOWN_FACTS_RULES = [
  '请只输出上面**没有**的新事实，或与上面**不同**的变化（例如年龄、所在地、职业发生了变化）。',
  '上面已经记过、且本次没有变化的内容，一律不要复述。',
  '如果本次对话没有任何新增或变化的信息，两节都写「无」。',
].join('\n');

/** 模型表示「这一节没有内容」的几种写法（归一化为空串） */
const SUMMARY_EMPTY_TOKENS = new Set(['无', 'none', 'n/a', 'na', '-', '—', '（无）', '(无)']);

/**
 * 摘要导出为两节后的结构。
 * `identity` → L2 用户级（跨项目）；`task` → L3 工作区级。
 */
export interface StructuredSummary {
  identity: string;
  task: string;
}

/** 两节都为空（等价于「这次没什么可记的」） */
export function isEmptySummary(s: StructuredSummary): boolean {
  return s.identity === '' && s.task === '';
}

/**
 * 「这看起来是 provider / 网关的系统报错，而不是一段对话摘要」的启发式判定。
 *
 * 为什么护栏必须落在**内容层**：网关（nanobot）在配额 / 鉴权失败时会把错误文案
 * 当作**正常 `delta.content` 吐进 SSE 流**，通道层面分不出这一帧是回答还是报错。
 * 实测事故：用户提问撞上 provider 配额耗尽，错误原文（`The AI provider rejected
 * the request because the API key is out of quota…`）被 `summarize` 当作模型输出
 * 收下，又因为不含 `[身份]/[任务]` 标签走了 `parseSummary` 的整段降级分支，
 * 最终以「会话摘要」的名义写进工作区记忆（当时还是 `~/.nanowork/memory/<key>.md`，
 * 现在的工作区落点是 `<工作目录>/.nanowork/memory/`）。
 * 记忆是长期资产：一条系统报错躺进去，此后每次会话都会把它当事实注入。
 *
 * 判据刻意用「**强特征词** + **语言**」双重条件，宁可漏判也不误杀：
 * - 只看特征词会误杀「用户正在排查 API key 配额问题」这类完全正常的摘要——
 *   中文摘要里出现英文术语是常态；
 * - 报错原文则以英文为主、几乎不含中文。故要求「命中特征词 **且** 中文占比
 *   低于 15%」才判为报错。
 *
 * 已知代价：**中文错误文案认不出来**（中文报错与中文摘要在语言上无法区分），
 * 这类漏判由 `summarize` 的 onError 通道兜底，不由本判定承担。
 *
 * ⚠️ 2026-10-01 补三类**真实漏判**——从生产记忆目录里捞出 6 条报错块，全都是下面这些形态：
 * 上游「模型不存在」类（`The model \`x\` does not exist…`）、`Error calling LLM: Connection error.`、
 * 以及网关把 Python dict repr 当 content 吐出来的 `Error: {'message': …}`。
 * 它们**全是英文**（中文占比 0%，语言条件本就满足），漏的是特征词：原先表里没有任何一条
 * 能命中 `does not exist` / `model_not_found` / `connection error`，而裸的 `Error` 也不算特征词。
 * 后果不只是「少拦一条」——报错会被 `parseSummary` 整段降级成 `task` 落盘，
 * 此后每个会话都被注入一次（正是本判定存在的理由）。
 */
// 判据本体已搬到纯模块 `@/lib/memory/memoryDetect`（事实校验也要用它，而事实校验必须是纯函数）；
// 这里转出，让既有 `from '@/lib/memory/memory'` 的引用继续可用。**必须 import 再 export**：
// `export { x } from '…'` 不会把 `x` 引进本模块作用域，而下面 `parseSummary` 与
// `summarize` 都要直接调它。
import { looksLikeSystemError } from '@/lib/memory/memoryDetect';
// 记忆 v2 的注入装配（预算 / 优先级 / truncated / provenance 都在那一处实现）
import {
  DEFAULT_INJECTION_BUDGET,
  buildInjectionBlock,
} from '@/lib/memory/memoryInjection';
import { resolveMemoryPolicy } from '@/lib/memory/memoryPolicy';
import { ensureLocalMemoryScope, platformMemoryIo as memoryStoreIo, userMemoryRef, workspaceMemoryRef } from '@/lib/memory/memoryPlatformIo';
import { listActivePreferences } from '@/lib/memory/memoryUser';
import { parseMemoryFactLine } from '@/lib/memory/memoryFact';
import { recall, renderRecalledContext } from '@/lib/memory/recall';
import { loadEventStreamCorpus } from '@/lib/memory/recallCorpus';

/**
 * 一次会话创建时召回的命中上限。
 *
 * 取 3 而不是 5：召回结果是**附加**在长期记忆之后的，而它的价值随排名迅速衰减。
 * 宁可少带两条，也不要让「可能的旧上下文」挤掉「确定的长期规则」。
 */
const DEFAULT_RECALL_LIMIT = 3;
import {
  CURATED_STATE_FILE,
  DAILY_SUBDIR,
  PREFERENCES_FILE,
  PROFILE_FILE,
  workspaceIdFor,
} from '@/lib/memory/memoryPaths';
import type { MemoryDirRef } from '@/platform/types';
import type {
  CuratedEntry,
  MemoryFact,
  MemoryPolicySettings,
  PreferenceRecord,
  UserProfile,
} from '@/types';
export { looksLikeSystemError };

/**
 * 把模型输出解析成两节。
 *
 * 刻意**容错**：模型可能漏标签、写多行、或加 `**加粗**` 包裹。因此：
 * - 命中两节标签 → 按标签切分；
 * - 只命中间一节 → 另一节为空，命中的那节按标签取；
 * - 完全没有标签（旧模型 / 被截断）→ 整段视为 `task`，保持与旧实现一致的行为，
 *   不会因为一次解析失败就把整轮对话的记忆丢掉。
 *
 * 唯一的**例外是系统报错**：降级分支的前提是「这确实是模型对对话的归纳，
 * 只是格式没按约定」，而报错原文既不是归纳、也不含任何对话事实。它在标签判定
 * **之前**被丢弃——报错文案偶尔会粘连模型输出的半截标签，那种情况下按标签切出来的
 * 「半截身份」同样是垃圾。
 */
export function parseSummary(text: string): StructuredSummary {
  const src = (text ?? '').trim();
  if (src === '') return { identity: '', task: '' };
  if (looksLikeSystemError(src)) return { identity: '', task: '' };

  const idIdx = src.indexOf(SUMMARY_IDENTITY_TAG);
  const taskIdx = src.indexOf(SUMMARY_TASK_TAG);

  if (idIdx === -1 && taskIdx === -1) {
    return { identity: '', task: clampSummary(src) };
  }

  const cut = (body: string) => {
    const trimmed = body.trim().replace(/^\*\*|\*\*$/g, '').trim();
    return SUMMARY_EMPTY_TOKENS.has(trimmed.toLowerCase()) ? '' : clampSummary(trimmed);
  };

  if (idIdx !== -1 && taskIdx !== -1) {
    // 两节都在：按各自标签的位置切，**不假设先后顺序**——
    // 模型偶尔会先写任务再补身份，把顺序当成约束会让其中一节凭空消失。
    const idBodyStart = idIdx + SUMMARY_IDENTITY_TAG.length;
    const taskBodyStart = taskIdx + SUMMARY_TASK_TAG.length;
    if (idIdx < taskIdx) {
      return {
        identity: cut(src.slice(idBodyStart, taskIdx)),
        task: cut(src.slice(taskBodyStart)),
      };
    }
    return {
      identity: cut(src.slice(idBodyStart)),
      task: cut(src.slice(taskBodyStart, idIdx)),
    };
  }

  if (idIdx !== -1) {
    return {
      identity: cut(src.slice(idIdx + SUMMARY_IDENTITY_TAG.length)),
      task: '',
    };
  }
  return { identity: '', task: cut(src.slice(taskIdx + SUMMARY_TASK_TAG.length)) };
}

/** 单节截断到上限（保留首部，摘要的价值集中在开头） */
function clampSummary(text: string): string {
  const s = (text ?? '').trim();
  return s.length > SUMMARY_MAX_CHARS ? s.slice(0, SUMMARY_MAX_CHARS) : s;
}

/** 记忆块去重标记的隐藏注释前缀（与 SUMMARY:<hash> 配套） */
const DEDUP_MARKER_OPEN = '<!-- SUMMARY:';
const DEDUP_MARKER_CLOSE = ' -->';

/**
 * 注入记忆块的边界指令行：防止模型把历史记忆当作自身身份或系统指令，
 * 避免旧记忆内容覆盖当前 Agent 的 systemPrompt 人设。
 * extractFromInjection 会剥离该行以还原记忆原文。
 *
 * 末句是**分层定序的裁决规则**：现在注入块含两段（用户级 + 工作区级），
 * 两段都可能有「用户偏好什么 / 用户是谁」这类陈述，而用户级装的是跨项目成立的
 * 事实、工作区级可能只是某个项目的旧上下文。不给裁决规则，模型只能靠猜。
 */
// 护栏句与段标题的**字符串本身**已搬到纯模块 `@/lib/memory/memoryInjectionContract`：
// 记忆 v2 的注入装配（`memory/memoryInjection.ts`）也要用它们，而那个模块必须能离线跑。
// 这里 import 再转出——必须 import，因为下面的 `wrapForInjection` / `extractFromInjection`
// 与 `composeMemoryForInjection` 要直接用它们。
import { INJECTION_HEADINGS, MEMORY_GUARD_LINE } from '@/lib/memory/memoryInjectionContract';
export { INJECTION_HEADINGS, MEMORY_GUARD_LINE };

const INJECTION_USER_HEADING = INJECTION_HEADINGS.user;
const INJECTION_WORKSPACE_HEADING = INJECTION_HEADINGS.workspace;

/**
 * 把两层记忆合成为**一次注入**用的正文。
 *
 * 为什么必须合并：写入侧早就分了层（身份 → L2、任务 → L3），注入侧却只读工作区级，
 * 于是 L2 成了一份「写得进、读不出」的文件——在 `D:\test` 说过的「我叫什么」，
 * 换到 `D:\tmp` 就问不出来，而用户级 `MEMORY.md` 里明明躺着这条事实。
 *
 * **定序固定为「用户级在前、工作区级在后」**：用户级装的是跨项目成立的身份类事实，
 * 是理解后续一切的基准；工作区级是项目上下文，冲突时让位（护栏句已写明裁决规则）。
 * 顺序不可交换——记忆块紧跟其后的护栏句会按同一假设解释。
 *
 * 只有一层有内容时**照样带标题**：让模型看得出这条记忆的适用边界，
 * 也避免同一份内容在不同工作区被理解成不同层级。
 * 两层皆空返回空串，调用方据此走「空记忆」分支。
 */
export function composeMemoryForInjection(
  userText: string,
  workspaceText: string,
): string {
  const sections: string[] = [];
  const user = (userText ?? '').trim();
  const workspace = (workspaceText ?? '').trim();
  if (user !== '') sections.push(`${INJECTION_USER_HEADING}\n${user}`);
  if (workspace !== '') sections.push(`${INJECTION_WORKSPACE_HEADING}\n${workspace}`);
  return sections.join('\n\n');
}

/**
 * 归一化 / 正文提取的实现已迁到 `@/lib/memory/memoryMerge`——那里还要做段落级 LWW，
 * 且必须是**纯模块**（同步层与单测要直接调它，而本文件 import 了 `@/platform`）。
 * 此处转出，让既有 `from '@/lib/memory/memory'` 的引用继续可用。
 */
export { normalizeForDedup, parseEntryBodies } from '@/lib/memory/memoryMerge';

/** 一条 `append` 的结果；调用方可以忽略，测试与「记忆页」用它区分原因 */
export type MemoryAppendOutcome = 'written' | 'skipped-empty' | 'skipped-duplicate';

/**
 * 「新内容与某条已有记忆是同一句陈述」的判定。
 *
 * ## 为什么只做**归一化后完全相等**，不做相似度阈值
 *
 * 曾打算用 bigram Dice / 覆盖率做模糊判定，但拿磁盘上三条真实的重复记忆
 * （「明明，20岁，新疆工作，即将返京」／「用户名叫明明，20岁，现居新疆，
 * 计划近期返回北京」／「用户姓名：明明；年龄：20岁；…」）实测后发现，
 * **这条路在中文短文本上不成立**：
 *
 * | 对照                                       | 覆盖率 | Dice |
 * |--------------------------------------------|--------|------|
 * | 真实的两条改写式重复（**该判重**）          | 0.25~0.45 | 0.22~0.35 |
 * | 「20岁」→「25岁」（**这是更新，不该判重**） | 0.90   | 0.90 |
 * | 「偏好简洁沟通」是「…，关注AI动态」的前缀（**该补充，不该判重**） | 1.00 | 0.56 |
 *
 * 要抓住改写式重复，阈值必须压到 0.45 以下，而那会把「年龄更新」和
 * 「同前缀补充新信息」一并误杀——静默丢记忆比多存一条严重得多。
 * 「更新」与「补充」在字面上与「重复」不可区分：区分它们需要知道**哪部分是事实的键**，
 * 这是语义问题，不是字符串问题。
 *
 * 所以此处的职责严格限定为**机械重复**：同一句话带不同标点 / 空白 / 大小写 /
 * 引用符。语义层面的「已记过就不要写」由写入侧的模型承担
 * （`MEMORY_WRITE_INSTRUCTION` 要求模型先核对已注入的记忆块；
 * `summarize` 的 `knownFacts` 让自动沉淀也看得到已有记忆）。
 */
function isSameStatement(a: string, b: string): boolean {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  return na !== '' && na === nb;
}

/** 工作区索引在 storage 中的 key（记录已知工作区**目录**列表，供多工作区切换） */
const WORKSPACE_INDEX_KEY = `${MEMORY_KEY_PREFIX}index`;

/** 工作区索引里表示「没有工作目录」的占位（localStorage / JSON 里没有 undefined） */
const NO_WORKDIR = '';

/**
 * 把外部的 workdir 收敛成 `string | null`。
 *
 * 空串与全空白一律折成 `null`：`session.workdir` 允许是 `''`（历史数据里出现过），
 * 而 `''` 作为路径会被主进程判成「没有工作目录」。与其在下游每一处都判一次，
 * 不如在入口就收敛成同一种表示。
 */
function normalizeWorkdir(workdir: string | null | undefined): string | null {
  const raw = (workdir ?? '').trim();
  return raw === '' ? null : raw;
}

/**
 * 记忆在磁盘上的真实落点（仅用于展示）。
 *
 * 工作区级现在是**一个目录**（`<工作目录>/.nanowork/memory/`，里面是
 * `MEMORY.md` 与 `YYYY-MM-DD.md`），不再是一个文件——所以末尾带分隔符，
 * 让「这是个目录、里面还有文件」从字符串本身就能看出来。
 *
 * Web 端没有文件系统，落 `localStorage`，返回一句人话而不是编一个假路径。
 *
 * 之所以要在界面上写出来：这份记忆此前既不可见也不可查，
 * 「到底记没记住」只能靠模型复述来猜，出了问题无从下手。
 */
export function memoryDiskPath(scope: MemoryScope, workdir?: string | null): string {
  if (platform.env !== 'electron') return '浏览器本地存储（Web 端无文件落点）';
  return scope === 'user' ? '~/.nanowork/MEMORY.md' : workspaceMemoryDirPath(workdir);
}

/** 作用域的展示元信息（记忆页切换器用） */
const SCOPE_DEFS: Record<MemoryScope, { label: string; description: string }> = {
  user: {
    label: '用户级',
    description:
      '跨项目生效（L2）。写入方：你在本页的手动编辑，以及自动沉淀识别出的**身份类**事实（称呼/职业/稳定偏好）。',
  },
  workspace: {
    label: '工作区级',
    description:
      '当前工作区的长期记忆（L3），落在工作目录下的 .nanowork/memory/。MEMORY.md 是本页维护的精炼记忆，日期文件是每天自动沉淀的日志；两者合并注入，按工作目录隔离。',
  },
};

/**
 * 工作区文件记忆服务（MemoryService）。
 *
 * ## 落点（2026-09 起）
 *
 * | 作用域 | 落点 |
 * |---|---|
 * | 用户级（L2） | `~/.nanowork/MEMORY.md`——跨项目，单文件 |
 * | 工作区级（L3） | `<工作目录>/.nanowork/memory/` 目录：`MEMORY.md`（精炼）+ `YYYY-MM-DD.md`（当天日志） |
 *
 * 工作区级从「产品目录下的单文件 `<工作区key>.md`」改成「工作目录下的目录」，
 * 与 WorkBuddy 的 `.workbuddy/memory/` 同构。两个直接收益：项目目录拷到另一台
 * 机器时记忆跟着走；「我的记忆存在哪」有了一个用户自己能找到的答案，而不必去
 * 产品目录里按 `nanowork-1a2b3c4d.md` 这种名字猜。
 *
 * 没有工作目录的会话（IM 会话、存储设置之前建的旧会话）仍落在产品目录下的
 * `memory/default/`：没有工作目录就没有「跟着走」的载体，硬折算到默认工作空间
 * 会让它和真正绑定那个目录的会话**共用一份记忆**。
 *
 * ## 设计约束
 *
 * - 渲染层永不 import 'electron'，所有 IO 经 `platform.memoryFiles` /
 *   `platform.storage`（Web/Electron 同一套语义，差异封在 platform 里）；
 * - 记忆永不写入 agentsStore.agent.systemPrompt，只在运行时以标签块注入 history。
 *
 * ## 四个刻意的取舍
 *
 * 1. **读取合并、写入分片**。`load` 把目录下全部记忆文件（`MEMORY.md` 在前、
 *    日期文件按名升序在后）合并成一份正文——注入与去重都基于合并结果，所以
 *    「同一句话换个标点的机械重复」跨文件照样挡得住；而 `append` 只写**当天**
 *    那个日期文件，某天的沉淀写坏了不会波及历史。
 * 2. **`save` 只覆盖 `MEMORY.md`**。它是记忆页手动编辑的目标。把合并视图整体
 *    写回会让同样的内容同时存在于 `MEMORY.md` 与日期文件里（一份变两份），
 *    所以记忆页要编辑哪一份就显式写哪一份（见 `writeFile`）。
 * 3. **`undefined` 与 `null` 的 workdir 不是一回事**。省略 `workdir`
 *    （`undefined`）表示「按当前工作区」（记忆页与既有便捷调用点），显式传
 *    `null` 表示「这个会话没有工作目录」。会话的 `workdir` 类型是
 *    `string | undefined`，调用方必须先行 `?? null`——否则一个本来没有工作目录
 *    的会话会去读**上一个会话**的记忆。这是一处真实存在的陷阱，见 `resolveDir`。
 * 4. **懒迁移**。旧落点 `~/.nanowork/memory/<工作区key>.md` 的内容，在某个工作区
 *    第一次被读到时就地搬进新目录（按旧文件最后修改日归档成日期文件），旧文件
 *    改名成 `.migrated` 留档。每个工作区每次进程只尝试一次（见 `ensureMigrated`）。
 */
class MemoryServiceImpl {
  /** 当前工作区目录（记忆页与「不传 workdir」的调用方用它；由 loadMemoryInto 切换） */
  private currentWorkdir: string | null = null;

  /** 多工作区索引（已知工作区目录；`''` 占位表示「没有工作目录」） */
  private workspaceIndex: string[] = [NO_WORKDIR];

  /**
   * 已尝试过懒迁移的工作区集合（`''` 表示无工作目录的那个）。
   *
   * 没有它的话，每次 `load` 都要去 stat 一次可能根本不存在的旧文件；
   * 而 `load` 在会话创建、每轮发送的过期重读、记忆页加载上都会走。
   */
  private migrated = new Set<string>();

  /**
   * 记忆写入版本号（进程内单调递增）。
   *
   * 存在的理由：注入用的是**会话级快照**（`Session.memory`），而快照只在「会话创建 /
   * 首次水合」时生成一次。没有版本号，会话存活期间发生的任何写入——模型本轮写下的
   * `<memory-save>`、另一个会话结束时的自动沉淀、记忆页的手动编辑——对**已经加载
   * 的会话**都是不可见的。
   *
   * 实测事故（2026-09-17）：在 `D:\temp` 的会话里写下「用户擅长前端 GIS 开发」，
   * 13 秒后在 `D:\tmp` 的会话问「我擅长什么」，事件流里记录的请求体显示注入的仍是
   * 该会话上一次读取时的旧快照——写后 57 秒再问一次，注入内容逐字节相同。
   *
   * 它只回答「有没有变过」，不回答「变成了什么」：与快照记录的值相等即视为有效，
   * 不等则重读一次（读盘是唯一的真相来源）。因此**不做**「内容没变就不递增」的
   * 优化——这种优化一旦判断错，代价是永久读到旧记忆；而多刷一次的代价只是一次
   * 本机文件读。
   */
  private writeVersionValue = 0;

  constructor() {
    // 启动时尝试从 storage 恢复工作区索引
    void this.restoreIndex();
  }

  private async restoreIndex(): Promise<void> {
    try {
      const raw = await platform.storage.get<string>(WORKSPACE_INDEX_KEY);
      if (typeof raw === 'string') {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          this.workspaceIndex = (parsed as string[]).filter((k) => typeof k === 'string');
          if (!this.workspaceIndex.includes(NO_WORKDIR)) {
            this.workspaceIndex.unshift(NO_WORKDIR);
          }
        }
      }
    } catch {
      /* 索引缺失则保持默认 */
    }
  }

  /** 切换当前工作区（并登记到索引） */
  useWorkspace(workdir: string | null | undefined): void {
    this.currentWorkdir = normalizeWorkdir(workdir);
    const slot = this.currentWorkdir ?? NO_WORKDIR;
    if (!this.workspaceIndex.includes(slot)) {
      this.workspaceIndex.push(slot);
      void this.persistIndex();
    }
  }

  /** 列举已知工作区及其记忆规模（用于多工作区切换 UI） */
  async listWorkspaces(): Promise<
    Array<{ path: string | null; chars: number; entries: number }>
  > {
    const result: Array<{ path: string | null; chars: number; entries: number }> = [];
    for (const slot of this.workspaceIndex) {
      const dir = slot === NO_WORKDIR ? null : slot;
      const text = await this.load('workspace', dir);
      result.push({ path: dir, chars: text.length, entries: this.countEntries(text) });
    }
    return result;
  }

  private async persistIndex(): Promise<void> {
    try {
      await platform.storage.set(WORKSPACE_INDEX_KEY, JSON.stringify(this.workspaceIndex));
    } catch {
      /* 降级忽略 */
    }
  }

  /**
   * 当前工作区目录（记忆页的落点展示、以及「不传 workdir」的调用方用）。
   * 没有绑定工作目录时返回 `null`——**不是一个叫 `default` 的目录**：
   * 记忆页要如实显示「这份记忆落在产品目录下的兜底位置」。
   */
  resolveWorkspaceDir(): string | null {
    return this.currentWorkdir;
  }

  /**
   * 解析「这次操作针对哪个工作目录」。
   *
   * `undefined` 与 `null` 在这一层是**两个语义**（见类头注释取舍 3）：
   * 省略参数表示「按当前工作区」（记忆页、`sessionsPromptAssembly` 这类便捷调用点），
   * 显式传 `null` 表示「这个会话确实没有工作目录」。会话的 `workdir` 类型是
   * `string | undefined`，调用方必须先 `?? null` 才能表达后者。
   */
  private resolveDir(workdir: string | null | undefined): string | null {
    if (workdir === undefined) return this.currentWorkdir;
    return normalizeWorkdir(workdir);
  }

  /** 按 storage key 读取（任意 key，含用户级） */
  private async loadRawKey(storageKey: string): Promise<string> {
    try {
      const raw = await platform.storage.get<string>(storageKey);
      return typeof raw === 'string' ? raw : '';
    } catch {
      return '';
    }
  }

  /**
   * 懒迁移只做一次（每个工作目录每进程一次）。
   *
   * 没有这个闸门，每次 `load` 都要去 `lstat` 一个可能根本不存在的旧文件——而
   * `load` 在会话创建、每轮发送的过期重读、记忆页加载上都会走。
   *
   * 先登记再 await：并发调用（`Promise.all` 里的两次读取）不会重复跑一遍迁移。
   * 迁移失败则不重试——旧数据仍在原处，下个进程启动还会再来一次。
   */
  private async ensureMigrated(dir: string | null): Promise<void> {
    const slot = dir ?? NO_WORKDIR;
    if (this.migrated.has(slot)) return;
    this.migrated.add(slot);
    try {
      const written = await platform.memoryFiles.migrateLegacy(dir);
      // 迁移本身也是一次记忆变更：不递增版本号的话，活跃会话的快照判据看不到它，
      // 迁出来的旧记忆要等会话重建才会被注入（症状是「升级后旧记忆要重启才生效」）。
      if (written.length > 0) this.writeVersionValue += 1;
    } catch {
      /* 迁移失败不影响读取：新目录本就是空的，旧数据还在原处 */
    }
  }

  /**
   * 读取工作区记忆：**合并目录下的全部记忆文件**。
   *
   * 注入与去重都基于这份合并视图，所以「同一句话换个标点的机械重复」跨文件照样
   * 挡得住（`MEMORY.md` 里记过、今天又想写进日期文件时会命中）。各文件的排序
   * 规则见 `sortMemoryFileNames`。
   */
  private async loadWorkspace(dir: string | null): Promise<string> {
    const names = await platform.memoryFiles.list(dir);
    if (names.length === 0) return '';
    const files = await Promise.all(
      names.map(async (name) => ({
        name,
        content: (await platform.memoryFiles.read(dir, name)) ?? '',
      })),
    );
    return mergeMemoryFiles(files);
  }

  /**
   * 当前记忆写入版本（只读）。
   *
   * 注入侧的唯一用途：把「生成快照时的版本」与它比对，不等就重读
   * （见 `sessionsStore.isMemorySnapshotStale`）。调用方不要自行推断记忆内容，
   * 版本号只表达「变过 / 没变过」。
   */
  writeVersion(): number {
    return this.writeVersionValue;
  }

  /**
   * 读取记忆全文。读取失败或从未写入时返回空串（不抛出，避免阻塞会话创建）。
   *
   * `scope` 缺省为 `'workspace'`；`workdir` 缺省按当前工作区（见 `resolveDir`）。
   * 工作区级读的是**合并视图**（`MEMORY.md` + 各日期文件，见 `loadWorkspace`），
   * 而不是磁盘上某一个文件——注入、去重、记忆页的全文预览都用这一份，
   * 三者看到的才是同一个「这个工作区记住了什么」。
   */
  async load(scope: MemoryScope = 'workspace', workdir?: string | null): Promise<string> {
    if (scope === 'user') return this.loadRawKey(USER_MEMORY_KEY);
    const dir = this.resolveDir(workdir);
    await this.ensureMigrated(dir);
    return this.loadWorkspace(dir);
  }

  /**
   * 读取**两层**记忆并合成为一次注入用的正文。
   *
   * 这是会话注入链路的唯一入口：`identity` 写 L2、`task` 写 L3（见
   * `sedimentSession`），读的时候必须把两层都取回来，否则「在 A 工作区说过的名字
   * 在 B 工作区问不出来」——记忆写进了 `~/.nanowork/MEMORY.md`，却没有任何一条
   * 注入链路会读它。
   *
   * 顺带把条数一并算好（`entries`）：合成时加了段标题，调用方若对合成文本调
   * `countEntries` 会把标题算进段落数；这里对**两段原文各按各自体例计数后求和**
   * 才是准确的「记忆条数」。
   *
   * 两段并行读：这是会话创建路径上的 IO，串行等于把延迟翻倍。
   *
   * ## 记忆 v2（2026-10-02）：三部分，**只增不减**
   *
   * 合成结果 = 用户级（v1 + v2 策展）→ 工作区级（v1 + v2 策展）。
   * v2 的 `curated.json` 只在**确实有 active 修订**时才产出一段；没有它时行为与
   * v1 逐字节相同（因此既有测试与既有磁盘数据零影响）。
   *
   * 这条「只增不减」是刻意的：v1 的 `MEMORY.md` / 日期 `.md` 是用户既有资产，
   * 换成「只注入 active 修订」会让它们**一个字都不再进 prompt**——用户升级后发现
   * 「它以前记得的事现在不记得了」，而且既有测试全绿也发现不了（它们测的是本函数，
   * 而链路本可以只换集合）。legacy 段落因此永远保留在末尾、最低优先级。
   */
  async loadForInjection(
    workdir?: string | null,
    recallQuery?: string,
    policySettings?: Partial<MemoryPolicySettings> | null,
  ): Promise<{ text: string; entries: number; truncated: number }> {
    // 用户在设置页调过的门槛/预算在这里生效。**必须**由调用方传入而不是本模块去读
    // settings：读全局状态会让纯函数层不可离线验证，也会让「预算从哪来」散落各处。
    const resolved = resolveMemoryPolicy(policySettings);
    const [userText, workspaceText, userCurated, workspaceCurated, profile, preferences, facts] =
      await Promise.all([
        this.load('user'),
        this.load('workspace', workdir),
        this.readUserScopedCurated(),
        this.readWorkspaceScopedCurated(workdir),
        this.readUserProfile(),
        this.readActivePreferences(),
        this.readRecentFacts(workdir, resolved.budget.recentFactLimit),
      ]);

    // v2 侧按**预算**装配（设计 §4.6）：legacy 正文作为最低优先级段落传进去，
    // 于是「预算够就都进、不够就裁」这件事只发生在 `buildInjectionBlock` 一处。
    const block = buildInjectionBlock(
      {
        profile,
        preferences,
        userCurated,
        workspaceCurated,
        recentFacts: facts,
        userLegacyText: userText,
        workspaceLegacyText: workspaceText,
      },
      resolved.budget,
    );

    // 条数 = v2 结构化行数 + legacy 正文按 v1 体例的条数（两段各自计数之和）。
    // 不数合成后的正文：那会多算出两个段标题。
    const structured = {
      text: block.text,
      entries: block.entries + this.countEntries(userText) + this.countEntries(workspaceText),
      truncated: block.truncated,
    };

    // 跨会话召回（可选）：只在调用方给了 query 时才算。
    // **放在这里而不是装配路径**：本函数在已有的异步边界内（`loadMemoryInto`），
    // 而装配段必须保持同步（NFR-M2 的「send 同步进入流式态」）。
    if (recallQuery === undefined || recallQuery.trim() === '') return structured;
    const recalled = await this.loadRecallContext(recallQuery);
    if (recalled === '') return structured;
    return {
      text: `${structured.text}\n\n${recalled}`,
      entries: structured.entries,
      truncated: structured.truncated,
    };
  }

  /**
   * 按当前 query 做一次跨会话召回，渲染成 `<recalled_context>` 块。
   *
   * 三条边界：**只读**（不写任何 durable store）、**失败即静默跳过**
   * （召回是增强能力，不该让会话创建失败）、**命中为空返回空串**
   * （不为空 wrapper 消耗 prompt 预算）。
   */
  private async loadRecallContext(rawQuery: string): Promise<string> {
    try {
      const scope = await ensureLocalMemoryScope();
      const corpus = await loadEventStreamCorpus({ userScope: scope });
      if (corpus.length === 0) return '';
      const result = recall(rawQuery, corpus, {
        userScope: scope,
        limit: DEFAULT_RECALL_LIMIT,
        now: new Date(),
      });
      return renderRecalledContext(result);
    } catch {
      return '';
    }
  }

  /** 用户级 canoncial 的存储根（`~/.nanowork/user-memory/<scope-id>/`） */
  private async userDirRef(): Promise<MemoryDirRef> {
    const scope = await ensureLocalMemoryScope();
    return userMemoryRef(scope);
  }

  /**
   * 读一份 `curated.json` 并取出**结构化**的 active 修订。
   *
   * 与旧的「先渲染成文本再拼」相比，这里返回 `CuratedEntry[]` 交给
   * `buildInjectionBlock` 统一排序与裁剪——预算、优先级、`truncated` 计数因此只有
   * 一处实现。`superseded` / `disabled` / 冲突候选仍然永不进 prompt（不变量 I8）。
   */
  private async readCuratedState(dirRef: MemoryDirRef): Promise<CuratedEntry[]> {
    try {
      const raw = await memoryStoreIo(dirRef).read(CURATED_STATE_FILE);
      if (raw === null || raw.trim() === '') return [];
      const parsed = JSON.parse(raw) as { revisions?: unknown };
      if (!Array.isArray(parsed.revisions)) return [];
      return parsed.revisions.filter((item): item is CuratedEntry => {
        if (typeof item !== 'object' || item === null) return false;
        const r = item as Partial<CuratedEntry>;
        return typeof r.content === 'string' && typeof r.entryKey === 'string';
      });
    } catch {
      // 记忆 v2 是叠加层：它的任何读取问题都不该让会话创建失败
      return [];
    }
  }

  private async readUserScopedCurated(): Promise<CuratedEntry[]> {
    try {
      return await this.readCuratedState(await this.userDirRef());
    } catch {
      return [];
    }
  }

  private async readWorkspaceScopedCurated(workdir?: string | null): Promise<CuratedEntry[]> {
    return this.readCuratedState(workspaceMemoryRef(this.resolveDir(workdir)));
  }

  /** 读用户画像（`profile.json`）；不存在或损坏返回空画像 */
  private async readUserProfile(): Promise<UserProfile> {
    try {
      const raw = await memoryStoreIo(await this.userDirRef()).read(PROFILE_FILE);
      if (raw === null || raw.trim() === '') return {};
      const parsed = JSON.parse(raw) as { profile?: unknown };
      if (typeof parsed.profile !== 'object' || parsed.profile === null) return {};
      return parsed.profile as UserProfile;
    } catch {
      return {};
    }
  }

  /**
   * 读**可注入**的偏好：只取 `asOf < expiresAt` 的那些（FR-M22）。
   *
   * 过期偏好留在 canonical 里以便解释「它曾经为何生效」，但**不进 prompt**。
   */
  private async readActivePreferences(): Promise<PreferenceRecord[]> {
    try {
      const raw = await memoryStoreIo(await this.userDirRef()).read(PREFERENCES_FILE);
      if (raw === null || raw.trim() === '') return [];
      const parsed = JSON.parse(raw) as { records?: unknown };
      if (!Array.isArray(parsed.records)) return [];
      const records = parsed.records.filter(
        (r): r is PreferenceRecord =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as PreferenceRecord).key === 'string' &&
          typeof (r as PreferenceRecord).value === 'string',
      );
      return listActivePreferences(
        { schema: 2, userScope: '', records, updatedAt: new Date().toISOString() },
        new Date(),
      );
    } catch {
      return [];
    }
  }

  /**
   * 读**最近**若干条事实（设计 §4.6 的「最近事实」窗口）。
   *
   * 这是 daily 日志进入 prompt 的**唯一**通道，也是「注入量不随日志天数增长」的实现：
   * 无论日志攒了多少天，这里只看最新 N 条。
   */
  private async readRecentFacts(workdir: string | null | undefined, limit: number): Promise<MemoryFact[]> {
    if (limit <= 0) return [];
    try {
      const io = memoryStoreIo(workspaceMemoryRef(this.resolveDir(workdir)));
      const names = (await io.list(DAILY_SUBDIR)).filter((n) => /\.jsonl$/i.test(n)).sort().reverse();
      const collected: MemoryFact[] = [];
      const expected = workspaceIdFor(this.resolveDir(workdir));
      for (const name of names) {
        const lines = await io.readLines(name, DAILY_SUBDIR);
        for (const line of lines.reverse()) {
          const fact = parseMemoryFactLine(line, expected);
          if (!fact) continue;
          collected.push(fact);
          if (collected.length >= limit) break;
        }
        if (collected.length >= limit) break;
      }
      return collected;
    } catch {
      return [];
    }
  }

  /**
   * 覆盖写入某一份记忆。
   *
   * - `scope='user'`：写 `~/.nanowork/MEMORY.md`（单文件，跨项目）。
   * - `scope='workspace'`：写工作目录下的 **`MEMORY.md`**（精炼记忆，记忆页的
   *   编辑目标）。**不写合并视图**——那会把日期文件里的内容复制进 `MEMORY.md`，
   *   同一句话遂在磁盘上存在两份。要改某一个日期文件，用 `writeFile` 指名字。
   *
   * 空内容等价于「删掉这一份」而不是留一个 0 字节文件：空文件在目录里只会被
   * `listMemoryFiles` 列出来、被 `mergeMemoryFiles` 跳过，即一个「列表里有它、
   * 点进去是空的」的幽灵条目。
   *
   * `scope` 刻意放在**末位可选参数**（而非 PRD 14.2 示例的首位）：本服务已有
   * 40 余处 `save(text)` 调用，改成首位会让「改一行实现」变成「改四十个调用点」，
   * 收益为零而回归风险不小。语义与 PRD 一致，只是参数位置不同。
   *
   * 写入是递增 `writeVersionValue` 的地方之一（`clear` / `append` / `writeFile` /
   * `removeFile` 同此），所以「版本变了」等价于「某处真的落过盘」。
   */
  async save(
    fullText: string,
    scope: MemoryScope = 'workspace',
    workdir?: string | null,
  ): Promise<void> {
    if (scope === 'user') {
      // 写前快照（FR-7.3）：用户级记忆是单文件，覆盖前备份旧正文
      const old = await platform.storage.get<string>(USER_MEMORY_KEY);
      await snapshotBeforeWrite(fileKeyOf('user', null, CURATED_MEMORY_FILE), old ?? null, 'overwrite');
      await platform.storage.set(USER_MEMORY_KEY, fullText ?? '');
      this.writeVersionValue += 1;
      return;
    }
    // 工作区级 = 写精炼记忆那一份（`MEMORY.md`）。空内容的处理（等于删掉这一份）
    // 与版本号递增、写前快照都在 writeFile 里，一条规则一处实现。
    await this.writeFile(workdir, CURATED_MEMORY_FILE, fullText ?? '');
    // 递增放在写入**完成之后**：先递增会让并发读取拿到「新版本 + 旧内容」的快照，
    // 而那个快照会被后续判定为有效，于是永久停在旧内容上。
  }

  /**
   * 清空某个作用域的记忆。
   *
   * 工作区级是**删除该工作区记忆目录下的全部记忆文件**（`MEMORY.md` + 所有日期
   * 文件），与旧的「`save('')` 覆盖成一个空文件」不同：既然工作区记忆已经是
   * 「一个目录、若干分片」，清空就必须按目录清，否则日期文件会整批留下来，
   * 用户按了「清空」却还能看到旧记忆。
   *
   * 只删记忆文件、**不删目录本身**，也不动用户放在同目录下的其它文件——
   * 「清空记忆」不该顺带清理别人的目录。
   */
  async clear(scope: MemoryScope = 'workspace', workdir?: string | null): Promise<void> {
    if (scope === 'user') {
      // 写前快照（FR-7.3）：清空前备份旧正文，op=delete
      const old = await platform.storage.get<string>(USER_MEMORY_KEY);
      await snapshotBeforeWrite(fileKeyOf('user', null, CURATED_MEMORY_FILE), old ?? null, 'delete');
      await platform.storage.set(USER_MEMORY_KEY, '');
      this.writeVersionValue += 1;
      return;
    }
    const dir = this.resolveDir(workdir);
    await this.ensureMigrated(dir);
    // 写前快照（FR-7.3）：清空前逐个备份被删文件的旧正文，op=delete
    const names = await platform.memoryFiles.list(dir);
    for (const name of names) {
      const old = await platform.memoryFiles.read(dir, name);
      await snapshotBeforeWrite(fileKeyOf('workspace', dir, name), old ?? null, 'delete');
    }
    await platform.memoryFiles.removeAll(dir);
    this.writeVersionValue += 1;
  }

  /** 列出某个工作区的记忆文件名（已按注入顺序排序；记忆页的文件切换器用） */
  async listFiles(workdir?: string | null): Promise<string[]> {
    const dir = this.resolveDir(workdir);
    await this.ensureMigrated(dir);
    return platform.memoryFiles.list(dir);
  }

  /**
   * 读取某个记忆文件；不存在返回 `null`。
   *
   * 「不存在」（`null`）与「存在但是空的」（`''`）刻意分开：记忆页要据此区分
   * 「这份日志还没写过」与「写了但又清空了」，前者给占位提示、后者给空编辑器。
   */
  async readFile(workdir: string | null | undefined, name: string): Promise<string | null> {
    const dir = this.resolveDir(workdir);
    await this.ensureMigrated(dir);
    return platform.memoryFiles.read(dir, name);
  }

  /**
   * 覆盖写入某个记忆文件（记忆页的编辑器用）。
   *
   * 空内容等价于**删除该文件**，与 `save` 同一条规则：留一个 0 字节的文件只会
   * 变成「列表里有它、点进去是空的」的幽灵条目。
   *
   * 名字白名单（`MEMORY.md` / `YYYY-MM-DD.md`）由 platform 层把守——两端同一条
   * 边界，这里不重复实现，免得「Web 能存、Electron 存不了」这类差异只在某一端复现。
   */
  async writeFile(
    workdir: string | null | undefined,
    name: string,
    content: string,
  ): Promise<void> {
    const dir = this.resolveDir(workdir);
    await this.ensureMigrated(dir);
    const text = content ?? '';
    // 写前快照（FR-7.3）：覆盖/删除前备份旧正文（op=overwrite；空内容走 remove 也覆盖）
    const old = await platform.memoryFiles.read(dir, name);
    await snapshotBeforeWrite(fileKeyOf('workspace', dir, name), old ?? null, 'overwrite');
    if (text.trim() === '') {
      await platform.memoryFiles.remove(dir, name);
    } else {
      await platform.memoryFiles.write(dir, name, text);
    }
    this.writeVersionValue += 1;
  }

  /** 删除某个记忆文件（幂等；记忆页的「删除这一份」用） */
  async removeFile(workdir: string | null | undefined, name: string): Promise<void> {
    const dir = this.resolveDir(workdir);
    // 写前快照（FR-7.3）：删除前备份旧正文，op=delete
    const old = await platform.memoryFiles.read(dir, name);
    await snapshotBeforeWrite(fileKeyOf('workspace', dir, name), old ?? null, 'delete');
    await platform.memoryFiles.remove(dir, name);
    this.writeVersionValue += 1;
  }

  /**
   * 追加一条记忆：读取现有**合并视图** → 去重判定 → 拼接带时间戳与去重标记的
   * Markdown 引用块 → 写进**当天**的日期文件。
   *
   * 写入目标是分片的（`YYYY-MM-DD.md`）而读取是合并的，这是刻意的：
   * 去重必须看到全部历史（否则同一条会在 `MEMORY.md` 与日期文件里各存一份），
   * 而写入只需要碰今天这一个文件——「今天的沉淀写坏了」不会波及历史。
   *
   * 去重分两层（见 `isSameStatement` 的实测说明）：
   * - **字节级**：内存中即时算出的 djb2 哈希与已有 `<!-- SUMMARY:<hash> -->`
   *   标记比对，命中即跳过（这是快路径，也是历史数据的兼容路径）；
   * - **语句级**：把新内容与**已有各条正文**归一化后逐一比对，挡住「同一句话
   *   换了标点 / 空白 / 大小写 / Markdown 装饰」的机械重复——这类内容的哈希必然不同，
   *   只靠第一层挡不住。
   *
   * 返回写入结果而不是 `void`：调用方可以继续忽略它（`await` 一个返回值的表达式
   * 在 TS 中合法），但测试与「记忆页」需要区分「写进去了」和「因为重复被跳过」。
   *
   * FR-4.2 的「用户显式要求才写」由**调用方**保证：自动沉淀与「记住这条」都用
   * 缺省的 `workspace` 作用域，只有记忆页在用户级作用域下的编辑才会写 `user`。
   *
   * 本次修正 FR-4.2 的一处过窄解读：自动沉淀**可以**写用户级，但仅限其中的
   * **身份类**事实（见 P1-B 分流）。这里 `append` 只负责按 scope + workdir 落盘，
   * 分流策略在调用方。
   */
  async append(
    content: string,
    opts: MemoryAppendOptions = {},
    scope: MemoryScope = 'workspace',
    workdir?: string | null,
  ): Promise<MemoryAppendOutcome> {
    const trimmed = (content ?? '').trim();
    if (!trimmed) return 'skipped-empty';

    const hash = hashContent(trimmed);
    const marker = `${DEDUP_MARKER_OPEN}${hash}${DEDUP_MARKER_CLOSE}`;

    const existing = await this.load(scope, workdir);
    // 幂等去重（字节级）：同一内容（同 hash）不重复追加
    if (existing.includes(marker)) return 'skipped-duplicate';

    // 幂等去重（语句级）：已有条目的正文与新内容归一化后一致
    if (parseEntryBodies(existing).some((body) => isSameStatement(body, trimmed))) {
      return 'skipped-duplicate';
    }

    const at = opts.at ?? new Date().toISOString();
    const source = opts.source?.trim() || '手动保存';
    const block = this.formatBlock(trimmed, source, at, marker);

    if (scope === 'user') {
      // 写前快照（FR-7.3）：追加前备份旧正文（op=append），直接写盘避免与 save 内
      // 的 overwrite 快照重复
      await snapshotBeforeWrite(fileKeyOf('user', null, CURATED_MEMORY_FILE), existing ?? null, 'append');
      const next =
        existing.trim() === '' ? block : `${existing.replace(/\s+$/, '')}\n\n${block}`;
      await platform.storage.set(USER_MEMORY_KEY, `${next}\n`);
      this.writeVersionValue += 1;
      return 'written';
    }

    // 工作区级：追加进**当天**的日期文件（文件名与引用块取自同一个时刻，
    // 否则「时间戳写 09-19、文件却叫 09-20」这种错位会在跨零点时出现）。
    const dir = this.resolveDir(workdir);
    const name = dailyMemoryFileName(at);
    const current = (await platform.memoryFiles.read(dir, name)) ?? '';
    // 写前快照（FR-7.3）：追加前备份当日文件的旧正文，op=append
    await snapshotBeforeWrite(fileKeyOf('workspace', dir, name), current || null, 'append');
    const next =
      current.trim() === '' ? block : `${current.replace(/\s+$/, '')}\n\n${block}`;
    await platform.memoryFiles.write(dir, name, `${next}\n`);
    this.writeVersionValue += 1;
    return 'written';
  }

  /** 各作用域的规模概览（记忆页的作用域切换器用） */
  async scopeSummaries(): Promise<MemoryScopeSummary[]> {
    const scopes: MemoryScope[] = ['user', 'workspace'];
    const result: MemoryScopeSummary[] = [];
    for (const scope of scopes) {
      const text = await this.load(scope);
      const meta = this.meta(text);
      result.push({
        scope,
        label: SCOPE_DEFS[scope].label,
        description: SCOPE_DEFS[scope].description,
        chars: meta.chars,
        entries: meta.entries,
        lastWrittenAt: meta.lastWrittenAt,
      });
    }
    return result;
  }

  /**
   * 生成一条 Markdown 引用块：
   * ```
   * > [2025-01-01T00:00:00.000Z] 来自「会话标题」
   * > <!-- SUMMARY:<hash> -->        ← 隐藏去重标记（位于引用块内，不另起段落，不影响 countEntries）
   * > 正文第一行
   * > 正文第二行
   * ```
   */
  private formatBlock(content: string, source: string, at: string, marker: string): string {
    const body = content
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return `> [${at}] 来自「${source}」\n> ${marker}\n${body}`;
  }

  /**
   * 粗估记忆条数：优先按二级标题（`## `）计数，无标题则按空行分隔的段落块计数。
   * 去重标记位于引用块首行之后、同段落内，不计入条数。
   */
  countEntries(text: string): number {
    const src = (text ?? '').trim();
    if (src === '') return 0;

    const headings = src.split('\n').filter((line) => /^##\s+/.test(line.trim())).length;
    if (headings > 0) return headings;

    return src.split(/\n\s*\n/).filter((block) => block.trim() !== '').length;
  }

  /** 汇总记忆元信息（字符数 / 条数 / 最后写入时间） */
  meta(text: string): MemoryMeta {
    const src = text ?? '';
    return {
      entries: this.countEntries(src),
      chars: src.length,
      lastWrittenAt: this.lastTimestamp(src),
    };
  }

  /** 从内容中提取最后一个 ISO 时间戳（形如 `[2025-01-01T00:00:00.000Z]`），无则 null */
  private lastTimestamp(text: string): string | null {
    const matches = (text ?? '').match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/g);
    if (!matches || matches.length === 0) return null;
    const last = matches[matches.length - 1];
    return last.slice(1, -1);
  }

  /**
   * 用 MEMORY 标签包裹记忆原文，供注入 system 段（空内容返回空串）。
   * 同时附带边界指令：记忆仅为历史会话的参考摘要，禁止被模型当作自身身份或
   * 系统指令，避免旧记忆内容覆盖当前 Agent 的 systemPrompt 人设。
   */
  wrapForInjection(text: string): string {
    const src = (text ?? '').trim();
    if (src === '') return '';
    return `${MEMORY_TAG_OPEN}\n${MEMORY_GUARD_LINE}\n${src}\n${MEMORY_TAG_CLOSE}`;
  }

  /**
   * 从已注入的 system 文本中提取记忆原文（供去重/调试）。
   * 未命中标签块时返回空串。
   */
  extractFromInjection(systemText: string): string {
    const src = systemText ?? '';
    const start = src.indexOf(MEMORY_TAG_OPEN);
    if (start === -1) return '';
    const from = start + MEMORY_TAG_OPEN.length;
    const end = src.indexOf(MEMORY_TAG_CLOSE, from);
    if (end === -1) return '';
    let body = src.slice(from, end).trim();
    // 剥离边界指令行，还原记忆原文
    if (body.startsWith(MEMORY_GUARD_LINE)) {
      body = body.slice(MEMORY_GUARD_LINE.length).trim();
    }
    return body;
  }

  /**
   * 让模型对会话历史生成 ≤150 字**分节**摘要（P1 自动沉淀用）。
   * 复用 connectionManager.getClient()，仅收集流式文本，不落任何 UI 状态。
   *
   * 返回结构化两节而不是一段文本：调用方按「身份 → L2、任务 → L3」分别落盘。
   * 失败与「没什么可记的」都收敛为两节皆空，调用方据此跳过写入。
   *
   * `opts.knownFacts` 是**已有的长期记忆全文**（通常是 `loadForInjection` 的结果）：
   * 传了它，模型才有资格判断「这条是不是已经记过」，从而不再产出改写式的重复。
   * 这是对抗重复的主要手段——`append` 的近似判定只能挡住机械重复，而重复真正
   * 的形态是「同一件事换一种措辞」（见 `isSameStatement` 的实测表）。
   * 为空则不附加那段上下文，避免白白多付一段 prompt。
   *
   * 入口两道防污染守卫（P1）：剔除像系统报错的历史条目、要求至少有一次有效回答；
   * 出口还有 `parseSummary` 的报错判定兜底。三道都返回「两节皆空」，
   * 调用方无需区分「没内容」与「被拦下」——两者都不该写进长期记忆。
   */
  async summarize(
    history: ChatMessageParam[],
    opts: { knownFacts?: string } = {},
  ): Promise<StructuredSummary> {
    const empty: StructuredSummary = { identity: '', task: '' };
    const dialogue = (history ?? []).filter(
      (m) =>
        m.role !== 'system' &&
        m.content.trim() !== '' &&
        // 被网关当作 content 吐出的报错不是对话内容（见 looksLikeSystemError）。
        // 剔除而不是整段放弃：一段几十轮的对话可能只有最后一轮撞上报错，
        // 前面的有效内容不该跟着一起丢。
        !looksLikeSystemError(m.content),
    );
    if (dialogue.length === 0) return empty;

    // 一次有效回答都没有的会话不值得归纳。触发路径很具体：用户提问 → provider
    // 报错 → 助手消息没有正文（或正文就是报错、已被上面剔除）→ 只剩用户提问。
    // 此时归纳出来的只会是「用户问了自己叫什么」这类零价值内容，
    // 而它一旦落盘就是永久的长期记忆。
    if (!dialogue.some((m) => m.role === 'assistant')) return empty;

    const known = (opts.knownFacts ?? '').trim();
    const systemPrompt =
      known === ''
        ? SUMMARY_SYSTEM_PROMPT
        : [
            SUMMARY_SYSTEM_PROMPT,
            '',
            KNOWN_FACTS_HEADING,
            known,
            '',
            KNOWN_FACTS_RULES,
          ].join('\n');

    const messages: ChatMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...dialogue,
    ];
    const req: ChatRequest = { agentId: '', messages, stream: true };

    let text = '';
    let errored = false;
    try {
      const client = await connectionManager.getClient();
      await client.chat(req, {
        onToken: (chunk) => {
          text += chunk;
        },
        onToolCall: () => undefined,
        onArtifact: () => undefined,
        onStatus: () => undefined,
        onDone: () => undefined,
        // 上报过错误的流，已累积的 text 不可信（可能前半截是正常内容、后半截是
        // 报错），整段丢弃比带着污染落盘安全。抛错路径同样收敛到「两节皆空」。
        onError: () => {
          errored = true;
        },
      });
    } catch {
      return empty;
    }
    if (errored) return empty;

    return parseSummary(text);
  }
}

/** MemoryService 单例（UI / store 一律用这个实例，禁止 new） */
export const MemoryService = new MemoryServiceImpl();
