import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { platform } from '@/platform';
import { STORAGE_KEYS } from '@/lib/core/constants';
import { useChannelsStore } from '@/stores/channelsStore';
import {
  buildNanobotChannelsFragment,
  fromNanobotChannels,
  toNanobotChannels,
} from '@/ai/runtime/nanobotHttp/channels';
import type { ChannelConfig } from '@/types';

/**
 * channelsStore / nanobotChannels 测试。
 * 同步链路：配置变更 → 防抖自动同步 → platform.syncNanobotChannels
 * （桌面端由主进程合并 config.json 并重启网关；测试中 mock 该 API）。
 * 使用假定时器防止防抖定时器在用例间意外触发。
 */

/** 重置 store 到初始态，避免跨用例串扰 */
function resetStore() {
  useChannelsStore.setState({
    configs: [],
    tombstones: {},
    lastSync: null,
    vaultAvailable: null,
    secretKeys: {},
  });
}

/**
 * 用一张内存表模拟凭据保险库（只存 key 名，与真实实现一样不回传值）。
 * 返回该表便于断言「某条目进了保险库 / 被删了」。
 */
function mockVault(initial: Record<string, string[]> = {}): Record<string, string[]> {
  const entries = { ...initial };
  vi.spyOn(platform, 'secretsStatus').mockResolvedValue({ available: true, path: '/vault' });
  vi.spyOn(platform, 'secretsKeys').mockImplementation(async () => ({ ...entries }));
  vi.spyOn(platform, 'secretsSet').mockImplementation(async (name, secrets) => {
    entries[name] = Object.keys(secrets).sort();
    return { ok: true };
  });
  vi.spyOn(platform, 'secretsDelete').mockImplementation(async (name) => {
    delete entries[name];
    return { ok: true };
  });
  return entries;
}

/** 把平台切到 electron（用例结束后 afterEach 内的 restoreAllMocks 不还原 env，需自行重置） */
function enterElectron() {
  (platform as { env: 'electron' | 'web' }).env = 'electron';
}

beforeEach(() => {
  resetStore();
  vi.useFakeTimers();
  vi.spyOn(platform, 'syncNanobotChannels').mockResolvedValue({
    ok: true,
    message: '频道配置已写入 nanowork，网关已重启生效',
    changed: true,
  });
});

/** 测试环境默认 web；用例内可能切 electron，逐例还原避免串扰 */
const originalEnv = platform.env;

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  (platform as { env: 'electron' | 'web' }).env = originalEnv;
});

describe('channelsStore: 配置 CRUD', () => {
  it('saveConfig 新增配置并写入 feishu 类默认策略', () => {
    const saved = useChannelsStore.getState().saveConfig({
      kind: 'feishu',
      appId: 'cli_x',
      appSecret: 'sec',
    });
    expect(saved.id).toBeTruthy();
    expect(saved.enabled).toBe(true);
    expect(saved.groupPolicy).toBe('mention');
    expect(saved.topicIsolation).toBe(true);
    expect(useChannelsStore.getState().configs).toHaveLength(1);
  });

  it('saveConfig 缺省放开接入（allowFrom=["*"]，避免 nanobot 仅配对码模式）', () => {
    const saved = useChannelsStore.getState().saveConfig({ kind: 'dingtalk', clientId: 'a' });
    expect(saved.allowFrom).toEqual(['*']);
  });

  it('saveConfig 同 kind 覆盖更新且保持 id 不变', () => {
    const first = useChannelsStore.getState().saveConfig({ kind: 'dingtalk', clientId: 'a' });
    const second = useChannelsStore.getState().saveConfig({ kind: 'dingtalk', clientId: 'b' });
    expect(second.id).toBe(first.id);
    expect(second.clientId).toBe('b');
    expect(useChannelsStore.getState().configs).toHaveLength(1);
  });

  it('setEnabled 切换启停', () => {
    useChannelsStore.getState().saveConfig({ kind: 'wecom', botId: 'x', botSecret: 'y' });
    useChannelsStore.getState().setEnabled('wecom', false);
    expect(useChannelsStore.getState().configs[0].enabled).toBe(false);
  });
});

