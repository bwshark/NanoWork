/**
 * 模型「保存即生效」这条链（FR：配置变更立刻生效，不必重启网关）。
 *
 * 背景：引擎把 modelPresets 装配成**启动时的快照**，客户端写完配置文件若不通知引擎
 * 热加载，`/v1/models` 仍是旧目录 —— 用户表现为「保存成功了，但对话页的模型下拉里
 * 没有新加的那个」。以前唯一的解法是重启网关，UI 也只能这么提示。
 *
 * 这里钉三件事：
 * 1. 保存后**先热加载再回读目录**（顺序反了就会拉到旧目录）；
 * 2. 热加载成功 ⇒ `needsRestart` 被清掉（UI 不再提示重启）；
 * 3. 网关不支持热加载（老版本）⇒ 保留 `needsRestart`，降级提示必须还在。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionManager } from '@/ai/connectionManager';
import { platform } from '@/platform';
import { useModelsStore } from '@/stores/modelsStore';
import type { ModelsSyncResult } from '@/platform/types';

const syncModels = vi.fn<(json: string) => Promise<ModelsSyncResult>>();
const reloadEngineConfig = vi.fn<() => Promise<boolean>>();
const listModels = vi.fn<() => Promise<never[]>>();

function formValue(name: string) {
  return {
    name,
    model: name,
    provider: 'dashscope',
    providerLabel: '阿里云 DashScope（通义）',
    providerKey: 'dashscope',
    providerDisplayName: '阿里云 DashScope（通义）',
    apiKey: '',
    apiBase: '',
    custom: false,
    customProviderName: '',
    contextWindowTokens: null,
    maxTokens: null,
    reasoningEffort: null,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    customProtocol: false,
    pricing: null,
    setDefault: false,
  } as never;
}

beforeEach(() => {
  vi.restoreAllMocks();
  syncModels.mockReset();
  reloadEngineConfig.mockReset();
  listModels.mockReset().mockResolvedValue([]);

  vi.spyOn(platform, 'syncNanobotModels').mockImplementation((json) => syncModels(json));
  vi.spyOn(platform, 'getNanobotModels').mockResolvedValue(null);
  vi.spyOn(connectionManager, 'getClient').mockResolvedValue({
    listModels,
    reloadEngineConfig,
  } as never);

  useModelsStore.setState({
    models: [],
    managed: [],
    managedFallbacks: [],
    managedAvailable: false,
    providerRetryMode: 'standard',
  });
});

describe('模型保存即生效：热加载链', () => {
  it('保存后调用引擎热加载，并把 needsRestart 清掉', async () => {
    // 主进程仍按老规矩给 needsRestart（serve 由外部托管）——热加载成功后就不该再提示重启
    syncModels.mockResolvedValue({ ok: true, message: 'saved', needsRestart: true });
    reloadEngineConfig.mockResolvedValue(true);

    const result = await useModelsStore.getState().saveModel(formValue('qwen3.8-flash'));

    expect(reloadEngineConfig).toHaveBeenCalledTimes(1);
    expect(result.needsRestart).toBe(false);
  });

  it('热加载在回读目录之前完成（顺序反了就会拉到旧目录）', async () => {
    syncModels.mockResolvedValue({ ok: true, message: 'saved' });
    reloadEngineConfig.mockResolvedValue(true);

    const order: string[] = [];
    reloadEngineConfig.mockImplementation(async () => {
      order.push('reload');
      return true;
    });
    listModels.mockImplementation(async () => {
      order.push('listModels');
      return [];
    });

    await useModelsStore.getState().saveModel(formValue('qwen3.8-flash'));

    expect(order).toEqual(['reload', 'listModels']);
  });

  it('网关不支持热加载时保留 needsRestart（老网关仍要提示重启）', async () => {
    syncModels.mockResolvedValue({ ok: true, message: 'saved', needsRestart: true });
    reloadEngineConfig.mockResolvedValue(false);

    const result = await useModelsStore.getState().saveModel(formValue('qwen3.8-flash'));

    expect(result.needsRestart).toBe(true);
    // 目录仍要回读：主进程说「外部托管」不等于目录不会变（外部可能恰好也热加载了）
    expect(listModels).toHaveBeenCalled();
  });

  it('热加载接口抛错也不阻断保存（配置已写盘，不能让 UI 卡在失败）', async () => {
    syncModels.mockResolvedValue({ ok: true, message: 'saved', needsRestart: true });
    reloadEngineConfig.mockRejectedValue(new Error('network down'));

    const result = await useModelsStore.getState().saveModel(formValue('qwen3.8-flash'));

    expect(result.ok).toBe(true);
    expect(result.needsRestart).toBe(true);
  });

  it('删除模型同样走热加载', async () => {
    syncModels.mockResolvedValue({ ok: true, message: 'deleted' });
    reloadEngineConfig.mockResolvedValue(true);
    useModelsStore.setState({
      managed: [
        {
          name: 'qwen3.8-flash',
          model: 'qwen3.8-flash',
          provider: 'dashscope',
          providerKey: 'dashscope',
          providerLabel: 'DashScope',
          apiKey: '',
          apiBase: '',
          hasKey: true,
          isDefault: false,
          custom: false,
          contextWindowTokens: null,
          maxTokens: null,
          reasoningEffort: null,
          supportsTools: true,
          supportsVision: false,
          supportsReasoning: true,
          customProtocol: false,
          pricing: null,
        } as never,
      ],
    });

    await useModelsStore.getState().removeModel('qwen3.8-flash');

    expect(reloadEngineConfig).toHaveBeenCalledTimes(1);
  });
});