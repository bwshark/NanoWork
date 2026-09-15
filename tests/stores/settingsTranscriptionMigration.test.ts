import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP, useSettingsStore } from '@/stores/settingsStore';
import { DEFAULT_GATEWAY, STORAGE_KEYS } from '@/lib/constants';

/**
 * settingsStore persist version 3 → 4 迁移测试。
 *
 * 迁移关键风险：`transcription` 是**嵌套对象**，persist 的浅合并拿不到内层默认值。
 * 老用户升级后若 settings.transcription 为 undefined，语音面板 / Composer 里
 * `transcription.model.trim()` 会直接抛错白屏。本文件直接走真实 rehydrate 通道
 * （写旧版持久化数据 → 触发 migrate）验证，而非只做静态推断。
 */

/**
 * 写入一份「旧版本」持久化数据并重新水合，模拟老用户升级。
 *
 * 注意存储链路上有两层 JSON：platform.storage 适配器自身会 JSON.parse，
 * 外层 createJSONStorage 再 parse 一次。因此落盘必须是「JSON 字符串的 JSON 字符串」，
 * 与真实 setItem 写入的形态保持一致。
 */
async function rehydrateLegacy(state: unknown, version: number): Promise<void> {
  localStorage.setItem(
    STORAGE_KEYS.settings,
    JSON.stringify(JSON.stringify({ state, version })),
  );
  await useSettingsStore.persist.rehydrate();
}

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: DEFAULT_GATEWAY,
      apiToken: '',
      theme: 'dark',
      memoryEnabled: true,
      autoSummarize: false,
      transcription: DEFAULT_TRANSCRIPTION,
      desktop: DEFAULT_DESKTOP,
    },
    status: 'offline',
  });
});

describe('settingsStore 迁移 v3 → v4：transcription 补齐', () => {
  it('v3 数据无 transcription 字段：补齐默认配置且不覆盖用户既有设置', async () => {
    await rehydrateLegacy(
      {
        settings: {
          gatewayEndpoint: DEFAULT_GATEWAY,
          apiToken: 'tok-legacy',
          theme: 'dark',
          memoryEnabled: false,
          autoSummarize: true,
        },
        status: 'offline',
      },
      3,
    );

    const s = useSettingsStore.getState().settings;
    expect(s.transcription).toEqual(DEFAULT_TRANSCRIPTION);
    expect(s.transcription.enabled).toBe(false);
    expect(s.transcription.model).toBe('whisper-1');
    // 用户既有值必须保留
    expect(s.apiToken).toBe('tok-legacy');
    expect(s.memoryEnabled).toBe(false);
    expect(s.autoSummarize).toBe(true);
    expect(s.theme).toBe('dark');
  });

  it('迁移后可安全访问 transcription 内部字段（不会 undefined 崩溃）', async () => {
    await rehydrateLegacy(
      { settings: { gatewayEndpoint: DEFAULT_GATEWAY }, status: 'offline' },
      3,
    );
    const t = useSettingsStore.getState().settings.transcription;
    // Composer 里会直接调 .trim()，此处必须能跑通
    expect(() => t.model.trim()).not.toThrow();
    expect(() => t.endpoint.trim()).not.toThrow();
    expect(() => t.apiToken.trim()).not.toThrow();
    expect(() => t.language.trim()).not.toThrow();
    expect(t.enabled).toBe(false);
  });

  it('v3 数据带部分 transcription 字段：保留已有值、补齐缺失项', async () => {
    await rehydrateLegacy(
      {
        settings: {
          gatewayEndpoint: DEFAULT_GATEWAY,
          transcription: { enabled: true, model: 'whisper-large-v3' },
        },
        status: 'offline',
      },
      3,
    );

    const t = useSettingsStore.getState().settings.transcription;
    expect(t.enabled).toBe(true);
    expect(t.model).toBe('whisper-large-v3');
    expect(t.endpoint).toBe(DEFAULT_TRANSCRIPTION.endpoint);
    expect(t.apiToken).toBe('');
    expect(t.language).toBe('zh');
  });

  it('更老的 version 0（无 version 字段的历史数据）同样能补齐', async () => {
    await rehydrateLegacy(
      { settings: { gatewayEndpoint: DEFAULT_GATEWAY, theme: 'light' }, status: 'offline' },
      0,
    );
    const s = useSettingsStore.getState().settings;
    expect(s.transcription).toEqual(DEFAULT_TRANSCRIPTION);
    expect(s.theme).toBe('light');
  });

  it('旧网关地址（:8765）被改写为当前默认网关', async () => {
    await rehydrateLegacy(
      { settings: { gatewayEndpoint: 'http://127.0.0.1:8765/v1' }, status: 'offline' },
      3,
    );
    expect(useSettingsStore.getState().settings.gatewayEndpoint).toBe(DEFAULT_GATEWAY);
  });

  it('已移除的 mode 字段被丢弃，不残留进新 state', async () => {
    await rehydrateLegacy(
      {
        settings: { gatewayEndpoint: DEFAULT_GATEWAY, mode: 'legacy-mode' },
        status: 'offline',
      },
      3,
    );
    const s = useSettingsStore.getState().settings as unknown as { mode?: unknown };
    expect(s.mode).toBeUndefined();
  });
});

describe('settingsStore 迁移健壮性', () => {
  it('非法 theme 兜底为 dark', async () => {
    await rehydrateLegacy(
      { settings: { gatewayEndpoint: DEFAULT_GATEWAY, theme: 'neon' }, status: 'offline' },
      3,
    );
    expect(useSettingsStore.getState().settings.theme).toBe('dark');
  });

  it('state 为 null 时不崩，回退默认设置', async () => {
    await expect(rehydrateLegacy(null, 3)).resolves.toBeUndefined();
    const s = useSettingsStore.getState().settings;
    expect(s.gatewayEndpoint).toBe(DEFAULT_GATEWAY);
    expect(s.transcription).toEqual(DEFAULT_TRANSCRIPTION);
  });

  it('持久化为损坏 JSON 时不崩，回退默认设置', async () => {
    localStorage.setItem(STORAGE_KEYS.settings, '{not-json');
    await expect(useSettingsStore.persist.rehydrate()).resolves.toBeUndefined();
    expect(useSettingsStore.getState().settings.transcription).toEqual(
      DEFAULT_TRANSCRIPTION,
    );
  });
});
