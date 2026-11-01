/**
 * 语音设置分区：**合成（TTS）必须有可编辑的入口**。
 *
 * 锁的是一条真实发生的失效：`settings.tts` 字段与 `resolveTtsConfig` 早就存在，
 * 但设置页只有转录（STT），于是用户只能在配置文件里手写合成配置，
 * 界面上永远是「已改用系统语音播报」，看着像功能没做。
 *
 * 第二个断言守的是**语义保真**：`tts` 整段缺失时 `resolveTtsConfig` 会跟随
 * `transcription`（转录开着 = 这台机器上有可用的工作区与凭据）。草稿若直接取
 * `DEFAULT_TTS`（`enabled: false`），用户只是点一下保存就把继承来的开启态固化成
 * 关闭——语音讨论突然变哑巴，而他什么都没改。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@mui/material';
import { muiTheme } from '@/theme/muiTheme';
import { VoiceSection } from '@/components/settings/sections/VoiceSection';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import { DEFAULT_MEMORY_POLICY, type Settings } from '@/types';
import { click, flush, mount, unmount } from '../helpers/reactMount';

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    gatewayEndpoint: 'http://127.0.0.1:8900/v1',
    apiToken: '',
    theme: 'dark',
    processDetail: 'key',
    memoryEnabled: true,
    autoSummarize: true,
    memoryRecall: true,
    memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
    transcription: {
      ...DEFAULT_TRANSCRIPTION,
      enabled: true,
      // 合成可以沿用转录的 Key，所以这里给一个非空值让保存校验通过
      apiToken: 'sk-shared',
    },
    desktop: { ...DEFAULT_DESKTOP },
    workspaceAliases: {},
    knownWorkspaces: [],
    sidebarCollapsed: false,
    hiddenSessions: [],
    shortcuts: {},
    ...overrides,
  };
}

function renderSection(): void {
  mount(
    <ThemeProvider theme={muiTheme}>
      <VoiceSection />
    </ThemeProvider>,
  );
}

/** MUI 的 Switch 渲染成 `input[type=checkbox]`，按出现顺序取第 n 个 */
function switches(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll('input[type="checkbox"]'),
  ) as HTMLInputElement[];
}

function buttonByText(text: string): HTMLElement | null {
  return (
    (Array.from(document.querySelectorAll('button')) as HTMLElement[]).find((b) =>
      (b.textContent ?? '').includes(text),
    ) ?? null
  );
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  unmount();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('VoiceSection', () => {
  it('转录与合成两组配置都在同一个分区里', () => {
    useSettingsStore.setState({ settings: baseSettings({ tts: undefined }) });
    renderSection();

    const text = document.body.textContent ?? '';
    expect(text).toContain('语音输入');
    expect(text).toContain('语音合成');
    // 合成侧的字段一个都不能少：缺了任意一个，用户就只能去改配置文件
    expect(text).toContain('合成模型');
    expect(text).toContain('音色');
    expect(text).toContain('保存语音合成');
    expect(buttonByText('试听')).toBeTruthy();
  });

  it('未配置合成时草稿跟随转录：开关是开着的，保存后也不会把它关掉', async () => {
    useSettingsStore.setState({
      settings: baseSettings({ transcription: { ...baseSettings().transcription!, enabled: true }, tts: undefined }),
    });
    renderSection();

    // 第 2 个开关 = 「启用云端合成」
    const [, ttsSwitch] = switches();
    expect(ttsSwitch.checked).toBe(true);

    click(buttonByText('保存语音合成'));
    await flush();

    const saved = useSettingsStore.getState().settings.tts;
    expect(saved?.enabled, '保存把继承来的开启态写成了关闭').toBe(true);
  });

  it('已配置合成时展示已保存的模型与音色', () => {
    useSettingsStore.setState({
      settings: baseSettings({
        tts: {
          enabled: true,
          endpoint: '',
          model: 'qwen3-tts-flash',
          voice: 'Ethan',
          apiToken: '',
          fallbackToSystem: true,
        },
      }),
    });
    renderSection();

    const inputs = Array.from(
      document.querySelectorAll('input[type="text"], input:not([type])'),
    ) as HTMLInputElement[];
    const values = inputs.map((el) => el.value);
    expect(values).toContain('qwen3-tts-flash');
    expect(values).toContain('Ethan');
  });
});
