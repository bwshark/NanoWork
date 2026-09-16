import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryService, isEmptySummary, memoryDiskPath, parseSummary, workspaceKeyFor } from '@/lib/memory';
import { parseMemoryDirectives, stripMemoryDirectives } from '@/lib/memoryDirective';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { MEMORY_KEY_PREFIX } from '@/lib/constants';
import { platform } from '@/platform';

/** 重置 settings 到初始态，避免跨用例串扰 */
function resetSettings() {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      memoryEnabled: true,
      autoSummarize: false,
      transcription: DEFAULT_TRANSCRIPTION,
      desktop: DEFAULT_DESKTOP,
    },
    status: 'offline',
  });
}

const STORAGE_KEY = `${MEMORY_KEY_PREFIX}default`;

beforeEach(() => {
  // setup.ts 已清空 localStorage；这里再确保 settings 干净
  resetSettings();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe('MemoryService: 基本读写 (T22~T24)', () => {
  it('save 覆盖写后 load 返回新值', async () => {
    await MemoryService.save('初始记忆内容');
    expect(await MemoryService.load()).toBe('初始记忆内容');

    await MemoryService.save('新的记忆内容');
    expect(await MemoryService.load()).toBe('新的记忆内容');
  });

  it('clear 后 load 返回空串', async () => {
    await MemoryService.save('待清空的内容');
    await MemoryService.clear();
    expect(await MemoryService.load()).toBe('');
  });

  it('load 从未写入时返回空串（不抛错）', async () => {
    expect(await MemoryService.load()).toBe('');
  });
});

describe('MemoryService: append 与引用块格式 (T25)', () => {
  it('append 后 load 能读回，且引用块格式正确', async () => {
    const at = '2025-01-01T00:00:00.000Z';
    await MemoryService.append('用户偏好使用中文回复', { source: '会话A', at });

    const text = await MemoryService.load();
    expect(text).toContain(`> [${at}] 来自「会话A」`);
    expect(text).toContain('> 用户偏好使用中文回复');
  });

  it('append 多行正文逐行生成引用', async () => {
    await MemoryService.append('第一行\n第二行', { source: 's', at: '2025-02-02T00:00:00.000Z' });
    const text = await MemoryService.load();
    expect(text).toContain('> 第一行');
    expect(text).toContain('> 第二行');
  });

  it('空内容 append 被忽略，不写入任何内容', async () => {
    await MemoryService.append('   ', { source: 's' });
    expect(await MemoryService.load()).toBe('');
  });

  it('连续 append 以空行分隔拼接多个引用块', async () => {
    await MemoryService.append('内容一', { source: 's1', at: '2025-03-03T00:00:00.000Z' });
    await MemoryService.append('内容二', { source: 's2', at: '2025-03-04T00:00:00.000Z' });

    const text = await MemoryService.load();
    // 两个引用块各自独立
    expect(text).toContain('> 内容一');
    expect(text).toContain('> 内容二');
    expect(text).toContain('来自「s1」');
    expect(text).toContain('来自「s2」');
    // 以空行分隔：出现两次 `>\n\n>` 结构
    expect(text.split('\n\n').length).toBeGreaterThanOrEqual(2);
  });

  it('默认 source 在缺失时回退为「手动保存」', async () => {
    await MemoryService.append('手动记录', { at: '2025-03-05T00:00:00.000Z' });
    const text = await MemoryService.load();
    expect(text).toContain('来自「手动保存」');
  });
});

describe('MemoryService: countEntries 计数 (T26)', () => {
  it('空文本计数为 0', () => {
    expect(MemoryService.countEntries('')).toBe(0);
    expect(MemoryService.countEntries('   \n  ')).toBe(0);
  });

  it('按引用块（空行分隔段落）计数普通追加内容', async () => {
    await MemoryService.append('块一', { source: 's1', at: '2025-04-01T00:00:00.000Z' });
    await MemoryService.append('块二', { source: 's2', at: '2025-04-02T00:00:00.000Z' });
    const text = await MemoryService.load();
    expect(MemoryService.countEntries(text)).toBe(2);
  });

  it('按 ## 二级标题优先计数', () => {
    const doc = '## 决策\n正文\n\n## 偏好\n正文2';
    expect(MemoryService.countEntries(doc)).toBe(2);
  });
});

describe('MemoryService: wrapForInjection / extractFromInjection (T27)', () => {
  it('wrapForInjection 空串返回空', () => {
    expect(MemoryService.wrapForInjection('')).toBe('');
    expect(MemoryService.wrapForInjection('   ')).toBe('');
  });

  it('wrapForInjection 非空返回带标签包裹', () => {
    const wrapped = MemoryService.wrapForInjection('记忆正文');
    expect(wrapped).toContain('<!-- MEMORY -->');
    expect(wrapped).toContain('<!-- /MEMORY -->');
    expect(wrapped).toContain('记忆正文');
  });

  it('extractFromInjection 能从包裹文本还原原文', () => {
    const original = '> [2025-05-05T00:00:00.000Z] 来自「s」\n> 内容';
    const wrapped = MemoryService.wrapForInjection(original);
    expect(MemoryService.extractFromInjection(wrapped)).toBe(original);
  });

  it('extractFromInjection 无标签时返回空串', () => {
    expect(MemoryService.extractFromInjection('没有任何记忆标签的文本')).toBe('');
  });

  it('extractFromInjection 从混合 system 文本中提取记忆块', () => {
    const original = '> 记忆A';
    const systemText = `你是助手。\n<!-- MEMORY -->\n${original}\n<!-- /MEMORY -->\n请遵守规范。`;
    expect(MemoryService.extractFromInjection(systemText)).toBe(original);
  });
});

describe('MemoryService: meta 元信息 (T26)', () => {
  it('meta 返回正确的 entries/chars/lastWrittenAt', async () => {
    const at = '2025-06-06T00:00:00.000Z';
    await MemoryService.append('一条记忆', { source: 's', at });
    const text = await MemoryService.load();
    const m = MemoryService.meta(text);

    expect(m.entries).toBe(1);
    expect(m.chars).toBe(text.length);
    expect(m.lastWrittenAt).toBe(at);
  });

  it('meta 在无时间戳内容时 lastWrittenAt 为 null', () => {
    const m = MemoryService.meta('## 标题\n一段没有时间戳的内容');
    expect(m.lastWrittenAt).toBeNull();
  });

  it('meta 对空文本返回 entries=0/lastWrittenAt=null', () => {
    const m = MemoryService.meta('');
    expect(m.entries).toBe(0);
    expect(m.chars).toBe(0);
    expect(m.lastWrittenAt).toBeNull();
  });
});

describe('MemoryService: summarize (T28)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** 打桩网关，让流式返回指定文本 */
  function stubGateway(text: string) {
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
    vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation((_req, handlers) => {
      handlers.onToken(text);
      handlers.onDone();
      return { done: Promise.resolve(), abort: () => {} };
    });
  }

  const history = [
    { role: 'user' as const, content: '我是明明，做中医药临床研究' },
    { role: 'assistant' as const, content: '你好明明' },
  ];

  it('历史为空时 summarize 返回两节皆空（不报错）', async () => {
    const s = await MemoryService.summarize([]);
    expect(s).toEqual({ identity: '', task: '' });
    expect(isEmptySummary(s)).toBe(true);
  });

  it('summarize 解析分节输出，两节各自截断到 150 字', async () => {
    stubGateway(`[身份] ${'身'.repeat(200)}\n[任务] ${'任'.repeat(200)}`);
    const summary = await MemoryService.summarize(history);
    expect(summary.identity).toBe('身'.repeat(150));
    expect(summary.task).toBe('任'.repeat(150));
  });

  it('缺失标签时整段归入 task（不丢记忆）', async () => {
    stubGateway('用户做中医药研究，决定本周交付 P0 修复。');
    const summary = await MemoryService.summarize(history);
    expect(summary.identity).toBe('');
    expect(summary.task).toBe('用户做中医药研究，决定本周交付 P0 修复。');
  });

  it('网关异常时 summarize 静默返回两节皆空', async () => {
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('offline');
    vi.spyOn(NanobotClient.prototype, 'sendMessage').mockRejectedValue(
      new Error('gateway offline'),
    );
    expect(await MemoryService.summarize(history)).toEqual({ identity: '', task: '' });
  });
});

describe('parseSummary: 容错解析', () => {
  it('两节齐全时按标签切分', () => {
    expect(parseSummary('[身份] 明明，中医药背景\n[任务] 决定先修 P0')).toEqual({
      identity: '明明，中医药背景',
      task: '决定先修 P0',
    });
  });

  it('模型用「无」占位时归一化为空串', () => {
    expect(parseSummary('[身份] 无\n[任务] 修 P0')).toEqual({ identity: '', task: '修 P0' });
    expect(parseSummary('[身份] 明明\n[任务] N/A')).toEqual({ identity: '明明', task: '' });
  });

  it('标签顺序颠倒也能各归其位', () => {
    expect(parseSummary('[任务] 修 P0\n[身份] 明明')).toEqual({
      identity: '明明',
      task: '修 P0',
    });
  });

  it('只出现一节时另一节为空', () => {
    expect(parseSummary('[身份] 明明')).toEqual({ identity: '明明', task: '' });
    expect(parseSummary('[任务] 修 P0')).toEqual({ identity: '', task: '修 P0' });
  });

  it('加粗包裹的标签内容仍能取到', () => {
    expect(parseSummary('[身份] **明明**')).toEqual({ identity: '明明', task: '' });
  });

  it('空串与无标签整段分别处理', () => {
    expect(parseSummary('')).toEqual({ identity: '', task: '' });
    expect(parseSummary('一段没有标签的摘要')).toEqual({
      identity: '',
      task: '一段没有标签的摘要',
    });
  });
});

describe('workspaceKeyFor: 工作目录 → 记忆 key', () => {
  it('无 workdir 回落 default（与历史记忆保持连续）', () => {
    expect(workspaceKeyFor(undefined)).toBe('default');
    expect(workspaceKeyFor('')).toBe('default');
    expect(workspaceKeyFor('   ')).toBe('default');
  });

  it('形态为 <basename>-<hash8>，文件名可读', () => {
    const key = workspaceKeyFor('D:\\Workspace\\study\\nanowork');
    expect(key).toMatch(/^nanowork-[0-9a-f]{8}$/);
  });

  it('大小写 / 斜杠 / 尾斜杠归一化后落到同一个 key', () => {
    const a = workspaceKeyFor('D:\\Workspace\\Study\\Nanowork');
    const b = workspaceKeyFor('d:/workspace/study/nanowork/');
    expect(a).toBe(b);
  });

  it('同名目录不互相覆盖', () => {
    expect(workspaceKeyFor('D:/a/src')).not.toBe(workspaceKeyFor('D:/b/src'));
  });

  it('字符集收敛到 [a-z0-9._-]，与主进程白名单一致', () => {
    const key = workspaceKeyFor('D:/工作 区/我的项目 (1)');
    expect(key).toMatch(/^[a-z0-9._-]+$/);
  });
});

describe('memoryDiskPath: 展示用落点', () => {
  const originalEnv = platform.env;
  afterEach(() => {
    platform.env = originalEnv;
  });

  it('Electron 下给出两条真实文件路径', () => {
    platform.env = 'electron';
    expect(memoryDiskPath('user', 'ignored')).toBe('~/.nanowork/MEMORY.md');
    expect(memoryDiskPath('workspace', 'nanowork-1a2b3c4d')).toBe(
      '~/.nanowork/memory/nanowork-1a2b3c4d.md',
    );
  });

  it('Web 下给一句人话，而不是编一个假路径', () => {
    platform.env = 'web';
    expect(memoryDiskPath('workspace', 'nanowork-1a2b3c4d')).toBe(
      '浏览器本地存储（Web 端无文件落点）',
    );
  });
});

describe('memoryDirective: Agent 记忆写入协议', () => {
  it('解析 scope 属性，缺省与拼错都收敛为 workspace', () => {
    expect(parseMemoryDirectives('<memory-save scope="user">A</memory-save>')).toEqual([
      { scope: 'user', content: 'A' },
    ]);
    expect(parseMemoryDirectives('<memory-save>B</memory-save>')).toEqual([
      { scope: 'workspace', content: 'B' },
    ]);
    expect(parseMemoryDirectives('<memory-save scope="USER">C</memory-save>')).toEqual([
      { scope: 'user', content: 'C' },
    ]);
    expect(parseMemoryDirectives('<memory-save scope="全局">D</memory-save>')).toEqual([
      { scope: 'workspace', content: 'D' },
    ]);
  });

  it('多个块按出现顺序返回，空块被丢弃', () => {
    const text = [
      '<memory-save scope="user">名字是明明</memory-save>',
      '<memory-save>   </memory-save>',
      '<memory-save scope="workspace">决定修 P0</memory-save>',
    ].join('\n');
    expect(parseMemoryDirectives(text)).toEqual([
      { scope: 'user', content: '名字是明明' },
      { scope: 'workspace', content: '决定修 P0' },
    ]);
  });

  it('无块时返回空数组（不误伤普通正文）', () => {
    expect(parseMemoryDirectives('普通回答，没有任何标记')).toEqual([]);
  });

  it('strip 后块消失、正文保留，且不留多余空行', () => {
    const text = '先看结论。\n<memory-save scope="user">名字是明明</memory-save>\n';
    expect(stripMemoryDirectives(text)).toBe('先看结论。');
  });

  it('未闭合的开标签连同其后内容一起丢弃（半截协议不外泄）', () => {
    const text = '结论在此。\n<memory-save scope="user">写到一半';
    expect(stripMemoryDirectives(text)).toBe('结论在此。');
  });

  it('strip 幂等：没有标记时原样返回', () => {
    const text = '没有任何标记的正文';
    expect(stripMemoryDirectives(text)).toBe(text);
  });
});

describe('MemoryService: 工作区 key 解析 (T22)', () => {
  it('resolveWorkspaceKey 当前统一返回 default', () => {
    expect(MemoryService.resolveWorkspaceKey()).toBe('default');
  });

  it('load 读取的 storage key 为 nanowork.memory.default', async () => {
    await MemoryService.save('hello');
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toBe('hello');
  });
});

describe('MemoryService: 幂等去重 (增强)', () => {
  it('相同内容重复 append 只保留一条（条数不翻倍）', async () => {
    await MemoryService.append('相同的记忆内容', { source: 's', at: '2025-07-07T00:00:00.000Z' });
    await MemoryService.append('相同的记忆内容', { source: 's', at: '2025-07-08T00:00:00.000Z' });

    const text = await MemoryService.load();
    expect(MemoryService.countEntries(text)).toBe(1);
    // 原文只出现一次
    expect(text.match(/相同的记忆内容/g)?.length).toBe(1);
  });

  it('不同内容仍可各自追加（条数累加）', async () => {
    await MemoryService.append('内容甲', { source: 's', at: '2025-07-09T00:00:00.000Z' });
    await MemoryService.append('内容乙', { source: 's', at: '2025-07-10T00:00:00.000Z' });
    const text = await MemoryService.load();
    expect(MemoryService.countEntries(text)).toBe(2);
  });

  it('去重标记内嵌于引用块、不另起段落', async () => {
    await MemoryService.append('带去重标记的内容', { source: 's', at: '2025-07-11T00:00:00.000Z' });
    const text = await MemoryService.load();
    expect(text).toContain('<!-- SUMMARY:');
    // 整块仍是单一段落（以空行分隔仅 1 段）
    expect(text.split(/\n\s*\n/).filter((b) => b.trim() !== '').length).toBe(1);
  });
});

describe('MemoryService: 多工作区隔离 (增强)', () => {
  it('useWorkspace 切换后 save/load 互不影响', async () => {
    await MemoryService.useWorkspace('ws-a');
    await MemoryService.save('工作区A的记忆');
    await MemoryService.useWorkspace('ws-b');
    await MemoryService.save('工作区B的记忆');

    await MemoryService.useWorkspace('ws-a');
    expect(await MemoryService.load()).toBe('工作区A的记忆');
    await MemoryService.useWorkspace('ws-b');
    expect(await MemoryService.load()).toBe('工作区B的记忆');
  });

  it('listWorkspaces 返回已登记工作区及其规模', async () => {
    await MemoryService.useWorkspace('ws-c');
    await MemoryService.save('C 的内容');
    const list = await MemoryService.listWorkspaces();
    expect(list.some((w) => w.key === 'ws-c' && w.chars > 0)).toBe(true);
    expect(list.some((w) => w.key === 'default')).toBe(true);
  });
});
