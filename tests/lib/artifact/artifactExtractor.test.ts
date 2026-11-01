import { describe, expect, it } from 'vitest';
import { extractArtifacts } from '@/ai/runtime/nanobotHttp/artifactExtractor';

/**
 * 围栏 → 产物的语言判据。
 *
 * 这里锁的是**两条互不重叠的口径**：
 * - `language` 必须归一化（渲染高亮与下载扩展名都读它），
 * - `title` 必须保留**原始围栏名**（「模型写的是哪种围栏」这件事不能丢）。
 */

describe('extractArtifacts：语言归一化，标题保留原文', () => {
  it('产品围栏（nanowork-expert）内容按 json 着色，标题仍是原始围栏名', () => {
    const [artifact] = extractArtifacts('```nanowork-expert\n{"kind":"agent"}\n```');
    expect(artifact.type).toBe('code');
    expect(artifact.language).toBe('json');
    expect(artifact.title).toBe('代码块 (nanowork-expert) 1');
  });

  it('常见简写归一化（ts → typescript，yml → yaml）', () => {
    const [ts, yml] = extractArtifacts('```ts\nconst a = 1;\n```\n\n```yml\na: 1\n```');
    expect(ts.language).toBe('typescript');
    expect(yml.language).toBe('yaml');
  });

  it('认不出的围栏 + 正文不是 JSON → 不给 language（渲染退回纯文本，但不再假装会着色）', () => {
    const [artifact] = extractArtifacts('```whatever\n随便一段话\n```');
    expect(artifact.type).toBe('code');
    expect(artifact.language).toBeUndefined();
    // 标题照样带着模型写的那个名字，用户能看出「它是自造围栏」
    expect(artifact.title).toBe('代码块 (whatever) 1');
  });

  it('无语言围栏若正文是 JSON，同样给 json（下载才不会落成 .txt）', () => {
    const [artifact] = extractArtifacts('```\n{"a":1}\n```');
    expect(artifact.language).toBe('json');
  });
});
