/**
 * 设置「通用 → 存储」：系统缓存目录 + 默认工作空间存储路径。
 *
 * ## 这组用例想钉住的三件事
 *
 * 1. **数字与图形一致**。占用条三段（系统缓存 / 磁盘已用 / 磁盘可用）是按
 *    同一份 `StorageInfo` 算出来的：段宽是百分比、文案是格式化字节。两者只要
 *    有一处读错字段（例如把「已用」当成整盘已用而不是缓存占用），界面上是
 *    「条画对了、字写错了」——不报错、不崩，只是长期骗人。
 * 2. **「打开目录」打的是缓存目录**。`openPath` 接收的是从 props 一路传下来的
 *    字符串，传错一个变量就会变成「点了没反应」，而报错在另一个窗口里。
 * 3. **默认工作空间真的落到新建任务上**。这是整个功能的意义所在：设置页里改了
 *    路径，新建任务却仍然落在别处，那这个设置就只是一句文案。
 *    兜底写在 `createSession` 里而不是各「新建任务」入口——入口有六七个，
 *    逐个传必然漏掉一两个。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageCard, formatBytes } from '@/components/settings/StorageCard';
import { platform } from '@/platform';
import type { StorageInfo } from '@/platform/types';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import {
  resolveDefaultWorkspacePath,
  useStorageInfoStore,
} from '@/stores/storageInfoStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { resetEventStream } from './helpers/eventStream';
import { byAria, buttonByText, click, flush, mount, unmount } from './helpers/reactMount';
import { DEFAULT_MEMORY_POLICY } from '@/types';

/** 6.62 GB 缓存 / 300 GB 盘 / 262 GB 已用 / 38 GB 可用（对齐参考图量级） */
const INFO: StorageInfo = {
  cacheDir: 'C:\\Users\\tester\\.nanowork',
  cacheBytes: 6.62 * 1024 ** 3,
  disk: {
    totalBytes: 300 * 1024 ** 3,
    usedBytes: 262 * 1024 ** 3,
    freeBytes: 38 * 1024 ** 3,
  },
  defaultWorkspaceDir: 'C:\\Users\\tester\\NanoWork',
};

const CUSTOM_WORKSPACE = 'D:\\dev\\my-workspace';

beforeEach(() => {
  vi.restoreAllMocks();
  unmount();
  // 存储信息是模块级缓存：不清会串用例（上一条把 info 塞进去，下一条以为
  // 主进程已经回过话了，于是「未取到」的分支再也不会被走到）
  useStorageInfoStore.setState({ info: null, loading: false, error: null });
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      processDetail: 'key',
      memoryEnabled: false,
      autoSummarize: false,
      memoryRecall: true,
      memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
      transcription: DEFAULT_TRANSCRIPTION,
      desktop: DEFAULT_DESKTOP,
    },
    status: 'offline',
  });
  useSessionsStore.setState({ sessions: [], activeId: null, streams: {} });
  useAgentsStore.setState({ agents: [], activeAgentId: null });
  resetEventStream();
});

describe('formatBytes', () => {
  it('按量级切换单位，并按量级决定小数位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    // < 100 保留两位：6.62 GB 这种量级差一位就看不出变化
    expect(formatBytes(6.62 * 1024 ** 3)).toBe('6.62 GB');
    // >= 100 收敛到一位：300.00 GB 长得像精确测量值，其实是估算
    expect(formatBytes(300 * 1024 ** 3)).toBe('300.0 GB');
  });

  it('非法与非正数一律按 0 B，不产生 NaN/负值文案', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
  });
});

