/**
 * `Settings` 的同步负载裁剪（architecture-syncmeta §3.3 / FR-10.5）。
 *
 * `Settings` 是唯一一个把「用户偏好」与「本机环境」装在同一个对象里的实体。
 * 把 `gatewayEndpoint` 同步过去，对方的客户端会去连**你的**机器——这条 FR-10.5
 * 明文点名过，但只写在文档里是拦不住人的：下一个人照样可能把 `settings`
 * 整个丢给同步层。所以用会红的用例钉住。
 *
 * 同时守一条 nested 边界：`transcription` 是嵌套对象，**不能整块剔**——那会把
 * 「想用语音输入、用哪个模型、说什么语言」这三个正当偏好一起扔掉。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_DESKTOP, DEFAULT_TRANSCRIPTION } from '@/stores/settingsStore';
import {
  SETTINGS_SYNC_OMIT_KEYS,
  TRANSCRIPTION_SYNC_OMIT_KEYS,
  TTS_SYNC_OMIT_KEYS,
  toSyncPayload,
} from '@/lib/sync/settingsSync';
import type { Settings, TtsConfig } from '@/types';
import { DEFAULT_MEMORY_POLICY } from '@/types';

/** 一份配好的语音合成（含凭据，用来验证它们不上行） */
const TTS_WITH_SECRETS: TtsConfig = {
  enabled: true,
  endpoint: 'https://dashscope.aliyuncs.com',
  model: 'qwen3-tts-flash',
  voice: 'Cherry',
  apiToken: 'secret-tts-token',
  fallbackToSystem: true,
};

/** 一份「什么都有」的设置：机器字段、凭据、偏好全占满 */
function fullSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    gatewayEndpoint: 'http://127.0.0.1:8765/v1',
    apiToken: 'secret-gateway-token',
    theme: 'dark',
    processDetail: 'key',
    memoryEnabled: true,
    autoSummarize: true,
    memoryRecall: true,
    memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
    transcription: {
      enabled: true,
      provider: 'groq',
      endpoint: 'http://127.0.0.1:9999/v1',
      model: 'whisper-1',
      apiToken: 'secret-stt-token',
      language: 'zh',
    },
    desktop: { ...DEFAULT_DESKTOP, hotkey: 'Ctrl+Alt+S' },
    promptDomain: 'code',
    promptStyle: 'style-professional',
    userCustomPrompt: '总是用中文',
    workspaceAliases: { 'D:\\dev': '开发' },
    knownWorkspaces: ['D:\\dev'],
    sidebarCollapsed: true,
    hiddenSessions: ['s-1', 's-2'],
    primaryMenuOrder: ['tasks', 'knowledge', 'capabilities', 'more'],
    moreMenuOrder: ['projects', 'audit'],
    shortcuts: {},
    enabledPlugins: ['foo@bar'],
    defaultWorkspacePath: 'C:\\Users\\tester\\NanoWork',
    ...overrides,
  };
}

describe('toSyncPayload：本机环境与凭据都不上行', () => {
  it('网关地址与网关令牌不上行（否则对方会去连你的机器）', () => {
    const payload = toSyncPayload(fullSettings());

    expect(payload).not.toHaveProperty('gatewayEndpoint');
    expect(payload).not.toHaveProperty('apiToken');
  });

  it('桌面能力整块不上行（托盘 / 热键是机器专属，Web 端只有占位）', () => {
    const payload = toSyncPayload(fullSettings());

    expect(payload).not.toHaveProperty('desktop');
  });

  it('本地路径类字段不上行（键是绝对路径，跨设备不成立）', () => {
    const payload = toSyncPayload(fullSettings());

    for (const key of ['defaultWorkspacePath', 'knownWorkspaces', 'workspaceAliases']) {
      expect(payload, `${key} 是本地路径，不能跨设备搬运`).not.toHaveProperty(key);
    }
  });

  it('hiddenSessions 不上行（§六 问题 2：各设备「我看见什么」本就不同）', () => {
    const payload = toSyncPayload(fullSettings());

    expect(payload).not.toHaveProperty('hiddenSessions');
  });

  it('转录的 endpoint / apiToken 被剔，但三个偏好字段留着', () => {
    const payload = toSyncPayload(fullSettings());

    expect(payload.transcription).not.toHaveProperty('endpoint');
    expect(payload.transcription).not.toHaveProperty('apiToken');
    expect(payload.transcription).toMatchObject({
      enabled: true,
      model: 'whisper-1',
      language: 'zh',
    });
  });

  it('凭据是**省略**而不是置空：置空会把对端配好的地址清掉', () => {
    const payload = toSyncPayload(fullSettings());

    // 省略 = 不参与同步，对端保留自己的本机值；置空 = 把空串当真实值推过去
    expect('apiToken' in payload).toBe(false);
    expect('endpoint' in (payload.transcription ?? {})).toBe(false);
  });

  it('语音合成的 endpoint / apiToken 不上行，音色等偏好留着', () => {
    const payload = toSyncPayload(fullSettings({ tts: TTS_WITH_SECRETS }));

    // 合成凭据和转录凭据同级敏感：整块同步会把 Key 推到云端
    expect(payload.tts).not.toHaveProperty('apiToken');
    expect(payload.tts).not.toHaveProperty('endpoint');
    expect(payload.tts).toMatchObject({
      enabled: true,
      model: 'qwen3-tts-flash',
      voice: 'Cherry',
      fallbackToSystem: true,
    });
    for (const key of TTS_SYNC_OMIT_KEYS) {
      expect(payload.tts, `合成排除表列了 ${key}，负载里却还在`).not.toHaveProperty(key);
    }
  });

  it('没配语音合成时负载里不出现 tts（保持「跟随转录」的语义）', () => {
    const payload = toSyncPayload(fullSettings({ tts: undefined }));

    // 造一个空 tts 对象会让对端从「跟随 transcription」变成「显式配了一份空配置」
    expect('tts' in payload).toBe(false);
  });
});

