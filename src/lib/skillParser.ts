import type { Skill, SkillSource, SkillScope } from '@/types';
import { genId } from './id';

/**
 * 简易 YAML frontmatter 解析。
 * 仅取顶层标量 key，metadata.xxx 会扁平化为 `metadata.xxx`；
 * 块状列表（`key:` 换行后若干 `- item`）会以逗号拼回同一个 key。
 *
 * 刻意不引 yaml 库：SKILL.md 的 frontmatter 只用到标量 + 短列表，
 * 而解析器要在渲染进程同步可用（技能列表是首屏渲染的一部分）。
 */
function parseFrontMatter(text: string): Record<string, string> {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return {};
  const result: Record<string, string> = {};
  let inMetadata = false;
  /** 上一个「值为空」的顶层 key —— 随后的 `- item` 行都归它 */
  let openListKey: string | null = null;
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // 块状列表项：挂在最近一个「值为空」的 key 上
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && openListKey) {
      const value = item[1].replace(/^["']|["']$/g, '').trim();
      if (value) {
        result[openListKey] = result[openListKey]
          ? `${result[openListKey]},${value}`
          : value;
      }
      continue;
    }

    // key 允许连字符：`allowed-tools` / `user-invocable` 都是合法字段名，
    // 只认 \w 会把它们整行丢掉（静默失效比报错更难查）
    const m = line.match(/^(\s*)([\w.-]+):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, raw] = m;
    const value = raw.replace(/^["']|["']$/g, '').trim();
    if (indent.length === 0) {
      inMetadata = key === 'metadata';
      result[key] = value;
      openListKey = value === '' ? key : null;
    } else if (inMetadata || key.startsWith('metadata.')) {
      result[`metadata.${key.replace(/^metadata\./, '')}`] = value;
    }
  }
  return result;
}

/** frontmatter 里的列表字段 → 字符串数组；空值一律返回 undefined 而不是空数组 */
function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * frontmatter 里的布尔字段。
 * 只有明确的 falsy 写法才算 false——**缺省一律按 true 处理**：
 * `user-invocable` 的语义是「默认可由用户调用」，写错的取值不该把技能
 * 从用户入口里悄悄摘掉（那和 `off` 档撞车，而这是另一件事）。
 */
function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  return fallback;
}

export interface ParseSkillOptions {
  /** 解析失败时回退使用的名称 */
  fallbackName?: string;
  /** 技能来源 */
  source?: SkillSource;
  /** 发现层级（目录扫描结果带上；上传单个 .md 时不带） */
  scope?: SkillScope;
  /** 技能所在目录（目录扫描结果带上） */
  path?: string;
}

/**
 * 从 SKILL.md 文本解析出一个技能对象。
 */
export function parseSkillFromMarkdown(
  text: string,
  fallbackName = '本地技能',
  source: SkillSource = 'local',
  extra: Omit<ParseSkillOptions, 'fallbackName' | 'source'> = {},
): Skill {
  const fm = parseFrontMatter(text);
  const rawName = (fm.name as string) || '';
  const id = (rawName || genId()).replace(/\s+/g, '-').toLowerCase();
  const name = rawName || fallbackName.replace(/\.md$/, '');
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
    // override/enabled 的初值由 store 统一派生（见 skillOverrides.ts）。
    // 这里给 `on` 只是为了让单独构造的对象自洽，不代表"用户已选择启用"。
    override: 'on',
    enabled: true,
    allowedTools: parseList(fm['allowed-tools']),
    userInvocable: parseBoolean(fm['user-invocable'], true),
    version,
    scope: extra.scope,
    path: extra.path,
    installedAt: new Date().toISOString(),
  };
}
