import { describe, expect, it } from 'vitest';
import { formatDuration } from '@/hooks/useVoiceInput';

/**
 * 语音输入：仅对纯函数 formatDuration 做单测。
 *
 * 注意：useVoiceInput / isVoiceRecordingSupported 主体依赖 MediaRecorder、
 * navigator.mediaDevices.getUserMedia、AudioContext 等浏览器 API，
 * jsdom 环境不具备，无法在单测中真实驱动录音与转录，
 * 需在真实浏览器（Chrome / Electron 壳）中人工验证：
 *   1) 麦克风授权 → 录音计时与音量动效；
 *   2) 停止 → 调 /audio/transcriptions → 文本回填输入框；
 *   3) 拒绝授权 → 中文错误提示；
 *   4) 取消 → 丢弃音频，不发起转录；
 *   5) 卸载组件 → 麦克风与定时器释放。
 */

describe('useVoiceInput: formatDuration 计时展示', () => {
  it('0 秒 → 0:00', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('59 秒 → 0:59（不进位）', () => {
    expect(formatDuration(59)).toBe('0:59');
  });

  it('60 秒 → 1:00', () => {
    expect(formatDuration(60)).toBe('1:00');
  });

  it('3599 秒 → 59:59', () => {
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('3600 秒 → 60:00（mm:ss 格式，分钟不折叠为小时）', () => {
    expect(formatDuration(3600)).toBe('60:00');
  });

  it('秒数补零对齐两位', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(65)).toBe('1:05');
  });

  it('小数向下取整', () => {
    expect(formatDuration(59.9)).toBe('0:59');
    expect(formatDuration(60.5)).toBe('1:00');
  });

  it('负数兜底为 0:00，不出现 "-1:-1"', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('非有限值不抛错', () => {
    expect(() => formatDuration(Number.NaN)).not.toThrow();
    expect(() => formatDuration(Number.POSITIVE_INFINITY)).not.toThrow();
  });
});
