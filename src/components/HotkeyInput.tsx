import { useRef, useState } from 'react';
import { IconButton, InputAdornment, TextField } from '@mui/material';
import { Backspace } from '@mui/icons-material';

/**
 * Electron accelerator 语法的快捷键录入框。
 *
 * 采用只读输入框 + keydown 捕获而非自由文本：
 * - 手输极易产生 Electron 无法解析的非法串（如 'ctrl alt s'），注册必然失败；
 * - 捕获模式下每个按键都能即时归一化成合法 accelerator，所见即所得。
 */

/** e.key → Electron accelerator 主键名（方向键等命名与 KeyboardEvent 不一致，需映射） */
const SPECIAL_KEYS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Escape: 'Esc',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/**
 * 提取主键名。
 * 优先用 e.code：Shift 组合下 e.key 会变成符号（Shift+1 → '!'），
 * e.code 仍是 'Digit1'，能稳定还原成 Electron 认识的 '1'。
 * @returns 主键名；识别不了（纯修饰键、IME 组合中等）返回 null
 */
function mainKeyOf(e: React.KeyboardEvent): string | null {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (SPECIAL_KEYS[e.key]) return SPECIAL_KEYS[e.key];
  // 兜底：单个可见字符（不含空格，空格已由 code === 'Space' 分支处理）
  if (e.key.length === 1 && e.key.trim() !== '') return e.key.toUpperCase();
  return null;
}

/**
 * 把一次按键事件归一化为 Electron accelerator（如 'Ctrl+Alt+S'）。
 * 无修饰键时返回 null：Electron 不允许把裸字母/数字注册为全局快捷键。
 */
function toAccelerator(e: React.KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // Electron 的 Super 在 macOS 映射到 Command、在 Win/Linux 映射到 Win 键，跨平台统一
  if (e.metaKey) parts.push('Super');

  const mainKey = mainKeyOf(e);
  if (!mainKey) return null;
  // 无修饰键的裸键（如单独的 'S'）无法注册为全局快捷键，直接视为无效输入
  if (parts.length === 0) return null;

  parts.push(mainKey);
  return parts.join('+');
}

export interface HotkeyInputProps {
  /** 当前快捷键；空串表示禁用 */
  value: string;
  /** 值变化回调（含清空为 ''） */
  onChange: (accelerator: string) => void;
  /** 禁用录入（如非 Electron 环境） */
  disabled?: boolean;
  /** 外部校验错误文案（如快捷键被系统占用） */
  error?: string;
}

export function HotkeyInput({ value, onChange, disabled, error }: HotkeyInputProps) {
  const [recording, setRecording] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const stopRecording = () => {
    setRecording(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Tab 保留给键盘无障碍导航，不吞掉
    if (e.key === 'Tab') return;
    e.preventDefault();

    // Esc：放弃本次录入，保持原值
    if (e.key === 'Escape') {
      stopRecording();
      return;
    }
    // Backspace / Delete：清空 = 禁用全局快捷键
    if (e.key === 'Backspace' || e.key === 'Delete') {
      onChange('');
      stopRecording();
      return;
    }

    const acc = toAccelerator(e);
    // 仅按下修饰键（如只按 Ctrl）时不更新，等用户按下主键
    if (!acc) return;
    onChange(acc);
    stopRecording();
  };

  const displayValue = recording ? '请按下组合键…' : value || '未设置（已禁用）';

  return (
    <TextField
      fullWidth
      inputRef={inputRef}
      label="全局唤起快捷键"
      value={displayValue}
      disabled={disabled}
      error={Boolean(error)}
      helperText={
        error ||
        '点击输入框后按下组合键（需含 Ctrl / Alt / Shift / Win 之一）。Backspace 清空即禁用，Esc 取消。'
      }
      onFocus={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={handleKeyDown}
      placeholder="点击后按下组合键"
      // MUI v5 使用 InputProps（v6+ 才统一为 slotProps.input）
      InputProps={{
        readOnly: true,
        sx: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
        endAdornment: value ? (
          <InputAdornment position="end">
            <IconButton
              size="small"
              edge="end"
              title="清空（禁用快捷键）"
              onClick={() => onChange('')}
              disabled={disabled}
            >
              <Backspace sx={{ fontSize: 16 }} />
            </IconButton>
          </InputAdornment>
        ) : null,
      }}
    />
  );
}
