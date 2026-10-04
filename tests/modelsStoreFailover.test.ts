/**
 * modelsStore 的回退链那一半（FR-9.4）。
 *
 * 纯逻辑（链的编辑规则、引擎形状的转换）分别在
 * `tests/lib/modelFallbacks.test.ts` 与 `tests/electron/modelFallbacksConfig.test.ts` 里锁。
 * 这里只锁**store 这一层的两件事**：
 *
 * 1. **顺序不能被归一**：`buildManaged` 会给预设表排序（默认排最前），那套规则套到
 *    回退链上就是直接改错东西——链的顺序就是重试顺序。
 * 2. **桥说失败就不装作成功**：主进程拒绝写入时不能回读、不能把本地状态改成
 *    「已保存」，否则用户看到的是「配好了」，而文件里一个字没变。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionManager } from '@/ai/connectionManager';
import { platform } from '@/platform';
import { useModelsStore } from '@/stores/modelsStore';
import type {
  ModelsSyncResult,
  NanobotFallbackCandidate,
  NanobotModelsSnapshot,
} from '@/platform/types';

const getModels = vi.fn<() => Promise<NanobotModelsSnapshot | null>>();
const syncModels = vi.fn<(json: string) => Promise<ModelsSyncResult>>();

function snapshot(over: Partial<NanobotModelsSnapshot> = {}): NanobotModelsSnapshot {
  return {
    presets: {
      sciherd: { model: 'Qwen3.8-Flash', provider: 'dashscope' } as never,
      deepseek: { model: 'deepseek-chat', provider: 'deepseek' } as never,
    },
    providers: {},
    defaultPreset: 'sciherd',
    fallbacks: [],
    providerRetryMode: 'standard',
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  getModels.mockReset();
  syncModels.mockReset();
  vi.spyOn(platform, 'getNanobotModels').mockImplementation(() => getModels());
  vi.spyOn(platform, 'syncNanobotModels').mockImplementation((json) => syncModels(json));
  // 拉目录会真的发请求；这里只需要它别把用例带崩（目录不是本文件的被测对象）
  vi.spyOn(connectionManager, 'getClient').mockResolvedValue({
    listModels: async () => [],
  } as never);

  useModelsStore.setState({
    models: [],
    managed: [],
    managedFallbacks: [],
    managedAvailable: false,
    providerRetryMode: 'standard',
  });
});

describe('loadManaged：把回退链与重试模式一并读进来', () => {
  it('⭐ 链的**顺序原样保留**（不做任何排序）', async () => {
    getModels.mockResolvedValue(
      snapshot({
        fallbacks: [
          { kind: 'preset', preset: 'zzz' },
          { kind: 'preset', preset: 'aaa' },
        ],
        providerRetryMode: 'persistent',
      }),
    );

    await useModelsStore.getState().loadManaged(true);

    const state = useModelsStore.getState();
    expect(state.providerRetryMode).toBe('persistent');
    // 预设表的 `managed` 会被排序，回退链**不能**跟着排
    expect(state.managedFallbacks.map((c) => (c.kind === 'preset' ? c.preset : ''))).toEqual([
      'zzz',
      'aaa',
    ]);
  });

  it('内联项保真读入（不是被丢成预设引用）', async () => {
    const inline: NanobotFallbackCandidate = {
      kind: 'inline',
      model: 'm',
      provider: 'p',
      maxTokens: 100,
      contextWindowTokens: null,
      temperature: null,
      reasoningEffort: null,
    };
    getModels.mockResolvedValue(snapshot({ fallbacks: [inline] }));

    await useModelsStore.getState().loadManaged(true);

    expect(useModelsStore.getState().managedFallbacks).toEqual([inline]);
  });

  it('读不到快照（Web 端 / 无 config.json）→ 清空链，不留上一个环境的残留', async () => {
    useModelsStore.setState({
      managedFallbacks: [{ kind: 'preset', preset: 'stale' }],
      managedAvailable: true,
    });
    getModels.mockResolvedValue(null);

    await useModelsStore.getState().loadManaged(true);

    const state = useModelsStore.getState();
    expect(state.managedFallbacks).toEqual([]);
    expect(state.managedAvailable).toBe(false);
  });
});

describe('setFailover', () => {
  const chain: NanobotFallbackCandidate[] = [
    { kind: 'preset', preset: 'deepseek' },
    { kind: 'inline', model: 'm', provider: 'p', maxTokens: 5 },
  ];

  it('送出的指令形状：整链 + 重试模式（顺序即语义，写错就改错回退次序）', async () => {
    syncModels.mockResolvedValue({ ok: true, changed: true, message: '已写入' });
    getModels.mockResolvedValue(snapshot({ fallbacks: chain, providerRetryMode: 'persistent' }));

    const ok = await useModelsStore.getState().setFailover(chain, 'persistent');

    expect(ok).toBe(true);
    expect(syncModels).toHaveBeenCalledTimes(1);
    expect(JSON.parse(syncModels.mock.calls[0]![0])).toEqual({
      op: 'setFailover',
      fallbacks: chain,
      providerRetryMode: 'persistent',
    });
  });

  it('⭐ 桥拒绝时返回 false 且**不回读**（不装作已保存）', async () => {
    syncModels.mockResolvedValue({ ok: false, changed: false, message: '回退链格式非法' });

    const ok = await useModelsStore.getState().setFailover(chain, 'standard');

    expect(ok).toBe(false);
    // 没落盘就不该去读盘：回读会把「界面上那份还没保存的链」换成磁盘上的旧链，
    // 用户会看到自己刚做的编辑被无声回退
    expect(getModels).not.toHaveBeenCalled();
  });

  it('成功后以磁盘为准回读（主进程会做引用归一，本地乐观状态可能与文件不一致）', async () => {
    syncModels.mockResolvedValue({ ok: true, changed: true, message: '已写入' });
    getModels.mockResolvedValue(snapshot({ fallbacks: [{ kind: 'preset', preset: 'canonical' }] }));

    await useModelsStore.getState().setFailover(chain, 'standard');

    expect(getModels).toHaveBeenCalled();
    expect(useModelsStore.getState().managedFallbacks).toEqual([
      { kind: 'preset', preset: 'canonical' },
    ]);
  });
});
