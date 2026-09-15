import type { ExpertGroup } from '@/types';

/**
 * 内置专家团目录：随应用发布（source='builtin'），代码为真源。
 * store 通过 mergeGroups 合并持久化数据——保留用户覆盖的启用状态与成员顺序，
 * 其余字段（名称/描述/协作模式）以代码版本为准（升级即生效）。
 */
export const BUILTIN_GROUPS: ExpertGroup[] = [
  {
    id: 'builtingroup:software',
    name: '软件研发',
    role: 'Software',
    description:
      '软件研发专家团队，精通多种编程语言和框架，覆盖后端、前端、数据库与 DevOps，交付可运行的高质量代码。',
    memberIds: ['builtin:general', 'builtin:doc'],
    mode: 'sequential',
    icon: '💻',
    enabled: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    source: 'builtin',
  },
  {
    id: 'builtingroup:data',
    name: '数据分析',
    role: 'Data',
    description:
      '数据分析专家团队，擅长读取数据、清洗、统计与可视化，以图表与结论的形式汇报关键发现。',
    memberIds: ['builtin:data', 'builtin:general'],
    mode: 'parallel',
    icon: '📊',
    enabled: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    source: 'builtin',
  },
  {
    id: 'builtingroup:content',
    name: '内容创作',
    role: 'Content',
    description:
      '内容创作专家团队，将复杂内容整理为结构化、可读性强的文档与报告，并配以精准的图文表达。',
    memberIds: ['builtin:doc', 'builtin:general'],
    mode: 'coordinator',
    icon: '✍️',
    enabled: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    source: 'builtin',
  },
  {
    id: 'builtingroup:ranch',
    name: '牧场数据',
    role: 'Ranch',
    description:
      '牧场数据专家团队，精通牛只养殖管理、牧场 GIS 可视化、畜群健康监测与饲喂优化，结合实时数据给出专业建议。',
    memberIds: ['builtin:ranch', 'builtin:data'],
    mode: 'coordinator',
    icon: '🐄',
    enabled: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    source: 'builtin',
  },
];
