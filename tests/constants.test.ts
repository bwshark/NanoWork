import { describe, it, expect } from 'vitest';
import { SENSITIVE_TOOLS, isSensitiveTool } from '@/lib/core/constants';

/**
 * 覆盖 PRD FR-009 权限门控的判定基础：
 * SENSITIVE_TOOLS 必须包含 files/shell/network，isSensitiveTool 据此判定。
 */
describe('constants: 敏感工具判定 (FR-009 基础)', () => {
  it('SENSITIVE_TOOLS 包含 files / shell / network', () => {
    expect(SENSITIVE_TOOLS).toContain('files');
    expect(SENSITIVE_TOOLS).toContain('shell');
    expect(SENSITIVE_TOOLS).toContain('network');
  });

  it('isSensitiveTool 对敏感类别返回 true', () => {
    expect(isSensitiveTool('files')).toBe(true);
    expect(isSensitiveTool('shell')).toBe(true);
    expect(isSensitiveTool('network')).toBe(true);
  });

  it('isSensitiveTool 对非敏感工具返回 false', () => {
    expect(isSensitiveTool('web_search')).toBe(false);
    expect(isSensitiveTool('web_fetch')).toBe(false);
    expect(isSensitiveTool('image_gen')).toBe(false);
    expect(isSensitiveTool('chat')).toBe(false);
  });
});
