import type { Skill } from '@/types';

/**
 * 内置技能目录（FR-003）。
 * 这些技能随应用发布，source 为 'builtin'，可在设置中启用/停用。
 * 在对话中挂载后，其 prompt 会拼接到 user 消息前生效。
 */
export const SKILLS: Skill[] = [
  {
    id: 'web-search',
    name: '联网搜索',
    description: '调用搜索引擎检索最新网页结果，返回结构化摘要与来源链接。',
    category: '检索',
    icon: '🔍',
    source: 'builtin',
    enabled: true,
    version: '1.0.0',
    prompt:
      '你具备联网搜索能力。当用户问题需要最新信息或外部资料时，请先进行搜索，然后基于搜索结果给出结构化回答，并在末尾列出参考来源链接。如果问题不需要外部信息，直接回答即可。',
  },
  {
    id: 'web-fetch',
    name: '网页抓取',
    description: '抓取指定 URL 正文并提炼为可读摘要，适合长文整理。',
    category: '检索',
    icon: '🌐',
    source: 'builtin',
    enabled: true,
    version: '1.0.0',
    prompt:
      '当用户提供了 URL 或要求抓取网页时，请扮演网页摘要助手：提取标题、核心观点、关键段落，并以 Markdown 形式输出摘要。若未提供 URL，请提示用户粘贴链接。',
  },
  {
    id: 'image-gen',
    name: '图像生成',
    description: '根据文本提示生成配图，返回可预览的图片产物。',
    category: '创作',
    icon: '🎨',
    source: 'builtin',
    enabled: true,
    version: '1.0.0',
    prompt:
      '当用户请求生成图片时，请优化用户的描述并生成一段高质量图像提示词（prompt），然后调用图像生成工具完成绘制。输出结果时附上图产物的预览与 prompt 原文。',
  },
  {
    id: 'files',
    name: '文件读写',
    description: '读取或写入工作区文件（敏感操作，需权限确认）。',
    category: '系统',
    icon: '📁',
    source: 'builtin',
    enabled: true,
    version: '1.0.0',
    prompt:
      '你具备文件读写能力。当用户要求读取、创建或修改文件时，先确认目标路径与操作意图，需要时请求用户授权，然后执行并返回操作结果摘要。',
  },
  {
    id: 'shell',
    name: '终端命令',
    description: '执行本地 shell 命令（敏感操作，需权限确认）。',
    category: '系统',
    icon: '⌨️',
    source: 'builtin',
    enabled: false,
    version: '1.0.0',
    prompt:
      '你具备本地终端命令执行能力。当用户需要运行命令时，先展示要执行的命令并请求确认，执行后返回退出码、标准输出与标准错误。',
  },
  {
    id: 'memory',
    name: '长期记忆',
    description: '读写 MEMORY.md / USER.md，注入会话上下文（P1 预留）。',
    category: '记忆',
    icon: '🧠',
    source: 'builtin',
    enabled: false,
    version: '1.0.0',
    prompt:
      '你具备长期记忆能力。在回答问题时，请优先参考已注入的记忆上下文；如果用户要求记录新信息，请整理为 concise 的条目并建议写入记忆文件。',
  },
  {
    id: 'code-run',
    name: '代码执行',
    description: '在沙箱中运行代码片段并返回输出。',
    category: '开发',
    icon: '💻',
    source: 'builtin',
    enabled: true,
    version: '1.0.0',
    prompt:
      '你具备代码执行能力。当用户要求运行代码时，先在沙箱中执行并返回输出结果；如果执行失败，请给出可能的修复建议。',
  },
  {
    id: 'doc-write',
    name: '文档写作',
    description: '生成结构化 Markdown 文档、报告与周报。',
    category: '创作',
    icon: '📝',
    source: 'builtin',
    enabled: true,
    version: '1.0.0',
    prompt:
      '你是一位技术文档写作助手。当用户要求写文档、报告或周报时，请使用 Markdown 输出结构化内容，包含标题、章节、列表与总结。',
  },
  {
    id: 'agent-app',
    name: 'Agent 应用',
    description: '帮助设计 Agent 工作流、选择架构并编写系统提示词。',
    category: 'Agent 应用',
    icon: '🤖',
    source: 'builtin',
    enabled: true,
    version: '1.0.0',
    prompt:
      '你是一位 Agent 应用设计师。帮助用户梳理业务场景、选择合适的 Agent 架构（ReAct / Plan-Act / Multi-Agent），并编写清晰的系统提示词与工具调用流程。',
  },
  {
    id: 'skill-dev',
    name: 'Skill 开发',
    description: '辅助编写符合 WorkBuddy 规范的 SKILL.md 技能文件。',
    category: 'Skill 开发',
    icon: '🛠️',
    source: 'builtin',
    enabled: true,
    version: '1.0.0',
    prompt:
      '你是 Skill 开发专家。帮助用户设计可复用的 SKILL.md：包含触发条件、实施步骤、涉及文件、验证命令与注意事项，输出可直接落地的技能文档。',
  }
];
