/**
 * Artifact 启发式提取器。
 *
 * 背景：nanobot 当前 /v1/chat/completions 仅返回纯文本（delta.content），
 * 不携带 artifact 事件。为对标 WorkBuddy 的「富产物内联渲染」，本模块在
 * 客户端对 assistant 最终文本做轻量启发式提取——识别常见的围栏代码块：
 *   - ```mermaid   → mermaid 图
 *   - ```html      → html 片段
 *   - ```<lang>    → code（语言高亮）
 *   - ```（无语言）→ code（纯文本）
 * 提取出的每个块转为 ArtifactEvent 交给上层渲染。
 *
 * 设计原则：
 *   - 纯函数、可单测、无副作用；
 *   - 仅在流结束后对完整文本跑一次（避免流式中间态误判）；
 *   - 不修改原文，仅派生产物（原文仍照常显示）。
 */

import type { ArtifactEvent } from '../types';
import { genId } from '@/lib/core/id';

/** 围栏块匹配：```lang\n ... \n``` 或 ```\n ... \n``` */
const FENCE_RE = /```([a-zA-Z0-9+#-]*)\n([\s\S]*?)```/g;

/** 语言关键字 → ArtifactType 映射 */
function mapType(lang: string): { type: ArtifactEvent['type']; language?: string } {
  const l = lang.toLowerCase();
  if (l === 'mermaid') return { type: 'mermaid' };
  if (l === 'html' || l === 'xml') return { type: 'html', language: 'html' };
  if (l === 'svg') return { type: 'svg' };
  if (l === 'markdown' || l === 'md') return { type: 'markdown' };
  if (l) return { type: 'code', language: l };
  return { type: 'code' };
}

function titleFor(type: ArtifactEvent['type'], lang: string | undefined, index: number): string {
  switch (type) {
    case 'mermaid':
      return `流程图 ${index}`;
    case 'html':
      return `HTML 片段 ${index}`;
    case 'svg':
      return `SVG 图形 ${index}`;
    case 'markdown':
      return `Markdown 文档 ${index}`;
    default:
      return `代码块 (${lang || 'text'}) ${index}`;
  }
}

/**
 * 从完整 assistant 文本提取围栏代码块产物。
 * 返回 ArtifactEvent[]（可能为空）。每个事件带独立 id，便于上层去重与渲染。
 */
export function extractArtifacts(text: string): ArtifactEvent[] {
  if (!text || !text.includes('```')) return [];
  const out: ArtifactEvent[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text)) !== null) {
    idx += 1;
    const lang = (m[1] ?? '').trim();
    const content = m[2].replace(/\n$/, '');
    const { type, language } = mapType(lang);
    out.push({
      id: genId(),
      type,
      title: titleFor(type, lang || undefined, idx),
      content,
      language,
    });
  }
  return out;
}
