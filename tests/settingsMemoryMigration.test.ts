import { describe, it, expect } from 'vitest';
import {
  useSettingsStore,
  DEFAULT_TRANSCRIPTION,
  DEFAULT_DESKTOP,
} from '@/stores/settingsStore';
import type { Settings } from '@/types';

/**
 * v9 迁移：`autoSummarize` 由默认关改为默认开。
 *
 * 这条迁移不是「换个默认值」那么轻：旧默认 false 的后果是整条跨会话记忆链路
 * 从未被触发过（实测 `~/.nanowork/` 下连 memory 目录都没被创建过一次）。
 * 老用户升级时若不被提升为 true，修完的实现对他们依然是「没有记忆」。
 *
 * 取值来源刻意用 `getOptions().migrate` 而不是自己复刻一份逻辑：
 * 复刻的那份会随实现漂移，测试就失去意义。
 */
function runMigrate(persisted: unknown, version = 8) {
  const options = useSettingsStore.persist.getOptions();
  const migrate = options.migrate as
    | ((state: unknown, version: number) => unknown)
    | undefined;
  expect(migrate).toBeTypeOf('function');
  return migrate!(persisted, version) as { settings: Settings };
}

describe('settingsStore v9 迁移：自动沉淀默认开启', () => {
  it('默认设置里 autoSummarize 为 true', () => {
    expect(useSettingsStore.getState().settings.autoSummarize).toBe(true);
  });

  it('历史持久化里的 false 被提升为 true', () => {
    const next = runMigrate({
      settings: { autoSummarize: false, gatewayEndpoint: 'http://127.0.0.1:8765/v1' },
      status: 'offline',
    });
    expect(next.settings.autoSummarize).toBe(true);
  });

  it('字段缺失同样收敛为 true（不能吃 undefined）', () => {
    const next = runMigrate({ settings: {}, status: 'offline' });
    expect(next.settings.autoSummarize).toBe(true);
  });

  it('迁移不改动其它字段，并补齐嵌套默认值', () => {
    const next = runMigrate({
      settings: { theme: 'light', memoryEnabled: false },
      status: 'offline',
    });
    expect(next.settings.theme).toBe('light');
    expect(next.settings.memoryEnabled).toBe(false);
    expect(next.settings.transcription).toEqual(DEFAULT_TRANSCRIPTION);
    expect(next.settings.desktop).toEqual(DEFAULT_DESKTOP);
  });
});
