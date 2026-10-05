/**
 * 内置专家目录（`src/ai/builtinAgents.ts`）的结构与覆盖一致性。
 *
 * 为什么值得单独钉：这份目录是**代码即真源**——它决定了所有用户开箱看到什么。
 * 而 PRD FR-2.3 明确要求内置「招聘 / 法务 / 投研 / 财务 / 写作」模板，
 * 实际长期只有通用/文档/数据/牧场 4 条，**没有任何测试或类型会因此报错**：
 * 少一个模板只是「用户看不到那个专家」，谁也不会发现。
 * 所以这里既钉结构不变量，也钉「PRD 点名的模板确实在」。
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENTS } from '@/ai/builtinAgents';

describe('内置目录的结构不变量', () => {
  it('id 唯一且都带 builtin: 前缀', () => {
    const ids = BUILTIN_AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith('builtin:')).toBe(true);
  });

  it('每条都有名字与非空系统提示词', () => {
    for (const a of BUILTIN_AGENTS) {
      expect(a.name.trim(), `${a.id} 缺名字`).not.toBe('');
      // 空提示词等于「这个专家没有任何人设」，用户在列表里看到它却什么都得不到
      expect(a.systemPrompt.trim(), `${a.id} 缺系统提示词`).not.toBe('');
    }
  });

  it('都声明 source=builtin（mergeAgents 据此判定不可删）', () => {
    for (const a of BUILTIN_AGENTS) expect(a.source).toBe('builtin');
  });

  it('都不绑定模型', () => {
    // 内置模板面向所有人：绑死一个模型会让「换个预设」变成「改四个内置条目」，
    // 而且用户删掉那个预设后这些专家会一起静默回落（引擎收到未知预设直接报错）。
    // 要绑模型应当是用户在编辑里自己做的决定。
    for (const a of BUILTIN_AGENTS) expect(a.model, `${a.id} 不该绑模型`).toBeUndefined();
  });
});

describe('FR-2.3 点名的内置模板', () => {
  const has = (id: string) => BUILTIN_AGENTS.some((a) => a.id === id);

  it('招聘 / 法务 / 投研 / 财务 四类都在', () => {
    expect(has('builtin:hr'), '缺招聘专家').toBe(true);
    expect(has('builtin:legal'), '缺法务专家').toBe(true);
    expect(has('builtin:invest'), '缺投研专家').toBe(true);
    expect(has('builtin:finance'), '缺财务专家').toBe(true);
  });

  it('写作由「文档写作专家」承担', () => {
    expect(has('builtin:doc')).toBe(true);
  });

  it('投研与法务写明能力边界（不构成投资建议 / 法律意见）', () => {
    // 这两类输出的误用代价最高，边界必须写在**提示词里**（会真正进模型上下文），
    // 而不是只存在于产品文档里
    const invest = BUILTIN_AGENTS.find((a) => a.id === 'builtin:invest');
    const legal = BUILTIN_AGENTS.find((a) => a.id === 'builtin:legal');
    expect(invest?.systemPrompt).toContain('不构成投资建议');
    expect(legal?.systemPrompt).toContain('不构成法律意见');
  });
});
