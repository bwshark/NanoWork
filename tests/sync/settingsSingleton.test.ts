/**
 * `settings` 单例：C.2 rev bump 规则 + C.4/C.5 落地浅合并与本机字段保留。
 *
 * 覆盖 §I.3 变异清单：
 * - **D-④** `apply` 的 `transcription` 改顶层浅合并 → 「pull 后 `transcription.endpoint` 保留」变红；
 * - **D-⑤** `apply` 改整对象替换 → 「pull 后 `gatewayEndpoint`/`knownWorkspaces` 保留」变红；
 * - **C.2** 只有改可同步字段的动作才 bump `rev`。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '@/sync/syncRegistry';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Settings } from '@/types';

function baseSettings(): Settings {
  return {
    gatewayEndpoint: 'http://127.0.0.1:8765/v1',
    apiToken: 'local-token',
    theme: 'dark',
    processDetail: 'key',
    memoryEnabled: true,
    autoSummarize: true,
    transcription: {
      enabled: false,
      endpoint: 'http://local',
      model: 'whisper-1',
      apiToken: 'stt-token',
      language: 'zh',
    },
    desktop: { closeToTray: true, hotkey: '', openAtLogin: false, showInDock: true },
    workspaceAliases: {},
    knownWorkspaces: ['/Users/me/work'],
    sidebarCollapsed: false,
    hiddenSessions: ['s-hidden'],
    shortcuts: {},
  };
}

function settingsSpec() {
  return createDefaultRegistry().get('settings')!;
}

beforeEach(() => {
  useSettingsStore.setState({
    settings: baseSettings(),
    syncMeta: { rev: 0, updatedAt: '', updatedBy: '', deletedAt: null },
  });
});

// ─────────────────────────── C.2 rev bump 规则 ───────────────────────────

describe('C.2：settingsStore 的同步元数据 bump 规则', () => {
  it('setSettings（改可同步字段）→ rev +1', () => {
    useSettingsStore.getState().setSettings({ theme: 'light' });
    expect(useSettingsStore.getState().syncMeta.rev).toBe(1);
  });

  it('setStatus（连接态，本机事实）→ rev 不变', () => {
    useSettingsStore.getState().setSettings({ theme: 'light' }); // rev: 0 → 1
    useSettingsStore.getState().setStatus('connected');
    expect(useSettingsStore.getState().syncMeta.rev).toBe(1);
  });

  it('rememberWorkspace / hideSessions（字段在排除表里）→ rev 不变', () => {
    useSettingsStore.getState().rememberWorkspace('/new/ws');
    useSettingsStore.getState().hideSessions(['s2']);
    expect(useSettingsStore.getState().syncMeta.rev).toBe(0);
  });

  it('resetShortcuts → rev +1（清空快捷键是可同步改动）', () => {
    useSettingsStore.getState().resetShortcuts();
    expect(useSettingsStore.getState().syncMeta.rev).toBe(1);
  });
});

// ─────────────────────────── C.4 / C.5 落地 ───────────────────────────

describe('C.4 / C.5：apply 浅合并 + transcription 内层合并，本机字段绝不被动', () => {
  it('pull 一条 settings：远端偏好落地，本机环境字段全部保留', () => {
    settingsSpec().apply({
      id: 'local',
      theme: 'light',
      memoryEnabled: false,
      transcription: { enabled: true, model: 'whisper-large-v3', language: 'en' },
      rev: 5,
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'dev-b',
      deletedAt: null,
    });

    const { settings, syncMeta } = useSettingsStore.getState();
    // 远端偏好落地
    expect(settings.theme).toBe('light');
    expect(settings.memoryEnabled).toBe(false);
    expect(settings.transcription.enabled).toBe(true);
    expect(settings.transcription.model).toBe('whisper-large-v3');
    // 本机字段保留（D-⑤：整对象替换会让它们凭空消失）
    expect(settings.gatewayEndpoint).toBe('http://127.0.0.1:8765/v1');
    expect(settings.apiToken).toBe('local-token');
    expect(settings.knownWorkspaces).toEqual(['/Users/me/work']);
    expect(settings.hiddenSessions).toEqual(['s-hidden']);
    expect(settings.desktop).toMatchObject({ closeToTray: true });
    // D-④：transcription 内层合并缺失的 endpoint/apiToken 不被清空
    expect(settings.transcription.endpoint).toBe('http://local');
    expect(settings.transcription.apiToken).toBe('stt-token');
    // 元数据以对端为准
    expect(syncMeta.rev).toBe(5);
    expect(syncMeta.updatedBy).toBe('dev-b');
  });

  it('pull 一条不含 transcription 的 settings：本机 transcription 原样', () => {
    settingsSpec().apply({
      id: 'local',
      theme: 'light',
      rev: 2,
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'dev-b',
      deletedAt: null,
    });
    const { settings } = useSettingsStore.getState();
    expect(settings.transcription).toEqual(baseSettings().transcription);
    expect(settings.gatewayEndpoint).toBe('http://127.0.0.1:8765/v1');
  });

  it('payload 里不含本机环境字段（gatewayEndpoint / apiToken / 路径类）', () => {
    const entities = settingsSpec().read().entities;
    const payload = settingsSpec().payload(entities[0]);
    for (const key of ['gatewayEndpoint', 'apiToken', 'desktop', 'knownWorkspaces', 'workspaceAliases', 'hiddenSessions']) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(payload).toMatchObject({ id: 'local', theme: 'dark' });
  });
});