describe('nanobotChannels: 配置片段映射', () => {
  /** 构造一条最小配置 */
  const cfg = (kind: ChannelConfig['kind'], patch: Partial<ChannelConfig> = {}): ChannelConfig => ({
    id: `id-${kind}`,
    kind,
    enabled: true,
    allowFrom: [],
    syncStatus: 'idle',
    ...patch,
  });

  it('dingtalk / weixin / wecom 映射为平铺条目（字段名对齐 manifest）', () => {
    const out = toNanobotChannels([
      cfg('dingtalk', { clientId: 'cid', clientSecret: 'cs', allowFrom: ['u1'] }),
      cfg('weixin', { token: 'tk' }),
      cfg('wecom', { botId: 'bid', botSecret: 'bs' }),
    ]);
    expect(out.dingtalk).toEqual({ enabled: true, clientId: 'cid', clientSecret: 'cs', allowFrom: ['u1'] });
    expect(out.weixin).toEqual({ enabled: true, token: 'tk' });
    // manifest 中 wecom 的 secret 字段名为 secret
    expect(out.wecom).toEqual({ enabled: true, botId: 'bid', secret: 'bs' });
  });

  it('feishu 与 lark 合并进 feishu.instances 且 domain/instanceId 正确', () => {
    const out = toNanobotChannels([
      cfg('feishu', { appId: 'fa', appSecret: 'fs' }),
      cfg('lark', { appId: 'la', appSecret: 'ls' }),
    ]);
    const section = out.feishu as { instances: Array<Record<string, unknown>> };
    expect(section.instances).toHaveLength(2);
    expect(section.instances[0].domain).toBe('feishu');
    expect(section.instances[1].domain).toBe('lark');
    // instanceId 取稳定的渠道名，避免随机 ID 造成实例身份漂移
    expect(section.instances[0].instanceId).toBe('feishu');
    expect(section.instances[1].instanceId).toBe('lark');
    expect(section.instances[0].appId).toBe('fa');
  });

  it('buildNanobotChannelsFragment 输出含 channels 键的合法 JSON', () => {
    const json = buildNanobotChannelsFragment([cfg('dingtalk', { clientId: 'c' })]);
    const parsed = JSON.parse(json) as { channels: Record<string, unknown> };
    expect(parsed.channels.dingtalk).toBeDefined();
  });
});

