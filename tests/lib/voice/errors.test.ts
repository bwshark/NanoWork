import { describe, expect, it } from 'vitest';
import { describeVoiceError, errorName } from '@/lib/voice/errors';

/**
 * 错误分类：**这里错了不会崩，只会给用户一句看不懂的话**。
 *
 * 变异清单：
 * - 漏掉 `NotReadableError` → 「设备被占用给出专用文案」变红
 *   （这是 Windows 上最常见的失败，文案若退回「无法开始录音」，
 *   用户只会反复重试而不会想到去关掉会议软件）
 * - 转写阶段也走 acquire 的分支 → 「转写失败透出原始信息」变红
 * - 用 `instanceof DOMException` 判类型 → 跨 realm 用例变红
 */

/** 造一个「看起来像 DOMException 但不同 realm」的对象（跨 realm instanceof 恒 false） */
function foreignError(name: string, message = ''): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('errorName：不依赖 instanceof', () => {
  it('从普通 Error 的 name 读取', () => {
    expect(errorName(foreignError('NotAllowedError'))).toBe('NotAllowedError');
  });

  it('**关键**：跨 realm 的类 DOMException 也能读到 name', () => {
    // 若实现用 `err instanceof DOMException`，这里会拿到 ''，进而落到 default 分支
    expect(errorName(foreignError('NotReadableError'))).toBe('NotReadableError');
  });

  it('非对象返回空串', () => {
    expect(errorName('boom')).toBe('');
    expect(errorName(null)).toBe('');
    expect(errorName(undefined)).toBe('');
  });

  it('对象没有 name 字段时返回空串', () => {
    expect(errorName({ message: 'x' })).toBe('');
  });
});

describe('describeVoiceError：采集阶段', () => {
  it('权限被拒 → 提示去设置里允许', () => {
    const out = describeVoiceError(foreignError('NotAllowedError'), 'acquire');
    expect(out.code).toBe('denied');
    expect(out.message).toContain('权限');
  });

  it('PermissionDeniedError（旧名）同样归类为 denied', () => {
    expect(describeVoiceError(foreignError('PermissionDeniedError'), 'acquire').code).toBe(
      'denied',
    );
  });

  it('没有设备 → 专用文案', () => {
    const out = describeVoiceError(foreignError('NotFoundError'), 'acquire');
    expect(out.code).toBe('no-device');
    expect(out.message).toContain('麦克风');
  });

  it('**关键**：设备被占用 → 提示关闭其他程序（而不是只说「无法开始录音」）', () => {
    const out = describeVoiceError(foreignError('NotReadableError'), 'acquire');
    expect(out.code).toBe('busy');
    expect(out.message).toContain('占用');
  });

  it('TrackStartError（旧名）同样归类为 busy', () => {
    expect(describeVoiceError(foreignError('TrackStartError'), 'acquire').code).toBe('busy');
  });

  it('非安全上下文 → 提示需要 HTTPS/localhost', () => {
    const out = describeVoiceError(foreignError('SecurityError'), 'acquire');
    expect(out.code).toBe('insecure');
    expect(out.message).toContain('HTTPS');
  });

  it('约束不支持 → 归类 unsupported', () => {
    expect(describeVoiceError(foreignError('OverconstrainedError'), 'acquire').code).toBe(
      'unsupported',
    );
  });

  it('未知错误透出原始 message（不吞成固定文案）', () => {
    const out = describeVoiceError(foreignError('WeirdError', '驱动崩了'), 'acquire');
    expect(out.code).toBe('unknown');
    expect(out.message).toContain('驱动崩了');
  });

  it('未知错误且无 message 时给出兜底文案（不返回空串）', () => {
    const out = describeVoiceError(foreignError('WeirdError'), 'acquire');
    expect(out.message).not.toBe('');
  });
});

describe('describeVoiceError：转写阶段', () => {
  it('**关键**：转写失败透出原始信息（HTTP 状态 / 服务商 message）', () => {
    const out = describeVoiceError(new Error('转录失败：HTTP 401 · Invalid API key'), 'transcribe');
    expect(out.code).toBe('transcribe');
    expect(out.message).toContain('401');
    expect(out.message).toContain('Invalid API key');
  });

  it('转写阶段不把 NotAllowedError 解释成「麦克风权限」', () => {
    // 同一个 Error 在两个阶段含义不同：转写时它多半是服务端 401/403
    const out = describeVoiceError(foreignError('NotAllowedError', '403'), 'transcribe');
    expect(out.code).toBe('transcribe');
    expect(out.message).toContain('403');
  });

  it('转写阶段空 message 也有兜底文案', () => {
    const out = describeVoiceError(new Error(''), 'transcribe');
    expect(out.message).toContain('语音');
  });
});
