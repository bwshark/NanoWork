/**
 * 记忆页「保存」的完整链路：**存文件 → 补登记手编内容 → 蒸馏 → 重建投影**。
 *
 * ## 为什么保存不再只是写文件
 *
 * v2 的 `MEMORY.md` 是派生投影，`distill` 之后由 canonical 重建。如果用户手写的段落
 * 只落在文件里，下一次蒸馏就会把它**静默吃掉**——用户看到自己写的规则凭空消失，
 * 而且没有任何报错。所以保存必须顺手把那部分内容补登记成 `origin: 'manual'` 的事实
 * （`memoryManual.ts`），再由蒸馏把它们渲染回投影。
 *
 * ## 顺序是硬约束
 *
 * ```
 * 1. 读 canonical（拿到「哪些内容已经登记过」）
 * 2. 写文件（用户看到的是自己的文本，这一步先做）
 * 3. 补登记手编段落（按归一化内容 diff）
 * 4. 蒸馏（把新事实晋升为结论，并重建投影）
 * ```
 *
 * 第 1 步必须在第 2 步之前：第 2 步会覆盖 `MEMORY.md`，而第 3 步的判据要用
 * **canonical**（不是旧文件）——用旧文件当基准会把上一次蒸馏的结果误判成用户新增。
 *
 * 第 4 步失败**不影响**保存本身：用户的内容已经落盘，蒸馏失败只是「还没变成长期结论」，
 * 下一次 `distill` 会补上。所以它单独 try/catch，并把失败原因回传给调用方提示。
 */

import type { MemoryStore } from '@/lib/memoryStore';
import { createMemoryStore } from '@/lib/memoryStore';
import { platformMemoryIo, workspaceMemoryRef } from '@/lib/memoryPlatformIo';
import { CURATED_MEMORY_FILE, workspaceIdFor } from '@/lib/memoryPaths';
import { DEFAULT_DISTILL_POLICY } from '@/lib/memoryDistill';
import { extractNewManualParagraphs, manualParagraphToFactInput } from '@/lib/memoryManual';
import { renderCuratedProjection } from '@/lib/memoryProject';

/** 一次保存的结果 */
export interface ManualMemoryEditResult {
  /** 本次补登记为事实的手编段落数 */
  registered: number;
  /** 蒸馏是否成功（失败不影响保存本身） */
  distilled: boolean;
  /** 蒸馏失败原因（成功时为 null） */
  distillError: string | null;
}

/** 建一个工作区级仓储（与记忆页、注入链路共用同一份 IO、归属算法与**投影渲染器**） */
export function workspaceStoreFor(workdir: string | null): MemoryStore {
  return createMemoryStore({
    io: platformMemoryIo(workspaceMemoryRef(workdir)),
    workspaceId: workspaceIdFor(workdir),
    policy: DEFAULT_DISTILL_POLICY,
    // ⚠️ 这个渲染器**不能省**：漏掉它，`distill` 与 `rebuildProjection` 会因为
    // 「没有渲染器」而静默早退——手编保存看起来正常（文件里还留着用户刚写的原文），
    // 但投影其实再也不会被重建。实施时正是这么踩了一次。
    renderProjection: renderCuratedProjection,
  });
}

/**
 * 应用一次「记忆页手编保存」。
 *
 * ## 顺序与失败语义（两次返工换来的）
 *
 * ```
 * 1. 写文件            ← 用户的内容**先落盘**，这是他唯一在乎的事
 * 2. 读 canonical      ← 为了知道「哪些内容已经登记过」；读不出来就当作空（下面的取舍）
 * 3. 补登记手编段落
 * 4. 蒸馏              ← 失败不回滚保存
 * ```
 *
 * **第 1 步在第 2 步之前**：早先的版本先读 canonical，于是 `curated.json` 一旦损坏
 * （半截 JSON / 手工改坏），用户在编辑器里写的东西**一个字都存不下去**——他明明只是
 * 想加一条笔记，却被告知记忆坏了。现在最坏情况是「文件存下了、但没登记成事实」，
 * 那是可恢复的（下次保存会补）。
 *
 * **canonical 读不出来时按空处理**：代价是可能把已在 canonical 的段落再登记一次。
 * 但存储层的按 `factId` / 归一化去重会挡住真正的重复，而「丢用户输入」不可挽回——
 * 两者不对等，所以选前者。
 *
 * @param workdir 目标工作区（`null` 表示没有绑定工作目录 → 落兜底目录）
 * @param savedText 用户保存后的**完整文件正文**
 * @param now 显式时间（测试与确定性都靠它）
 * @param observedAt 手编事实的**观测时刻**；缺省取 `now`。
 *   允许显式指定，是因为用户往记忆里补写一条「早就成立的约定」是真实场景
 *   （例如把团队既有规范抄进来）。它同时决定了蒸馏的年龄门槛——不指定就等于
 *   「今天才写下」，30 天后才会晋升为长期结论。
 */
export async function applyManualMemoryEdit(
  workdir: string | null,
  savedText: string,
  now: Date,
  observedAt?: string,
): Promise<ManualMemoryEditResult> {
  const store = workspaceStoreFor(workdir);

  // ① 写文件（用户看到的是自己的文本）——先做，且它的失败才是「保存失败」
  await platformMemoryIo(workspaceMemoryRef(workdir)).write(
    CURATED_MEMORY_FILE,
    savedText.trim() === '' ? '' : savedText,
  );

  // ② 读 canonical：才是「已经登记过什么」的权威；读不出来按空处理（见上面的取舍）
  let known: Awaited<ReturnType<MemoryStore['loadCuratedState']>>['revisions'] = [];
  try {
    known = (await store.loadCuratedState()).revisions;
  } catch {
    known = [];
  }

  // ③ 补登记手编段落
  const paragraphs = extractNewManualParagraphs(savedText, known);
  const at = observedAt ?? now.toISOString();
  let registered = 0;
  for (const paragraph of paragraphs) {
    try {
      const outcome = await store.appendFact(
        manualParagraphToFactInput(paragraph, workspaceIdFor(workdir), at),
        now,
      );
      if (outcome === 'written') registered += 1;
    } catch {
      // 单条不该写（超长、像报错等）时跳过，其余照常登记
    }
  }

  // ④ 蒸馏：把事实晋升为结论并重建投影。失败不回滚保存。
  try {
    await store.distill(now);
    return { registered, distilled: true, distillError: null };
  } catch (e) {
    return {
      registered,
      distilled: false,
      distillError: e instanceof Error ? e.message : String(e),
    };
  }
}
