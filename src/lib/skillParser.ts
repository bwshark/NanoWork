import type { Skill, SkillSource } from '@/types';
import { genId } from './id';

/**
 * 简易 YAML frontmatter 解析。
 * 仅取顶层标量 key，metadata.xxx 会扁平化为 `metadata.xxx`。
 */
function parseFrontMatter(text: string): Record<string, string> {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return {};
  const result: Record<string, string> = {};
  let inMetadata = false;
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = line.match(/^(\s*)([\w.]+):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, raw] = m;
    const value = raw.replace(/^["']|["']$/g, '').trim();
    if (indent.length === 0) {
      inMetadata = key === 'metadata';
      result[key] = value;
    } else if (inMetadata || key.startsWith('metadata.')) {
      result[`metadata.${key.replace(/^metadata\./, '')}`] = value;
    }
  }
  return result;
}

/**
 * 从 SKILL.md 文本解析出一个技能对象。
 * @param text SKILL.md 完整内容
 * @param fallbackName 解析失败时回退使用的名称
 * @param source 技能来源
 */
export function parseSkillFromMarkdown(
  text: string,
  fallbackName = '本地技能',
  source: SkillSource = 'local',
): Skill {
  const fm = parseFrontMatter(text);
  const id = ((fm.name as string) ?? genId()).replace(/\s+/g, '-').toLowerCase();
  const name = (fm.name as string) || fallbackName.replace(/\.md$/, '');
  const description =
    ((fm.description_zh as string) || (fm.description as string) || '').trim() ||
    '用户本地安装的技能';
  const rawCategory = (fm['metadata.category'] as string) ?? 'other';
  const category = rawCategory.charAt(0).toUpperCase() + rawCategory.slice(1);
  const version = (fm.version as string) ?? '0.1.0';
  const prompt = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();

  return {
    id,
    name,
    description,
    category,
    icon: '📦',
    prompt: prompt.slice(0, 8000),
    source,
    enabled: true,
    version,
    installedAt: new Date().toISOString(),
  };
}
