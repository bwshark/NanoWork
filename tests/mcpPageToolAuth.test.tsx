/**
 * MCP 页工具授权与真实连接测试（FR-3.2）。
 *
 * 这里要钉住的是**页面的接线**，不是 store 的内部逻辑（后者在
 * `tests/mcpToolAuth.test.ts`）：
 *
 * 1. 没有工具清单时「工具授权」入口必须禁用——否则用户点进去看到空列表，
 *    会以为是工具没了，而不是还没探测；
 * 2. 授权对话框保存后，黑名单要真的进到下发配置里（这是整条链路的终点）；
 * 3. 连接测试按钮走的是探针，成功后的工具条数要显示出来。
 *
 * MUI 的两个坑（见 gate skill §7.8）：Dialog 走 Portal 渲染到 document.body，
 * 必须在 `dialogRoot()` 里查；Switch 的可点区域是 input，用 aria-label 定位。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpPage } from '@/pages/mcp/McpPage';
import { useMcpStore } from '@/stores/mcpStore';
import { platform } from '@/platform';
import { byAria, buttonByText, click, dialogRoot, fieldByLabel, flush, mount, setInputValue, setSelectValue, unmount } from './helpers/reactMount';
import type { MCPConfig } from '@/types';

const cfg = (patch: Partial<MCPConfig> = {}): MCPConfig => ({
  id: 'u-1',
  name: 'demo mcp',
  transport: 'url',
  endpoint: 'http://localhost:8080/mcp',
  status: 'idle',
  source: 'user',
  enabled: true,
  ...patch,
});

const DISCOVERED = [
  { name: 'echo', description: '回声' },
  { name: 'danger_delete', description: '删库' },
];

let originalEnv: typeof platform.env;

beforeEach(() => {
  originalEnv = platform.env;
  vi.restoreAllMocks();
  useMcpStore.setState({
    configs: [cfg({ tools: DISCOVERED, lastProbedAt: 1 })],
    vaultAvailable: null,
    secretKeys: {},
  });
});

afterEach(() => {
  platform.env = originalEnv;
  unmount();
});

describe('McpPage: 工具授权入口', () => {
  it('有工具清单时入口可用，并显示工具数', () => {
    const host = mount(<McpPage />);
    const button = byAria('工具授权 demo mcp', host) as HTMLButtonElement | null;
    expect(button).toBeTruthy();
    expect(button?.disabled).toBe(false);
    // 运行时事实行：工具条数直接可见
    expect(byAria('demo mcp 已发现工具 2', host)).toBeTruthy();
  });

  it('没有工具清单时入口禁用（提示先做连接测试）', () => {
    useMcpStore.setState({ configs: [cfg()] });
    const host = mount(<McpPage />);
    const button = byAria('工具授权 demo mcp', host) as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);
    expect(byAria('demo mcp 已发现工具 2', host)).toBeNull();
  });

  it('已禁用的工具数展示在卡片上', () => {
    useMcpStore.setState({
      configs: [cfg({ tools: DISCOVERED, disabledTools: ['danger_delete'] })],
    });
    const host = mount(<McpPage />);
    expect(byAria('demo mcp 已禁用工具 1', host)).toBeTruthy();
  });
});

describe('McpPage: 授权对话框', () => {
  it('列出探测到的工具与描述', () => {
    const host = mount(<McpPage />);
    click(byAria('工具授权 demo mcp', host));

    const dialog = dialogRoot();
    expect(dialog.textContent).toContain('echo');
    expect(dialog.textContent).toContain('danger_delete');
    expect(dialog.textContent).toContain('不会注册进引擎');
  });

  it('关掉一个工具后保存：黑名单进入下发配置', async () => {
    platform.env = 'electron';
    const sync = vi.spyOn(platform, 'syncNanobotMcp').mockResolvedValue({
      ok: true,
      changed: true,
      message: '已写入',
    });

    const host = mount(<McpPage />);
    click(byAria('工具授权 demo mcp', host));

    const toggle = dialogRoot().querySelector<HTMLInputElement>(
      '[aria-label="允许工具 danger_delete"]',
    );
    click(toggle);
    await flush();
    expect(toggle?.checked).toBe(false);

    const save = Array.from(dialogRoot().querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('保存并同步'),
    );
    click(save);
    await flush();

    expect(useMcpStore.getState().configs[0].disabledTools).toEqual(['danger_delete']);
    const payload = JSON.parse(
      (sync.mock.calls[0]?.[0] as string) ?? '{}',
    ) as Record<string, { disabledTools?: string[] }>;
    expect(payload['demo mcp'].disabledTools).toEqual(['danger_delete']);
  });

  it('恢复允许后黑名单清空（收敛为不下发）', async () => {
    platform.env = 'electron';
    vi.spyOn(platform, 'syncNanobotMcp').mockResolvedValue({
      ok: true,
      changed: true,
      message: '已写入',
    });
    useMcpStore.setState({
      configs: [cfg({ tools: DISCOVERED, disabledTools: ['echo'] })],
    });

    const host = mount(<McpPage />);
    click(byAria('工具授权 demo mcp', host));

    const toggle = dialogRoot().querySelector<HTMLInputElement>('[aria-label="允许工具 echo"]');
    expect(toggle?.checked).toBe(false);
    click(toggle);
    await flush();

    const save = Array.from(dialogRoot().querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('保存并同步'),
    );
    click(save);
    await flush();

    expect(useMcpStore.getState().configs[0].disabledTools).toBeUndefined();
  });

  it('黑名单里有探测清单之外的名字时给出残留提示', () => {
    useMcpStore.setState({
      configs: [cfg({ tools: DISCOVERED, disabledTools: ['gone_tool'] })],
    });
    const host = mount(<McpPage />);
    click(byAria('工具授权 demo mcp', host));

    expect(dialogRoot().textContent).toContain('gone_tool');
    expect(dialogRoot().textContent).toContain('不在本次探测到的清单里');
  });
});

describe('McpPage: 连接测试走真实探针', () => {
  it('点击后调用探针并把工具条数写回卡片', async () => {
    const probe = vi.spyOn(platform, 'probeMcpServer').mockResolvedValue({
      ok: true,
      status: 'connected',
      tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      latencyMs: 12,
    });
    useMcpStore.setState({ configs: [cfg()] });

    const host = mount(<McpPage />);
    click(byAria('连接测试 demo mcp', host));
    await flush();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0]).toMatchObject({
      name: 'demo mcp',
      endpoint: 'http://localhost:8080/mcp',
    });
    const stored = useMcpStore.getState().configs[0];
    expect(stored.status).toBe('connected');
    expect(stored.tools).toHaveLength(3);
  });

  it('探针失败后卡片状态为 error 且保留原清单', async () => {
    vi.spyOn(platform, 'probeMcpServer').mockResolvedValue({
      ok: false,
      status: 'error',
      tools: [],
      error: '连接超时',
      latencyMs: 8000,
    });
    useMcpStore.setState({ configs: [cfg({ tools: DISCOVERED })] });

    const host = mount(<McpPage />);
    click(byAria('连接测试 demo mcp', host));
    await flush();

    const stored = useMcpStore.getState().configs[0];
    expect(stored.status).toBe('error');
    expect(stored.tools).toHaveLength(2);
  });
});

describe('McpPage: 凭据状态展示', () => {
  it('已配置凭据时显示 key 名而不是值', () => {
    useMcpStore.setState({ configs: [cfg({ authKeyNames: ['token'] })] });
    const host = mount(<McpPage />);
    expect(byAria('demo mcp 凭据 token', host)).toBeTruthy();
  });

  it('未配置凭据时不显示凭据芯片', () => {
    const host = mount(<McpPage />);
    expect(byAria('demo mcp 凭据 token', host)).toBeNull();
  });
});

/**
 * 传输方式（sse / streamableHttp）：从地址上分不出来（老式 SSE 与 Streamable
 * HTTP 的 URL 可能都是 `/mcp`），所以缺省替用户探一次，并把**实测**结果写进
 * 下发配置 —— 引擎按它挑 client，写错了就是「这里测试通过、聊天时连不上」。
 */
