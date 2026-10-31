import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@mui/material';
import { muiTheme } from '@/theme/muiTheme';
import { VoiceDiscussionButton } from '@/components/composer/VoiceDiscussionButton';
import {
  VoiceDiscussionDialog,
  type VoiceDiscussionDialogProps,
} from '@/components/voice/VoiceDiscussionDialog';
import { byAria, click, dialogRoot, mount, unmount } from '../helpers/reactMount';

vi.mock('@/components/voice/VoiceRing', () => ({
  VoiceRing: () => <div data-testid="voice-ring" />,
}));

function themed(node: React.ReactElement) {
  return <ThemeProvider theme={muiTheme}>{node}</ThemeProvider>;
}

function dialogProps(
  overrides: Partial<VoiceDiscussionDialogProps> = {},
): VoiceDiscussionDialogProps {
  return {
    open: true,
    phase: 'listening',
    seconds: 65,
    level: 0.4,
    turns: [],
    liveText: '正在识别这句话',
    muted: false,
    subtitles: false,
    notice: null,
    onToggleMute: vi.fn(),
    onToggleSubtitles: vi.fn(),
    onFinish: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  unmount();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('VoiceDiscussionButton', () => {
  it('显示语音讨论入口并响应点击', () => {
    const onClick = vi.fn();
    mount(
      themed(
        <VoiceDiscussionButton
          active={false}
          disabled={false}
          disabledReason={null}
          onClick={onClick}
        />,
      ),
    );
    const button = document.querySelector('[data-testid="composer-voice-discussion"]');
    expect(button).toBeTruthy();
    click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('禁用时不触发动作，并保留不可用原因', () => {
    const onClick = vi.fn();
    mount(
      themed(
        <VoiceDiscussionButton
          active={false}
          disabled
          disabledReason="请选择实时识别模型"
          onClick={onClick}
        />,
      ),
    );
    const button = document.querySelector(
      'button[data-testid="composer-voice-discussion"]',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('VoiceDiscussionDialog', () => {
  it('显示计时、实时识别和状态，静音/结束/关闭均可用', () => {
    const props = dialogProps();
    mount(themed(<VoiceDiscussionDialog {...props} />));
    const root = dialogRoot();
    expect(root.textContent).toContain('1:05');
    expect(root.textContent).toContain('正在听…');
    expect(root.textContent).not.toContain('说点什么');
    expect(document.querySelector('[data-testid="voice-ring"]')).toBeTruthy();

    click(root.querySelector('button[aria-label="静音"]'));
    expect(props.onToggleMute).toHaveBeenCalledTimes(1);
    click(root.querySelector('button[aria-label="开启字幕"]'));
    expect(props.onToggleSubtitles).toHaveBeenCalledTimes(1);
    click(byAria('结束语音讨论', root));
    expect(props.onFinish).toHaveBeenCalledTimes(1);
    click(root.querySelector('button[aria-label="关闭语音讨论"]'));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('字幕模式展示双方气泡与中间识别文本', () => {
    mount(
      themed(
        <VoiceDiscussionDialog
          {...dialogProps({
            subtitles: true,
            turns: [
              { id: 'u1', role: 'user', text: '讨论入口放哪里？' },
              { id: 'a1', role: 'assistant', text: '放在发送键旁边。' },
            ],
            liveText: '还有一句正在说',
          })}
        />,
      ),
    );
    const root = dialogRoot();
    expect(root.textContent).toContain('讨论入口放哪里？');
    expect(root.textContent).toContain('放在发送键旁边。');
    expect(root.textContent).toContain('还有一句正在说');
    expect(document.querySelector('[data-testid="voice-ring"]')).toBeNull();
  });

  it('整理纪要时禁止重复结束与切换静音', () => {
    const props = dialogProps({ phase: 'ending', liveText: '' });
    mount(themed(<VoiceDiscussionDialog {...props} />));
    const root = dialogRoot();
    expect(root.textContent).toContain('正在整理讨论纪要…');
    expect(root.textContent).toContain('整理中');
    expect((root.querySelector('button[aria-label="静音"]') as HTMLButtonElement).disabled).toBe(true);
    click(byAria('结束语音讨论', root));
    expect(props.onFinish).not.toHaveBeenCalled();
  });
});