describe('存储卡片 · 系统缓存目录', () => {
  it('回显缓存目录路径与用途说明，并给出「打开目录」入口', async () => {
    const openPath = vi.spyOn(platform, 'openPath').mockResolvedValue({ ok: true });
    vi.spyOn(platform, 'storageInfo').mockResolvedValue(INFO);

    const host = mount(<StorageCard />);
    await flush();

    expect(host.textContent).toContain(INFO.cacheDir);
    expect(host.textContent).toContain('存放对话记录、运行缓存与临时文件');

    click(buttonByText(host, '打开目录'));
    await flush();

    expect(openPath).toHaveBeenCalledWith(INFO.cacheDir);
  });

  it('路径行是标题下方唯一的一行，不额外挂说明（对齐 WorkBuddy 存储卡片）', async () => {
    vi.spyOn(platform, 'storageInfo').mockResolvedValue(INFO);

    const host = mount(<StorageCard />);
    await flush();

    // 参考图这一栏只有「路径 · 用途」一行。之前为交代「用户资产另存于 …」
    // 在下面加过一行，卡片整体比参考图胖一圈，且那份说明在「数据管理 → 数据落点」
    // 里已经完整存在（还带真实路径），属于重复。这里锁住它不再长回来。
    const pathLine = Array.from(host.querySelectorAll('p')).find((p) =>
      p.textContent?.includes(INFO.cacheDir),
    );
    expect(pathLine).toBeTruthy();
    expect(pathLine?.nextElementSibling).toBeNull();
  });

  it('右上角「打开目录」被夹在与标题行等高的盒子里，不会掉到路径那一行', async () => {
    vi.spyOn(platform, 'storageInfo').mockResolvedValue(INFO);

    const host = mount(<StorageCard />);
    await flush();

    // jsdom 不做布局，量不到真实中心点；能锁住的是「按钮外面套了一个与标题行
    // 等高的垂直居中盒子」这个前提——它成立时两者的中心必然重合。MUI 的 small
    // Button 比标题行高约 10px，直接顶部对齐会让按钮明显下沉到路径那一行去。
    const button = buttonByText(host, '打开目录');
    expect(button).toBeTruthy();
    const aligner = button!.parentElement;
    expect(aligner).toBeTruthy();
    const style = getComputedStyle(aligner!);
    expect(style.height).toBe('21px');
    expect(style.display).toBe('flex');
    expect(style.alignItems).toBe('center');
  });

  it('占用条按「缓存 / 已用（扣掉缓存）/ 可用」三段划分，且文案同源', async () => {
    vi.spyOn(platform, 'storageInfo').mockResolvedValue(INFO);

    const host = mount(<StorageCard />);
    await flush();

    // 有 role=img 的无障碍描述作为「数值来源唯一」的锚点
    const bar = host.querySelector('[role="img"]');
    expect(bar, '占用条未渲染').toBeTruthy();
    expect(bar!.getAttribute('aria-label')).toContain('系统缓存 6.62 GB');

    // 两段 div（第三段是容器底色，不画）
    const segments = Array.from(bar!.children) as HTMLElement[];
    expect(segments).toHaveLength(2);

    // 宽度走 `sx` → emotion 生成的类，**不是**行内 style，所以要读计算样式
    const widthOf = (el: HTMLElement) => parseFloat(getComputedStyle(el).width);
    const cachePct = (6.62 / 300) * 100;
    const usedPct = ((262 - 6.62) / 300) * 100;
    expect(widthOf(segments[0])).toBeCloseTo(cachePct, 3);
    // 关键：中间段必须**扣掉缓存**。不扣的话缓存被算两遍，
    // 「缓存 + 已用 + 可用」加起来超过 100%，条会溢出到容器外还被裁掉。
    expect(widthOf(segments[1])).toBeCloseTo(usedPct, 3);
    // 两段加起来仍留有余量 —— 「可用」那一截必须真的露出来
    expect(widthOf(segments[0]) + widthOf(segments[1])).toBeLessThan(100);

    expect(host.textContent).toContain('已用 6.62 GB / 共 300.0 GB');
    expect(host.textContent).toContain('系统缓存');
    expect(host.textContent).toContain('磁盘已用');
    expect(host.textContent).toContain('磁盘可用');
  });

  it('主进程没回话（Web 端）时如实显示不可用，而不是画一根空条装作正常', async () => {
    vi.spyOn(platform, 'storageInfo').mockResolvedValue(null);

    const host = mount(<StorageCard />);
    await flush();

    expect(host.textContent).toContain('正在读取…');
    expect(host.textContent).toContain('当前环境不支持读取本地存储信息');
    // 拿不到目录就不该给一个点了没反应的按钮
    expect(buttonByText(host, '打开目录')?.disabled).toBe(true);
  });
});

