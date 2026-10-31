/**
 * 语音输入的错误分类与中文文案。
 *
 * 为什么不能像以前那样只判 `NotAllowedError` / `NotFoundError`：
 * - `NotReadableError` 是 Windows 上**最常见**的失败——设备被别的程序独占
 *   （Teams / 会议软件 / 另一个浏览器标签），而它既不是「没授权」也不是「没设备」，
 *   文案必须让用户知道「去关掉那个程序」，否则只会反复重试。
 * - `OverconstrainedError` 是「约束太严」：我们请求 16kHz 单声道 + 回声消除，
 *   老声卡/虚拟声卡（VB-Cable 之类）可能直接拒绝。这种**不该报错给用户**，
 *   应该自动降级重试（见 `useVoiceInput` 的 `acquireStream`）。
 * - `SecurityError`：非 HTTPS / 非 localhost 环境下 `getUserMedia` 直接不可用，
 *   与「权限被拒」是两件事，提示也不同。
 */

/** 归类后的错误码，UI 可据此决定「重试 / 去设置 / 换设备」 */
export type VoiceErrorCode =
  | 'unsupported'
  | 'insecure'
  | 'denied'
  | 'no-device'
  | 'busy'
  | 'empty'
  | 'transcribe'
  | 'unknown';

export interface VoiceError {
  code: VoiceErrorCode;
  /** 面向用户的中文文案（可直接进 toast） */
  message: string;
}

/** 从任意抛出物里取 DOMException 的 name（跨 realm 时 instanceof 恒 false） */
export function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/**
 * 把 `getUserMedia` 的失败归类成可读文案。
 *
 * 传 `context='acquire'` 时按「拿麦克风失败」解释，`'transcribe'` 时按「转写失败」解释——
 * 同一个 `Error` 对象在两个阶段出现，含义完全不同。
 */
export function describeVoiceError(
  err: unknown,
  context: 'acquire' | 'transcribe' = 'acquire',
): VoiceError {
  const name = errorName(err);
  const raw = err instanceof Error ? err.message : String(err);

  if (context === 'transcribe') {
    // 转写阶段一律透出原始文案：多数是 HTTP 状态或服务商回的 error.message，
    // 那些信息比任何固定文案都更能定位问题（比如「model not found」）。
    return { code: 'transcribe', message: raw || '语音转写失败，请重试' };
  }

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        code: 'denied',
        message: '麦克风权限被拒绝，请在浏览器或系统设置中允许后重试',
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { code: 'no-device', message: '未检测到麦克风设备' };
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        code: 'busy',
        message: '麦克风被其他程序占用，请关闭会议/录音类应用后重试',
      };
    case 'SecurityError':
      return {
        code: 'insecure',
        message: '当前环境不允许使用麦克风（需要 HTTPS 或 localhost）',
      };
    case 'OverconstrainedError':
      return {
        code: 'unsupported',
        message: '当前麦克风不支持所需的音频参数',
      };
    case 'AbortError':
      return { code: 'unknown', message: '麦克风启动被中断，请重试' };
    default:
      return { code: 'unknown', message: raw || '无法开始录音' };
  }
}
