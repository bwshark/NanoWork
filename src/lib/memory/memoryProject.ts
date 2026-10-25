/**
 * **投影渲染**：把 canonical 状态变成人读 / 注入用的 `MEMORY.md` 正文。
 *
 * 需求：`docs/prd-memory-v2.md` FR-M10；设计：`docs/architecture-memory-v2.md` §4.6 / 不变量 I6。
 *
 * ## 投影的地位
 *
 * `MEMORY.md` **不是权威**：权威是 `curated.json`。投影任何时候都能由 canonical 逐字节重建
 * （不变量 I6），所以：
 *
 * - 它坏掉、被人删掉、被写了一半，都可以直接重生成；
 * - 它**只渲染 active 修订**——`superseded`（被替代）/ `disabled`（被停用）/ 冲突候选
 *   **永不进投影**，更不会进 prompt（不变量 I8）；
 * - 渲染是**确定性**的：同状态同输出，字符串比较用 `<`（NFR-M12）。
 *
 * ## 为什么单独一个模块（一次真实事故）
 *
 * 这个渲染器原先散在两处，其中一处（`memory/memoryEdit.ts` 的工作区仓储）**忘了传**它。
 * 症状极具迷惑性：手编保存看起来正常——因为文件里还留着用户刚写的原文——
 * 但 `distill` 与 `rebuildProjection` 都因为「没有渲染器」而静默早退，
 * 文件其实再也不会被重建。等到用户删掉文件、或下次蒸馏想刷新投影时，
 * 内容就凭空消失。集中到一处之后，「有没有渲染器」不再是个可选项。
 */

import type { CuratedEntry, CuratedState, UserProfile } from '@/types';
import { compareStrings } from '@/lib/memory/memoryNormalize';

/** 修订 → 一行 Markdown（带轻量元信息，便于人读与诊断） */
function renderEntryLine(entry: CuratedEntry): string {
  const meta = [`r${entry.revision}`];
  if (entry.kind) meta.push(entry.kind);
  const key = entry.memoryKey && entry.memoryKey !== '' ? entry.memoryKey : entry.entryKey;
  return `- ${entry.content}　<!-- ${key} · ${meta.join(' · ')} -->`;
}

/**
 * 渲染工作区级投影。
 *
 * 顺序：`importance` 降序 → `lastSeen` 降序 → `entryKey` 升序。
 * 与注入侧的裁剪优先级一致——人看到的顺序与模型看到的顺序相同，
 * 「为什么这条没进 prompt」才不会变成一个需要猜的问题。
 */
export function renderCuratedProjection(state: CuratedState): string {
  const actives = (state?.revisions ?? []).filter(
    (r) => r.status === 'active' && typeof r.content === 'string' && r.content.trim() !== '',
  );
  if (actives.length === 0) return '';

  const sorted = [...actives].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    const at = Date.parse(a.lastSeen);
    const bt = Date.parse(b.lastSeen);
    const ta = Number.isFinite(at) ? at : 0;
    const tb = Number.isFinite(bt) ? bt : 0;
    if (tb !== ta) return tb - ta;
    return compareStrings(a.entryKey, b.entryKey);
  });

  return sorted.map(renderEntryLine).join('\n');
}

/**
 * 渲染用户画像投影（`user.md`）。
 *
 * 与 `MEMORY.md` 分开：画像是**字段**，不是「结论列表」；混在一起会让
 * 「用户是谁」与「项目怎么定」在同一份文件里抢位置。
 */
export function renderProfileProjection(profile: UserProfile): string {
  const labels: Array<[keyof UserProfile, string]> = [
    ['name', '姓名'],
    ['callThem', '称呼'],
    ['timezone', '时区'],
    ['language', '默认语言'],
    ['occupation', '职业'],
    ['organization', '所在组织'],
    ['role', '角色'],
    ['city', '常驻城市'],
    ['responseStyle', '表达偏好'],
  ];
  const lines: string[] = [];
  for (const [field, label] of labels) {
    const value = profile?.[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    lines.push(`- ${label}：${value}`);
  }
  return lines.join('\n');
}
