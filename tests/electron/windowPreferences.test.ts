/**
 * 窗口安全档位表（FR-8.10）。
 *
 * 重点在**安全断言**而不是「返回值长什么样」：
 * ① 除认领者外一律 `webSecurity:true`（默认安全）；
 * ② 除 `image-decoder` 外一律 `sandbox:true`（默认沙箱）；
 * ③ 危险档位缺前置必须 throw——这一条是「默认拿不到」的机械保证。
 *
 * 变异验证目标：
 * - 把 `image-decoder` 的 `throw` 改成静默返回 → 「缺 partition 必须抛」用例变红；
 * - 把 `base()` 里的 `webSecurity` 默认值改成 false → 「默认不开同源策略」用例变红；
 * - 删掉 `default: never` 穷尽分支 → 新增角色的编译期保护失效（由 typecheck 兜住，此处不断言）。
 */

import { describe, expect, it } from 'vitest';
import {
  INSECURE_BY_DESIGN_KINDS,
  UNSANDBOXED_KINDS,
  WEB_SECURITY_OPT_OUT_KINDS,
  WINDOW_KINDS,
  createWindowPreferences,
  type WindowKind,
} from '../../electron/windowPreferences';

/**
 * 遍历用的取档位助手。
 *
 * ⚠️ `image-decoder` 必须带 partition，否则它**正确地**抛错——那不是缺陷，
 * 正是「危险档位缺前置即 throw」要的行为。遍历时统一补上。
 */
function prefsFor(kind: WindowKind, extra: Partial<Parameters<typeof createWindowPreferences>[0]> = {}) {
  return createWindowPreferences({ kind, partition: kind === 'image-decoder' ? 'persist:probe' : undefined, ...extra })
    .webPreferences;
}

describe('WINDOW_KINDS 常量与档位表不漂移', () => {
  it('六个角色都有档位（漏一个就是漏一档）', () => {
    expect([...WINDOW_KINDS].sort()).toEqual([
      'artifact-preview',
      'first-party',
      'guest-popup',
      'image-decoder',
      'main',
      'splash',
    ]);
    for (const kind of WINDOW_KINDS) {
      expect(() => prefsFor(kind)).not.toThrow();
    }
  });

  it('只有 main 能通过认领拿到 webSecurity:false', () => {
    for (const kind of WINDOW_KINDS) {
      // 关同源策略的两条来路：认领（main）与角色固有（image-decoder，由 partition 保护）
      const insecure =
        WEB_SECURITY_OPT_OUT_KINDS.includes(kind) || INSECURE_BY_DESIGN_KINDS.includes(kind);
      const got = prefsFor(kind, { allowInsecureWebSecurity: true }).webSecurity;
      expect(got).toBe(insecure ? false : true);
    }
    expect([...WEB_SECURITY_OPT_OUT_KINDS]).toEqual(['main']);
  });
});

describe('默认安全：不开认领就没有危险开关', () => {
  it('所有角色默认 contextIsolation + 无 nodeIntegration', () => {
    for (const kind of WINDOW_KINDS) {
      const p = prefsFor(kind);
      expect(p.contextIsolation).toBe(true);
      expect(p.nodeIntegration).toBe(false);
    }
  });

  it('除 image-decoder 外默认 sandbox:true', () => {
    for (const kind of WINDOW_KINDS) {
      const p = prefsFor(kind);
      if (kind === 'image-decoder') continue;
      expect(p.sandbox).toBe(true);
    }
    expect(UNSANDBOXED_KINDS).toEqual(['image-decoder']);
  });

  it('不开认领时，除角色固有者外都 webSecurity:true', () => {
    for (const kind of WINDOW_KINDS) {
      // image-decoder 是例外：它必须关同源策略才能读本地文件，
      // 保护它的是「必须显式给 partition」这道前置（见下一组用例）。
      const inherent = INSECURE_BY_DESIGN_KINDS.includes(kind);
      expect(prefsFor(kind).webSecurity).toBe(inherent ? false : true);
    }
    expect([...INSECURE_BY_DESIGN_KINDS]).toEqual(['image-decoder']);
  });
});

describe('main 角色：认领才拿得到 webSecurity:false', () => {
  it('显式认领后生效，并留下可追查的 note', () => {
    const r = createWindowPreferences({
      kind: 'main',
      preload: 'C:/app/preload.cjs',
      allowInsecureWebSecurity: true,
    });
    expect(r.webPreferences.webSecurity).toBe(false);
    expect(r.notes.join(' ')).toContain('已显式认领');
    expect(r.webPreferences.preload).toBe('C:/app/preload.cjs');
    expect(r.webPreferences.sandbox).toBe(true);
  });

  it('不认领就是 true（默认安全）', () => {
    expect(prefsFor('main').webSecurity).toBe(true);
  });
});

describe('image-decoder：危险档位缺前置即 throw', () => {
  it('缺 partition 必须抛，且错误信息说清缺什么', () => {
    expect(() => createWindowPreferences({ kind: 'image-decoder' })).toThrow(/partition/);
  });

  it('给了 partition 才放行，且 sandbox/webSecurity 都关', () => {
    const r = createWindowPreferences({
      kind: 'image-decoder',
      partition: 'persist:img',
      preload: 'C:/app/preload.cjs',
    });
    expect(r.webPreferences).toMatchObject({
      partition: 'persist:img',
      sandbox: false,
      webSecurity: false,
      contextIsolation: true,
      nodeIntegration: false,
    });
    // 未沙箱化还带 preload 时要明确告知（preload 有完整 Node 环境）
    expect(r.notes.join(' ')).toContain('未启用 sandbox');
  });
});

describe('客人与产物预览：不可控内容一律最严', () => {
  it('guest-popup / artifact-preview 既不沙箱豁免也不开同源策略', () => {
    for (const kind of ['guest-popup', 'artifact-preview'] as const) {
      const p = prefsFor(kind);
      expect(p.sandbox).toBe(true);
      expect(p.webSecurity).toBe(true);
    }
  });

  it('artifact-preview 即使认领也拿不到 webSecurity:false', () => {
    const r = createWindowPreferences({ kind: 'artifact-preview', allowInsecureWebSecurity: true });
    expect(r.webPreferences.webSecurity).toBe(true);
    expect(r.notes.join(' ')).toContain('不允许认领');
  });
});

describe('first-party', () => {
  it('与 main 同档但不继承认领', () => {
    const p = prefsFor('first-party');
    expect(p.sandbox).toBe(true);
    expect(p.webSecurity).toBe(true);
  });
});
