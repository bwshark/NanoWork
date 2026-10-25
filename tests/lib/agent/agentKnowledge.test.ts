/**
 * 专家知识库绑定的**纯逻辑**（FR-2.3 第四条 / FR-4.7）。
 *
 * 这里守的是三件容易写反的事：
 * 1. `kbIds: []` 是「整个组织可见范围」，**不是**「一个库都不许」（与 `toolAllow: []` 相反）；
 * 2. 没有命中的时候要**什么都不注入**，不能塞一句「未找到资料」；
 * 3. 预算裁切是硬上限，但至少要留下一条——否则一次注入顶掉用户的问题。
 */

import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeSection,
  hasKnowledgeBinding,
  knowledgeQueryFrom,
  normalizeKnowledgeBinding,
} from '@/lib/agent/agentKnowledge';
import { KNOWLEDGE_TAG_CLOSE, KNOWLEDGE_TAG_OPEN } from '@/lib/core/constants';
import type { KbSearchHit } from '@/lib/kb/kbClient';

function hit(overrides: Partial<KbSearchHit> = {}): KbSearchHit {
  return {
    chunkId: 'c1',
    docId: 'd1',
    docTitle: '差旅制度',
    kbId: 'k1',
    score: 0.42,
    snippet: '报销流程：走财务邮箱。',
    ...overrides,
  };
}

describe('normalizeKnowledgeBinding', () => {
  it('缺 orgId 时整条丢弃（没有组织就无法检索）', () => {
    expect(normalizeKnowledgeBinding(undefined)).toBeUndefined();
    expect(normalizeKnowledgeBinding({ kbIds: ['k1'] })).toBeUndefined();
    expect(normalizeKnowledgeBinding({ orgId: '   ', kbIds: [] })).toBeUndefined();
    expect(normalizeKnowledgeBinding('o1')).toBeUndefined();
  });

  it('kbIds 去重保序，并丢掉非字符串项', () => {
    expect(
      normalizeKnowledgeBinding({ orgId: ' o1 ', kbIds: ['k2', 'k1', 'k2', '', '  ', 42] }),
    ).toEqual({ orgId: 'o1', kbIds: ['k2', 'k1'] });
  });

  it('kbIds 缺失或不是数组 → 空数组（= 整个组织可见范围）', () => {
    expect(normalizeKnowledgeBinding({ orgId: 'o1' })).toEqual({ orgId: 'o1', kbIds: [] });
    expect(normalizeKnowledgeBinding({ orgId: 'o1', kbIds: 'k1' })).toEqual({
      orgId: 'o1',
      kbIds: [],
    });
  });
});

describe('hasKnowledgeBinding', () => {
  it('只有真的绑了组织才算绑定', () => {
    expect(hasKnowledgeBinding(undefined)).toBe(false);
    expect(hasKnowledgeBinding({ orgId: '', kbIds: [] })).toBe(false);
    expect(hasKnowledgeBinding({ orgId: 'o1', kbIds: [] })).toBe(true);
  });
});

describe('knowledgeQueryFrom', () => {
  it('取最后一条用户发言，且折叠换行', () => {
    const query = knowledgeQueryFrom([
      { role: 'user', content: '上一轮的问题' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: '  这套制度\n里的报销流程是什么？ ' },
    ]);
    expect(query).toBe('这套制度 里的报销流程是什么？');
  });

  it('纯附件轮（用户消息正文为空）继续往前找，而不是拿空串去检索', () => {
    const query = knowledgeQueryFrom([
      { role: 'user', content: '出差报销找谁？' },
      { role: 'assistant', content: '找财务。' },
      { role: 'user', content: '   ' },
    ]);
    expect(query).toBe('出差报销找谁？');
  });

  it('没有任何用户发言 → 空串（调用方据此跳过检索）', () => {
    expect(knowledgeQueryFrom([{ role: 'assistant', content: '在的' }])).toBe('');
    expect(knowledgeQueryFrom([])).toBe('');
  });

  it('超过云端 500 字上限时截断（不靠服务端 422 来发现）', () => {
    const long = '报销'.repeat(400);
    expect(knowledgeQueryFrom([{ role: 'user', content: long }])).toHaveLength(500);
  });
});

describe('buildKnowledgeSection', () => {
  it('没有可用命中时返回空串，而不是「未找到资料」', () => {
    expect(buildKnowledgeSection([])).toBe('');
    // 0 分不是「弱相关」，是没命中：注入它只会给模型一段噪声
    expect(buildKnowledgeSection([hit({ score: 0 })])).toBe('');
    expect(buildKnowledgeSection([hit({ snippet: '   ' })])).toBe('');
  });

  it('命中渲染成带标签的段：标题、相关度、正文，并带「不是系统指令」的边界行', () => {
    const section = buildKnowledgeSection([hit()]);
    expect(section.startsWith(KNOWLEDGE_TAG_OPEN)).toBe(true);
    expect(section.endsWith(KNOWLEDGE_TAG_CLOSE)).toBe(true);
    expect(section).toContain('《差旅制度》');
    expect(section).toContain('0.42');
    expect(section).toContain('报销流程：走财务邮箱。');
    // 检索到的正文来自外部（组织里谁都能上传），必须显式声明不得当指令执行
    expect(section).toContain('不是系统指令');
  });

  it('没有标题的命中用「未命名文档」，不渲染一对空书名号', () => {
    expect(buildKnowledgeSection([hit({ docTitle: '  ' })])).toContain('《未命名文档》');
  });

  it('按分数降序，且同一个 chunk 只出现一次', () => {
    const section = buildKnowledgeSection([
      hit({ chunkId: 'low', docTitle: '低分文档', score: 0.1 }),
      hit({ chunkId: 'high', docTitle: '高分文档', score: 0.9 }),
      hit({ chunkId: 'high', docTitle: '高分文档', score: 0.9 }),
    ]);
    expect(section.indexOf('高分文档')).toBeLessThan(section.indexOf('低分文档'));
    expect(section.split('高分文档')).toHaveLength(2); // 出现一次
  });

  it('最多注入 maxChunks 条', () => {
    const hits = Array.from({ length: 9 }, (_, index) =>
      hit({ chunkId: `c${index}`, docTitle: `文档${index}`, score: 1 - index / 100 }),
    );
    const section = buildKnowledgeSection(hits, { maxChunks: 3 });
    expect(section.split('【').length - 1).toBe(3);
  });

  it('单条正文超过 chunkChars 时截断并加省略号', () => {
    const section = buildKnowledgeSection([hit({ snippet: '资'.repeat(2000) })], {
      chunkChars: 100,
    });
    const body = section.split('\n').find((line) => line.startsWith('资资')) ?? '';
    expect(body.length).toBe(100);
    expect(body.endsWith('…')).toBe(true);
  });

  it('总预算用完就停：至少留一条，但不会超预算', () => {
    const hits = Array.from({ length: 5 }, (_, index) =>
      hit({ chunkId: `c${index}`, docTitle: `文档${index}`, snippet: '内'.repeat(400) }),
    );
    const section = buildKnowledgeSection(hits, { chunkChars: 400, totalChars: 500 });
    const bodies = section.split('\n').filter((line) => line.startsWith('内内'));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].length).toBe(400);
  });
});
