/**
 * 产物预览 CSP（FR-8.12）不变量测试。
 *
 * 核心：CSP 必须含 `connect-src 'none'`——这是堵住产物 HTML 外传数据通道的
 * 不可妥协项。若有人把它去掉（或改成 `connect-src *`），下面用例会变红，
 * 等于在 CI 里守住「产物不能偷偷 fetch 外部地址」。
 */

import { describe, expect, it } from 'vitest';
import { ARTIFACT_PREVIEW_CSP } from '../src/components/artifacts/artifactCsp';

describe('ARTIFACT_PREVIEW_CSP', () => {
  it('必须掐断出网通道：connect-src 为 none', () => {
    expect(ARTIFACT_PREVIEW_CSP).toContain("connect-src 'none'");
  });

  it('默认档位是「全部禁止」再按需放行', () => {
    expect(ARTIFACT_PREVIEW_CSP).toContain("default-src 'none'");
  });

  it('内联脚本/样式可跑（产物多为单文件自包含 HTML），但外部脚本不在白名单', () => {
    expect(ARTIFACT_PREVIEW_CSP).toContain("script-src 'unsafe-inline'");
    expect(ARTIFACT_PREVIEW_CSP).not.toContain('script-src *');
  });

  it('嵌套 iframe 也走最严（frame-ancestors / child-src none）', () => {
    expect(ARTIFACT_PREVIEW_CSP).toContain("frame-ancestors 'none'");
    expect(ARTIFACT_PREVIEW_CSP).toContain("child-src 'none'");
  });
});
