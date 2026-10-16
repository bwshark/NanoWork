/**
 * 窗口安全档位表（FR-8.10）。
 *
 * ## 抄的是什么
 *
 * WorkBuddy 的 `main/secure-web-preferences.js` 把 `webPreferences` 做成**按窗口角色查表**：
 * 全表只有 `image-decoder` 与 `splash` 关 sandbox，`image-decoder` 是唯一的 `webSecurity:false`
 * **且缺 `partition` 直接 throw**。同样的危险开关，人家做成「默认拿不到」。
 *
 * 本项目的原状是一处写死：`main.ts` 里 `contextIsolation:true` / `nodeIntegration:false` 是对的，
 * 但 **`webSecurity:false` 全局生效且未设 `sandbox`**——也就是说主窗口（以及未来任何一个窗口）
 * 天生就没有同源策略，而没有任何地方记录「是谁需要它、为什么需要」。
 *
 * ## 本项目与 WorkBuddy 的差别（如实记录）
 *
 * 我们**做不到**「危险开关默认拿不到」：主窗口真的需要 `webSecurity:false`
 * （渲染层是 `file://` 页面，origin 为 `null`，直连本地引擎网关必然被 CORS 拦；
 * 而引擎侧 `/v1` 路由没有任何 CORS 中间件，`GatewayConfig` 也没有 cors 字段——
 * 见 B3-00 的 V-2 验证）。所以这里的做法是**按名字领取 + 显式认领 + 注释留痕**：
 * 只有 `main` 角色能拿到 `webSecurity:false`，且必须传 `allowInsecureWebSecurity: true`
 * （调用点旁写着理由），其它角色一律 `webSecurity: true`。
 *
 * ## 危险档位缺前置即 throw
 *
 * `image-decoder` 缺 `partition` 会 throw。理由：没有 partition 的 `webSecurity:false`
 * 窗口会与主窗口共享 cookie/storage 会话——「关掉同源策略」与「共享会话」叠在一起，
 * 一旦这个窗口加载了不可控内容，主窗口的凭据面就暴露了。这不是默认值问题，是**必须显式**。
 */

/** 窗口角色。新增角色时必须同时扩充 `WINDOW_KINDS` 与 `createWindowPreferences` */
export type WindowKind =
  | 'main'
  | 'first-party'
  | 'guest-popup'
  | 'image-decoder'
  | 'artifact-preview';

/** 全部角色（测试遍历用；漏一个就是漏一档） */
export const WINDOW_KINDS: readonly WindowKind[] = [
  'main',
  'first-party',
  'guest-popup',
  'image-decoder',
  'artifact-preview',
];

/** 默认就关掉 sandbox 的角色（需要直接碰本地文件/协议） */
export const UNSANDBOXED_KINDS: readonly WindowKind[] = ['image-decoder'];

/**
 * **角色固有**就关同源策略的角色——不需要认领，因为关它是功能必需，
 * 保护它的是另一道前置（`image-decoder` 必须显式给 `partition`，否则直接 throw）。
 */
export const INSECURE_BY_DESIGN_KINDS: readonly WindowKind[] = ['image-decoder'];

/** 可以**通过认领**关闭同源策略的角色（其余角色传了也拿不到） */
export const WEB_SECURITY_OPT_OUT_KINDS: readonly WindowKind[] = ['main'];

export interface WindowPreferencesRequest {
  kind: WindowKind;
  /** preload 脚本绝对路径；不传表示该窗口没有 preload */
  preload?: string;
  /** `image-decoder` 必需：独立的 session partition */
  partition?: string;
  /**
   * 显式认领 `webSecurity:false`。
   *
   * ⚠️ 只有 `WEB_SECURITY_OPT_OUT_KINDS` 里的角色认领有效；其它角色传了会被忽略
   * （并在 `notes` 里记一笔，避免「我以为关了其实没关」）。
   */
  allowInsecureWebSecurity?: boolean;
}

export interface WindowPreferencesResult {
  /** 直接铺进 `new BrowserWindow({ webPreferences })` */
  webPreferences: Record<string, unknown>;
  /** 认领未被采纳之类的事实，供调用方记日志（不静默） */
  notes: string[];
}

/** 基础档：除特别声明外，所有角色共用这一套 */
function base(): Record<string, unknown> {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    // 默认true：关同源策略必须显式认领（见 allowInsecureWebSecurity）
    webSecurity: true,
    // 渲染层不该被节流到看不见（长任务 / SSE 流式输出时尤其明显）
    backgroundThrottling: false,
  };
}

/**
 * 按角色取 webPreferences。
 *
 * 纯函数、不碰 Electron——所以能在 node 环境下完整单测（包括「缺 partition 必须抛」）。
 *
 * @throws 危险档位缺前置条件时抛错，且错误信息里带角色名与缺什么
 */
export function createWindowPreferences(
  req: WindowPreferencesRequest,
): WindowPreferencesResult {
  const notes: string[] = [];
  const prefs = base();

  switch (req.kind) {
    case 'main': {
      // 主窗口：本地渲染层 + 直连本地引擎网关。
      // webSecurity:false 的唯一合法理由见模块注释（file:// origin 为 null + 引擎无 CORS）。
      if (req.allowInsecureWebSecurity && WEB_SECURITY_OPT_OUT_KINDS.includes('main')) {
        prefs.webSecurity = false;
        notes.push('main 窗口已显式认领 webSecurity:false（理由：file:// 页面直连本地网关）');
      }
      prefs.sandbox = true;
      break;
    }
    case 'first-party': {
      // 一方内容窗口（设置弹窗 / 关于页等同源页面）：与 main 同档，仅不共享认领
      prefs.sandbox = true;
      break;
    }
    case 'guest-popup': {
      // 客人弹窗：可能承载第三方内容，一律最严
      prefs.sandbox = true;
      prefs.webSecurity = true;
      break;
    }
    case 'artifact-preview': {
      // 产物预览：HTML 产物是**不可控内容**（用户/Agent 生成），必须最严。
      // CSP 的收紧见 FR-8.12，此处负责进程级隔离。
      prefs.sandbox = true;
      prefs.webSecurity = true;
      break;
    }
    case 'image-decoder': {
      // 图片解码：要读本地文件 → 关 sandbox；关同源策略 → 必须独立 partition。
      if (!req.partition) {
        throw new Error(
          'image-decoder 窗口需要显式 partition：没有 partition 的 webSecurity:false 会与主窗口共享会话',
        );
      }
      prefs.sandbox = false;
      prefs.webSecurity = false;
      prefs.partition = req.partition;
      break;
    }
    default: {
      // 穷尽性检查：新增 WindowKind 而忘了加档位时，这里编译期就红
      const never: never = req.kind;
      throw new Error(`未知窗口角色：${String(never)}`);
    }
  }

  // 认领了但角色不允许 → 不静默接受，也不静默忽略
  if (req.allowInsecureWebSecurity && !WEB_SECURITY_OPT_OUT_KINDS.includes(req.kind)) {
    notes.push(`${req.kind} 角色不允许认领 webSecurity:false，已忽略（保持 true）`);
  }

  if (req.preload) prefs.preload = req.preload;
  // sandbox 关掉时 preload 仍可用（Electron 会以内联方式注入），但要显式告知
  if (prefs.sandbox === false && req.preload) {
    notes.push(`${req.kind} 未启用 sandbox：preload 拥有完整 Node 环境，风险自负`);
  }
  return { webPreferences: prefs, notes };
}