describe('nanobotChannels: 回读白名单归一（消除配对审批墙的回显一致性）', () => {
  it('回读到空 / 缺失 allowFrom 归一为 ["*"]（仅扫码渠道：weixin + 飞书实例）', () => {
    // 模拟扫码后引擎回写形态：微信只有 token 无 allowFrom；飞书实例被引擎清空
    const out = fromNanobotChannels({
      weixin: { enabled: true, token: 'tk' },
      feishu: { instances: [{ id: 'feishu', domain: 'feishu', appId: 'a', allowFrom: [] }] },
    });
    const weixin = out.find((c) => c.kind === 'weixin');
    const feishu = out.find((c) => c.kind === 'feishu');
    expect(weixin?.allowFrom).toEqual(['*']);
    expect(feishu?.allowFrom).toEqual(['*']);
  });

  it('lark 实例（domain=lark）空名单同样归一为 ["*"]', () => {
    const out = fromNanobotChannels({
      feishu: { instances: [{ id: 'lark', domain: 'lark', appId: 'la' }] },
    });
    const lark = out.find((c) => c.kind === 'lark');
    expect(lark?.allowFrom).toEqual(['*']);
  });

  it('非扫码渠道（dingtalk / wecom）空名单保持空数组，不归一（配对审批模式刻意保留）', () => {
    const out = fromNanobotChannels({
      dingtalk: { enabled: true, clientId: 'cid' },
      wecom: { enabled: true, botId: 'bid', allowFrom: [] },
    });
    expect(out.find((c) => c.kind === 'dingtalk')?.allowFrom).toEqual([]);
    expect(out.find((c) => c.kind === 'wecom')?.allowFrom).toEqual([]);
  });

  it('非数组 allowFrom 回退为空：扫码渠道归一为 ["*"]，非扫码渠道保持空', () => {
    const out = fromNanobotChannels({
      weixin: { enabled: true, token: 'tk', allowFrom: 'oops' },
      dingtalk: { enabled: true, clientId: 'cid', allowFrom: {} },
    });
    expect(out.find((c) => c.kind === 'weixin')?.allowFrom).toEqual(['*']);
    expect(out.find((c) => c.kind === 'dingtalk')?.allowFrom).toEqual([]);
  });

  it('回读到的非空精确名单原样保留，不覆盖', () => {
    const out = fromNanobotChannels({
      weixin: { enabled: true, token: 'tk', allowFrom: ['wx_u1'] },
    });
    expect(out.find((c) => c.kind === 'weixin')?.allowFrom).toEqual(['wx_u1']);
  });

  it('向引擎同步的输出语义不变：空 allowFrom 仍不写键', () => {
    const out = toNanobotChannels([
      {
        id: 'id-wx',
        kind: 'weixin',
        enabled: true,
        allowFrom: [],
        token: 'tk',
        syncStatus: 'idle',
      },
    ]);
    expect(out.weixin).toEqual({ enabled: true, token: 'tk' });
    expect('allowFrom' in (out.weixin as Record<string, unknown>)).toBe(false);
  });
});