describe('toSyncPayload：偏好要真的跟过来', () => {
  it('纯偏好字段全部保留', () => {
    const payload = toSyncPayload(fullSettings());

    expect(payload).toMatchObject({
      theme: 'dark',
      memoryEnabled: true,
      autoSummarize: true,
      memoryRecall: true,
      promptDomain: 'code',
      promptStyle: 'style-professional',
      userCustomPrompt: '总是用中文',
      sidebarCollapsed: true,
      enabledPlugins: ['foo@bar'],
    });
  });

  it('记忆 v2 的**策略**不上行（各设备可以有自己的门槛）', () => {
    // 与 `memoryEnabled` / `memoryRecall` 的区别：那两个是「要不要这个能力」，
    // 是跨设备成立的**意图**；`memoryPolicy` 是「门槛定在哪」，是**本机策略**
    // ——搬过去只会把对端调好的值覆盖掉（与 `desktop` 同一口径）。
    const payload = toSyncPayload(fullSettings({ memoryPolicy: { ...DEFAULT_MEMORY_POLICY, retentionDays: 7 } }));
    expect('memoryPolicy' in payload).toBe(false);
  });

  it('processDetail 随偏好上行（AC10：它不是本机事实，不得进 omit 名单）', () => {
    const payload = toSyncPayload(fullSettings({ processDetail: 'full' }));

    // 防回归：将来有人误把 processDetail 加进 SETTINGS_SYNC_OMIT_KEYS 时这条会红
    expect(payload).toHaveProperty('processDetail', 'full');
  });

  it('侧边栏菜单顺序随偏好上行（是用户排列，不是本机环境）', () => {
    const payload = toSyncPayload(
      fullSettings({
        primaryMenuOrder: ['more', 'tasks', 'knowledge', 'capabilities'],
        moreMenuOrder: ['audit', 'projects'],
      }),
    );

    // 「我把菜单调成了这样」是跨设备成立的偏好：换台机器应该长得一样。
    // 它不能被误当成「本机环境」——与 hiddenSessions 的区别在于，
    // 那张表描述的是「本机上有哪些会话」，而这张表只是排列。
    expect(payload).toHaveProperty('primaryMenuOrder', [
      'more',
      'tasks',
      'knowledge',
      'capabilities',
    ]);
    expect(payload).toHaveProperty('moreMenuOrder', ['audit', 'projects']);
  });

  it('排除表逐条核对：表里列了的，负载里一个都不能有', () => {
    const payload = toSyncPayload(fullSettings());

    for (const key of SETTINGS_SYNC_OMIT_KEYS) {
      expect(payload, `排除表列了 ${key}，负载里却还在`).not.toHaveProperty(key);
    }
    // 反向护栏：不能把所有字段都剔光（那样「同步设置」就变成了什么都不传）
    expect(Object.keys(payload).length).toBeGreaterThan(5);
  });

  it('转录排除表同理（嵌套那层也要能被逐条核对）', () => {
    const payload = toSyncPayload(fullSettings());

    for (const key of TRANSCRIPTION_SYNC_OMIT_KEYS) {
      expect(payload.transcription, `转录排除表列了 ${key}，负载里却还在`).not.toHaveProperty(key);
    }
    expect(Object.keys(payload.transcription ?? {}).length).toBeGreaterThan(2);
  });

  it('默认设置（无任何偏好改动）也能安全裁剪，不抛错', () => {
    const payload = toSyncPayload(
      fullSettings({
        transcription: DEFAULT_TRANSCRIPTION,
        desktop: DEFAULT_DESKTOP,
        workspaceAliases: undefined,
        knownWorkspaces: undefined,
        hiddenSessions: undefined,
        defaultWorkspacePath: undefined,
      }),
    );

    // 只断言「该留的留、该剔的剔」，不断言具体模型名：
    // 模型默认值属于 provider 目录的职责（`lib/voice/providers.ts`），
    // 在这里写死会让「换默认 provider」这种正当改动变成假红。
    expect(payload.transcription).toEqual({
      enabled: DEFAULT_TRANSCRIPTION.enabled,
      provider: DEFAULT_TRANSCRIPTION.provider,
      model: DEFAULT_TRANSCRIPTION.model,
      language: DEFAULT_TRANSCRIPTION.language,
    });
    // endpoint / apiToken 是本机凭据，绝不能上云
    expect(payload.transcription).not.toHaveProperty('endpoint');
    expect(payload.transcription).not.toHaveProperty('apiToken');
  });
});
