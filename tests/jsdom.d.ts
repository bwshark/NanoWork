/**
 * `jsdom` 的最小类型声明。
 *
 * jsdom **自带运行时但不带 `.d.ts`**（类型在 `@types/jsdom`，本项目没装）。
 * 这里只声明测试真的用到的那几个成员 —— 目的不是「补全 API」，而是让
 * `typecheck:tests` 能跑起来。
 *
 * **为什么不直接装 `@types/jsdom`**：那会为了一处测试辅助引入一个需要跟着
 * DOM 规范走的类型包（版本漂移、与 `lib.dom` 的重复声明都可能成为新的噪音源），
 * 而这里用到的面极小、且都是 `lib.dom` 已有类型的转发。同 `src/iframe-csp.d.ts`
 * 的做法（补一处缺口，而不是引一个包）。
 */
declare module 'jsdom' {
  export interface JSDOMOptions {
    /** `'dangerously'` 才会执行页面内联脚本（perf-report 的用例依赖它） */
    runScripts?: 'dangerously' | 'outside-only';
    pretendToBeVisual?: boolean;
    url?: string;
  }

  export interface JsdomWindow {
    document: Document;
    File: typeof File;
    Event: typeof Event;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: JsdomWindow;
  }
}