describe('channelsStore: 自动同步到 nanobot', () => {
  it('syncAll 提交含 channels 键的片段并置 synced + lastSyncAt', async () => {
    useChannelsStore.getState().saveConfig({ kind: 'dingtalk', clientId: 'c', clientSecret: 's' });
    const result = await useChannelsStore.getState().syncAll();
    expect(result.ok).toBe(true);
    const sync = vi.mocked(platform.syncNanobotChannels);
    expect(sync).toHaveBeenCalledTimes(1);
    const fragment = JSON.parse(sync.mock.calls[0][0]) as { channels: Record<string, unknown> };
    expect(fragment.channels.dingtalk).toBeDefined();
    const [saved] = useChannelsStore.getState().configs;
    expect(saved.syncStatus).toBe('synced');
    expect(saved.lastSyncAt).toBeTruthy();
    expect(useChannelsStore.getState().lastSync?.ok).toBe(true);
  });

  it('配置变更后防抖自动同步，多次变更合并为一次', async () => {
    const sync = vi.mocked(platform.syncNanobotChannels);
    useChannelsStore.getState().saveConfig({ kind: 'feishu', appId: 'a', appSecret: 'b' });
    useChannelsStore.getState().setEnabled('feishu', false);
    // 防抖窗口内不触发
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('removeConfig 后自动同步空片段以清理 nanobot 侧渠道', async () => {
    const sync = vi.mocked(platform.syncNanobotChannels);
    useChannelsStore.getState().saveConfig({ kind: 'wecom', botId: 'x', botSecret: 'y' });
    useChannelsStore.getState().removeConfig('wecom');
    await vi.advanceTimersByTimeAsync(600);
    expect(sync).toHaveBeenCalledTimes(1);
    const fragment = JSON.parse(sync.mock.calls[0][0]) as { channels: Record<string, unknown> };
    expect(fragment.channels).toEqual({});
  });

  it('syncAll 失败时置 error 并记录 lastSync', async () => {
    vi.mocked(platform.syncNanobotChannels).mockRejectedValue(new Error('io error'));
    useChannelsStore.getState().saveConfig({ kind: 'weixin', token: 't' });
    await expect(useChannelsStore.getState().syncAll()).rejects.toThrow();
    expect(useChannelsStore.getState().configs[0].syncStatus).toBe('error');
    expect(useChannelsStore.getState().lastSync?.ok).toBe(false);
  });
});

describe('channelsStore: refreshFromNanobot 强制回读（扫码接入成功后）', () => {
  // 测试环境默认 web；用例内显式切为 electron 验证回读逻辑，文件级 afterEach 负责还原

  it('回读覆盖本地同 kind 旧凭证（保留 id），且不触发自动同步', async () => {
    (platform as { env: 'electron' | 'web' }).env = 'electron';
    const sync = vi.mocked(platform.syncNanobotChannels);
    const local = useChannelsStore.getState().saveConfig({ kind: 'weixin', token: 'old-token' });
    // 先让 saveConfig 的防抖同步落定，之后单独验证回读本身不触发同步
    await vi.advanceTimersByTimeAsync(600);
    expect(sync).toHaveBeenCalledTimes(1);
    sync.mockClear();

    vi.spyOn(platform, 'getNanobotChannels').mockResolvedValue({
      weixin: { enabled: true, token: 'new-token-from-engine', allowFrom: ['*'] },
    });
    const updated = await useChannelsStore.getState().refreshFromNanobot('weixin');
    expect(updated).toBe(true);

    const cfg = useChannelsStore.getState().configs.find((c) => c.kind === 'weixin');
    expect(cfg?.token).toBe('new-token-from-engine');
    expect(cfg?.id).toBe(local.id);
    expect(useChannelsStore.getState().configs).toHaveLength(1);

    // 跨过防抖窗口：回读不得再触发 platform.syncNanobotChannels
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync).not.toHaveBeenCalled();
  });

  it('本地无该 kind 配置时新增回读条目（飞书 instances 反向映射）', async () => {
    (platform as { env: 'electron' | 'web' }).env = 'electron';
    const sync = vi.mocked(platform.syncNanobotChannels);
    vi.spyOn(platform, 'getNanobotChannels').mockResolvedValue({
      feishu: {
        instances: [
          {
            id: 'feishu',
            instanceId: 'feishu',
            enabled: true,
            domain: 'feishu',
            appId: 'cli_new',
            appSecret: 'secret-from-engine',
          },
        ],
      },
    });
    const updated = await useChannelsStore.getState().refreshFromNanobot('feishu');
    expect(updated).toBe(true);
    const cfg = useChannelsStore.getState().configs.find((c) => c.kind === 'feishu');
    expect(cfg?.appId).toBe('cli_new');
    expect(cfg?.appSecret).toBe('secret-from-engine');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync).not.toHaveBeenCalled();
  });

  it('回读不到该 kind 条目 / 非 electron 环境时返回 false', async () => {
    (platform as { env: 'electron' | 'web' }).env = 'electron';
    vi.spyOn(platform, 'getNanobotChannels').mockResolvedValue({});
    expect(await useChannelsStore.getState().refreshFromNanobot('weixin')).toBe(false);

    (platform as { env: 'electron' | 'web' }).env = 'web';
    const spy = vi.spyOn(platform, 'getNanobotChannels');
    spy.mockClear();
    expect(await useChannelsStore.getState().refreshFromNanobot('weixin')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('channelsStore: disconnectChannel 断开连接后清本地状态', () => {
  it('微信：清 token 并停用，保留 allowFrom 等策略字段', () => {
    useChannelsStore.getState().saveConfig({
      kind: 'weixin',
      token: 'wx-token',
      allowFrom: ['wx_user1'],
    });
    useChannelsStore.getState().disconnectChannel('weixin');
    const cfg = useChannelsStore.getState().configs.find((c) => c.kind === 'weixin');
    expect(cfg?.token).toBeUndefined();
    expect(cfg?.enabled).toBe(false);
    expect(cfg?.allowFrom).toEqual(['wx_user1']);
  });

  it('飞书：清 appId / appSecret 并停用，保留 groupPolicy / topicIsolation / allowFrom', () => {
    useChannelsStore.getState().saveConfig({
      kind: 'feishu',
      appId: 'cli_a',
      appSecret: 'secret_a',
    });
    useChannelsStore.getState().disconnectChannel('feishu');
    const cfg = useChannelsStore.getState().configs.find((c) => c.kind === 'feishu');
    expect(cfg?.appId).toBeUndefined();
    expect(cfg?.appSecret).toBeUndefined();
    expect(cfg?.enabled).toBe(false);
    // 策略字段保留（重连后沿用）
    expect(cfg?.groupPolicy).toBe('mention');
    expect(cfg?.topicIsolation).toBe(true);
    expect(cfg?.allowFrom).toEqual(['*']);
  });

  it('Lark：清 appId / appSecret 并停用，保留策略字段，不触发自动同步', async () => {
    const sync = vi.mocked(platform.syncNanobotChannels);
    useChannelsStore.getState().saveConfig({
      kind: 'lark',
      appId: 'la',
      appSecret: 'ls',
    });
    // 先让 saveConfig 的防抖同步落定，之后单独验证断开本身不触发同步
    await vi.advanceTimersByTimeAsync(600);
    expect(sync).toHaveBeenCalledTimes(1);
    sync.mockClear();

    useChannelsStore.getState().disconnectChannel('lark');
    const cfg = useChannelsStore.getState().configs.find((c) => c.kind === 'lark');
    expect(cfg?.appId).toBeUndefined();
    expect(cfg?.appSecret).toBeUndefined();
    expect(cfg?.enabled).toBe(false);
    // 策略字段保留（重连后沿用）
    expect(cfg?.groupPolicy).toBe('mention');
    expect(cfg?.topicIsolation).toBe(true);
    expect(cfg?.allowFrom).toEqual(['*']);
    // 跨过防抖窗口：断开不得再触发 platform.syncNanobotChannels
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync).not.toHaveBeenCalled();
  });

  it('重置同步状态为初始态（syncStatus=idle 且清 lastSyncAt），避免卡片残留旧时间戳', () => {
    useChannelsStore.getState().saveConfig({ kind: 'weixin', token: 'tk' });
    const [saved] = useChannelsStore.getState().configs;
    useChannelsStore.getState().setSyncStatus(saved.id, 'synced');
    useChannelsStore.setState((s) => ({
      configs: s.configs.map((c) => ({ ...c, lastSyncAt: '2026-01-01T00:00:00.000Z' })),
    }));

    useChannelsStore.getState().disconnectChannel('weixin');
    const cfg = useChannelsStore.getState().configs.find((c) => c.kind === 'weixin');
    expect(cfg?.syncStatus).toBe('idle');
    expect(cfg?.lastSyncAt).toBeUndefined();
  });

  it('取消断开前已排队的防抖同步（防旧片段把断开结果覆盖回去）', async () => {
    const sync = vi.mocked(platform.syncNanobotChannels);
    useChannelsStore.getState().saveConfig({ kind: 'weixin', token: 'tk' });
    // saveConfig 已排队一次防抖同步（600ms 窗口内）；断开必须连同定时器一起取消，
    // 否则旧片段（含凭证）会把主进程刚写入的断开结果覆盖回去
    expect(sync).not.toHaveBeenCalled();
    useChannelsStore.getState().disconnectChannel('weixin');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync).not.toHaveBeenCalled();
  });

  it('断开某渠道不影响其它渠道配置', () => {
    useChannelsStore.getState().saveConfig({ kind: 'weixin', token: 'tk' });
    useChannelsStore.getState().saveConfig({ kind: 'lark', appId: 'la', appSecret: 'ls' });
    useChannelsStore.getState().disconnectChannel('weixin');
    const lark = useChannelsStore.getState().configs.find((c) => c.kind === 'lark');
    expect(lark?.appId).toBe('la');
    expect(lark?.appSecret).toBe('ls');
    expect(lark?.enabled).toBe(true);
  });

  it('不触发自动同步（引擎侧已由主进程直写清除，防旧片段回写覆盖）', async () => {
    const sync = vi.mocked(platform.syncNanobotChannels);
    useChannelsStore.getState().saveConfig({ kind: 'weixin', token: 'tk' });
    // 先让 saveConfig 的防抖同步落定，之后单独验证断开本身不触发同步
    await vi.advanceTimersByTimeAsync(600);
    expect(sync).toHaveBeenCalledTimes(1);
    sync.mockClear();

    useChannelsStore.getState().disconnectChannel('weixin');
    // 跨过防抖窗口：断开不得再触发 platform.syncNanobotChannels
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync).not.toHaveBeenCalled();
  });
});

/**
 * V1.5 批次 3：渠道凭据保险库化。
 *
 * 验收判据是「`channels.json` 与同步负载里都没有 secret」，所以这里逐条钉住：
 * 明文真的被剥掉了（且只在保险库确认可用时才剥）、值真的进了保险库、
 * 断开真的把保险库条目删了、升级存量真的被迁移。
 */
describe('channelsStore: 凭据保险库化（批次 3）', () => {
  /** 取最近一次写入 channels key 的持久化文本 */
  function lastChannelsWrite(spy: { mock: { calls: unknown[][] } }): string {
    const hit = spy.mock.calls.filter((call) => call[0] === STORAGE_KEYS.channels).pop();
    return hit ? String(hit[1]) : '';
  }

  it('refreshSecrets 只认 channel: 前缀的保险库条目（MCP 的条目不算渠道）', async () => {
    mockVault({
      'channel:feishu': ['appSecret'],
      'channel:weixin': ['token'],
      'my-mcp-server': ['token'],
    });
    const status = await useChannelsStore.getState().refreshSecrets();
    expect(status.available).toBe(true);
    expect(useChannelsStore.getState().secretKeys).toEqual({
      feishu: ['appSecret'],
      weixin: ['token'],
    });
    expect(useChannelsStore.getState().vaultAvailable).toBe(true);
  });

  it('saveSecrets（electron）以 channel:<kind> 为名写入保险库并刷新清单', async () => {
    enterElectron();
    const entries = mockVault();
    const result = await useChannelsStore.getState().saveSecrets('dingtalk', {
      clientSecret: 'cs',
    });
    expect(result.ok).toBe(true);
    expect(entries['channel:dingtalk']).toEqual(['clientSecret']);
    expect(useChannelsStore.getState().secretKeys.dingtalk).toEqual(['clientSecret']);
  });

  it('saveSecrets 传空集合时不碰保险库（避免把「没填」执行成「删除」）', async () => {
    enterElectron();
    mockVault({ 'channel:weixin': ['token'] });
    await useChannelsStore.getState().saveSecrets('weixin', {});
    expect(platform.secretsSet).not.toHaveBeenCalled();
  });

  it('saveSecrets 在 web 端视为成功但不写保险库（浏览器无 OS 凭据库）', async () => {
    const spy = vi.spyOn(platform, 'secretsSet');
    const result = await useChannelsStore.getState().saveSecrets('weixin', { token: 'tk' });
    expect(result.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('saveConfig（electron）把凭据一并写进保险库', async () => {
    enterElectron();
    const entries = mockVault();
    useChannelsStore.getState().saveConfig({
      kind: 'feishu',
      appId: 'cli_a',
      appSecret: 'secret_a',
    });
    // saveSecrets 是 fire-and-forget：让微任务队列跑完再断言
    await vi.advanceTimersByTimeAsync(0);
    expect(entries['channel:feishu']).toEqual(['appSecret']);
  });

  it('持久化时剥掉密钥明文（保险库确认可用 + electron）', () => {
    enterElectron();
    useChannelsStore.getState().saveConfig({ kind: 'weixin', token: 'plain-token' });
    const spy = vi.spyOn(platform.storage, 'set');
    useChannelsStore.setState({ vaultAvailable: true });

    const written = lastChannelsWrite(spy);
    expect(written).not.toContain('plain-token');
    // 配置本身仍在（只剥密钥，不是整条丢弃）
    expect(written).toContain('weixin');
  });

  it('保险库不可用时不剥明文（剥掉等于把用户填的凭据直接丢弃）', () => {
    enterElectron();
    useChannelsStore.getState().saveConfig({ kind: 'weixin', token: 'plain-token' });
    const spy = vi.spyOn(platform.storage, 'set');
    useChannelsStore.setState({ vaultAvailable: false });

    expect(lastChannelsWrite(spy)).toContain('plain-token');
  });

  it('web 端维持明文落盘（无保险库可迁）', () => {
    useChannelsStore.getState().saveConfig({ kind: 'weixin', token: 'plain-token' });
    const spy = vi.spyOn(platform.storage, 'set');
    useChannelsStore.setState({ vaultAvailable: true });

    // env 仍是 web → 不剥
    expect(lastChannelsWrite(spy)).toContain('plain-token');
  });

  it('vaultExistingSecrets 把存量明文迁进保险库，并推一次持久化把明文剥掉', async () => {
    enterElectron();
    // 存量数据：升级前落盘的明文（此刻运行内存里还带着）。
    // 哨兵值取得足够长，避免被 "tombstones" 之类无关子串撞上
    useChannelsStore.getState().saveConfig({
      kind: 'wecom',
      botId: 'bot-id-sentinel',
      botSecret: 'bot-secret-sentinel',
    });
    useChannelsStore.setState({ vaultAvailable: null });
    const entries = mockVault();
    const spy = vi.spyOn(platform.storage, 'set');

    await useChannelsStore.getState().vaultExistingSecrets();

    expect(entries['channel:wecom']).toEqual(['botSecret']);
    expect(useChannelsStore.getState().vaultAvailable).toBe(true);
    // 迁移后强制写盘：否则明文要等用户下次改配置才被剥掉（验收恰恰看这个文件）
    const written = lastChannelsWrite(spy);
    expect(written).not.toContain('bot-secret-sentinel');
    expect(written).toContain('bot-id-sentinel');
  });

  it('vaultExistingSecrets 在无明文可迁时不写保险库（幂等且无副作用）', async () => {
    enterElectron();
    mockVault();
    await useChannelsStore.getState().vaultExistingSecrets();
    expect(platform.secretsSet).not.toHaveBeenCalled();
  });

  it('disconnectChannel（electron）删除保险库条目，防下次同步把凭据回补回来', async () => {
    enterElectron();
    const entries = mockVault({ 'channel:weixin': ['token'] });
    useChannelsStore.getState().saveConfig({ kind: 'weixin', token: 'tk' });
    await useChannelsStore.getState().refreshSecrets();
    expect(entries['channel:weixin']).toEqual(['token']);

    useChannelsStore.getState().disconnectChannel('weixin');
    await vi.advanceTimersByTimeAsync(0);
    expect(entries['channel:weixin']).toBeUndefined();
    expect(useChannelsStore.getState().secretKeys.weixin ?? []).toEqual([]);
  });

  it('removeConfig（electron）同时清掉保险库条目（防「删掉又配回来」被回补旧凭据）', async () => {
    enterElectron();
    const entries = mockVault({ 'channel:lark': ['appSecret'] });
    useChannelsStore.getState().saveConfig({ kind: 'lark', appId: 'la', appSecret: 'ls' });
    await useChannelsStore.getState().refreshSecrets();
    expect(entries['channel:lark']).toEqual(['appSecret']);

    useChannelsStore.getState().removeConfig('lark');
    await vi.advanceTimersByTimeAsync(0);
    expect(entries['channel:lark']).toBeUndefined();
    expect(useChannelsStore.getState().configs).toHaveLength(0);
  });
});