describe('存储卡片 · 默认工作空间存储路径', () => {
  it('未自定义时输入框留空、以内置默认路径为占位', async () => {
    vi.spyOn(platform, 'storageInfo').mockResolvedValue(INFO);

    const host = mount(<StorageCard />);
    await flush();

    const input = byAria('默认工作空间存储路径', host) as HTMLInputElement | null;
    expect(input, '默认工作空间输入框未渲染').toBeTruthy();
    expect(input!.value).toBe('');
    expect(input!.placeholder).toBe(INFO.defaultWorkspaceDir);
    // 未自定义时不出现「恢复默认」（没有可恢复的东西）
    expect(byAria('恢复默认工作空间路径', host)).toBeNull();
  });

  it('点「更改」走目录选择器，并把所选路径写进设置', async () => {
    vi.spyOn(platform, 'storageInfo').mockResolvedValue(INFO);
    const pick = vi.spyOn(platform, 'pickDirectory').mockResolvedValue(CUSTOM_WORKSPACE);

    const host = mount(<StorageCard />);
    await flush();

    click(buttonByText(host, '更改'));
    await flush();

    expect(pick).toHaveBeenCalled();
    expect(useSettingsStore.getState().settings.defaultWorkspacePath).toBe(CUSTOM_WORKSPACE);
    expect(resolveDefaultWorkspacePath()).toBe(CUSTOM_WORKSPACE);
  });

  it('用户取消选择时设置保持不变（不能把「点了取消」当成「选了空路径」）', async () => {
    vi.spyOn(platform, 'storageInfo').mockResolvedValue(INFO);
    vi.spyOn(platform, 'pickDirectory').mockResolvedValue(null);

    const host = mount(<StorageCard />);
    await flush();

    click(buttonByText(host, '更改'));
    await flush();

    expect(useSettingsStore.getState().settings.defaultWorkspacePath).toBeUndefined();
  });

  it('已自定义时出现「恢复默认」，点它把设置清回未设置态', async () => {
    vi.spyOn(platform, 'storageInfo').mockResolvedValue(INFO);
    useSettingsStore.getState().setSettings({ defaultWorkspacePath: CUSTOM_WORKSPACE });

    const host = mount(<StorageCard />);
    await flush();

    const input = byAria('默认工作空间存储路径', host) as HTMLInputElement | null;
    expect(input!.value).toBe(CUSTOM_WORKSPACE);

    click(byAria('恢复默认工作空间路径', host));
    await flush();

    // 清回 undefined 而不是空串：空串会作为一条「用户设置过」的记录留在
    // 持久化数据里，日后没法区分「从没设置过」和「设置成空」
    expect(useSettingsStore.getState().settings.defaultWorkspacePath).toBeUndefined();
    expect(resolveDefaultWorkspacePath()).toBe(INFO.defaultWorkspaceDir);
  });
});

describe('默认工作空间 · 解析优先级', () => {
  it('用户设置 > 内置默认 > 未取到（undefined）', () => {
    // 主进程还没回话：宁可返回 undefined，也不要猜一个路径写进会话
    expect(resolveDefaultWorkspacePath()).toBeUndefined();

    useStorageInfoStore.setState({ info: INFO });
    expect(resolveDefaultWorkspacePath()).toBe(INFO.defaultWorkspaceDir);

    useSettingsStore.getState().setSettings({ defaultWorkspacePath: CUSTOM_WORKSPACE });
    expect(resolveDefaultWorkspacePath()).toBe(CUSTOM_WORKSPACE);

    // 空串与「未设置」同义（用户清空输入框 / 老数据里的空值都走这条路）
    useSettingsStore.getState().setSettings({ defaultWorkspacePath: '' });
    expect(resolveDefaultWorkspacePath()).toBe(INFO.defaultWorkspaceDir);
  });
});

describe('默认工作空间 · 落到新建任务上', () => {
  it('新建任务沿用默认工作空间路径', () => {
    useStorageInfoStore.setState({ info: INFO });

    const session = useSessionsStore.getState().createSession(undefined, '新任务');
    expect(session.workdir).toBe(INFO.defaultWorkspaceDir);
  });

  it('用户自定义后，新建任务落在自定义路径上', () => {
    useStorageInfoStore.setState({ info: INFO });
    useSettingsStore.getState().setSettings({ defaultWorkspacePath: CUSTOM_WORKSPACE });

    const session = useSessionsStore.getState().createSession(undefined, '新任务');
    expect(session.workdir).toBe(CUSTOM_WORKSPACE);
  });

  it('调用方显式指定的工作空间优先于默认值', () => {
    useStorageInfoStore.setState({ info: INFO });

    const session = useSessionsStore
      .getState()
      .createSession(undefined, '新任务', { workdir: 'E:\\explicit' });
    expect(session.workdir).toBe('E:\\explicit');
  });

  it('「清除工作空间」回到默认路径，而不是掉进另一个分组', () => {
    useStorageInfoStore.setState({ info: INFO });

    const session = useSessionsStore
      .getState()
      .createSession(undefined, '新任务', { workdir: 'E:\\explicit' });
    useSessionsStore.getState().setSessionWorkdir(session.id, undefined);

    const after = useSessionsStore.getState().sessions.find((s) => s.id === session.id);
    expect(after?.workdir).toBe(INFO.defaultWorkspaceDir);
  });
});