describe('McpPage: 新增时的传输方式', () => {
  /** 打开新增弹窗并填好名字与地址 */
  function openNewWithUrl(url: string): void {
    const host = mount(<McpPage />);
    click(buttonByText(host, '新增连接器'));
    setInputValue(fieldByLabel('名称', dialogRoot()) as HTMLInputElement, 'local mcp');
    setInputValue(fieldByLabel('地址 (URL)', dialogRoot()) as HTMLInputElement, url);
  }

  function saveDialog(): void {
    click(buttonByText(dialogRoot(), '保存'));
  }

  it('未指定时自动探测，把实测的 sse 写进下发配置（引擎才不会用错 client）', async () => {
    platform.env = 'electron';
    const probe = vi.spyOn(platform, 'probeMcpServer').mockResolvedValue({
      ok: true,
      status: 'connected',
      tools: [{ name: 'mcp_question' }],
      transport: 'sse',
      latencyMs: 72,
    });
    const sync = vi.spyOn(platform, 'syncNanobotMcp').mockResolvedValue({
      ok: true,
      changed: true,
      message: '已写入',
    });

    openNewWithUrl('http://localhost:8001/mcp');
    saveDialog();
    await flush();

    // 探测请求里 urlType 是 undefined —— 这正是「自动检测」的线上表示
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0]).toMatchObject({
      endpoint: 'http://localhost:8001/mcp',
      urlType: undefined,
    });

    const stored = useMcpStore.getState().configs.find((c) => c.name === 'local mcp');
    expect(stored?.urlType).toBe('sse');

    const payload = JSON.parse((sync.mock.calls[0]?.[0] as string) ?? '{}') as Record<
      string,
      { type?: string }
    >;
    expect(payload['local mcp'].type).toBe('sse');
  });

  it('手动选定的传输方式直接生效，且不再多探一次', async () => {
    platform.env = 'electron';
    const probe = vi.spyOn(platform, 'probeMcpServer').mockResolvedValue({
      ok: true,
      status: 'connected',
      tools: [],
      latencyMs: 5,
    });
    const sync = vi.spyOn(platform, 'syncNanobotMcp').mockResolvedValue({
      ok: true,
      changed: true,
      message: '已写入',
    });

    openNewWithUrl('http://localhost:8001/mcp');
    setSelectValue(fieldByLabel('传输方式', dialogRoot()) as HTMLSelectElement, 'sse');
    saveDialog();
    await flush();

    // 用户已经表态，不该再猜（也免得对不支持 POST 的端点白打一发）
    expect(probe).not.toHaveBeenCalled();
    const payload = JSON.parse((sync.mock.calls[0]?.[0] as string) ?? '{}') as Record<
      string,
      { type?: string }
    >;
    expect(payload['local mcp'].type).toBe('sse');
  });

  it('自动探测失败不阻断保存：按静态推断先写下去', async () => {
    platform.env = 'electron';
    vi.spyOn(platform, 'probeMcpServer').mockResolvedValue({
      ok: false,
      status: 'error',
      tools: [],
      error: '连接超时',
      latencyMs: 8000,
    });
    const sync = vi.spyOn(platform, 'syncNanobotMcp').mockResolvedValue({
      ok: true,
      changed: true,
      message: '已写入',
    });

    openNewWithUrl('http://localhost:8001/mcp');
    saveDialog();
    await flush();

    const stored = useMcpStore.getState().configs.find((c) => c.name === 'local mcp');
    expect(stored?.urlType).toBeUndefined();
    // 服务器暂时不可达不该让配置存不下来
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
