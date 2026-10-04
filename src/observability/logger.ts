/**
 * 渲染层的日志门面（FR-11.3）。
 *
 * ## 与主进程那份的分工
 *
 * ```
 * 渲染层   log.error('chat', '发送失败', { sessionId })   ← 本文件
 *            ↓ platform.appendLog（fire-and-forget，过 IPC）
 * 主进程   appendLogLine → <userData>/logs/<date>/<module>.log
 * ```
 *
 * 等级判定、模块白名单、行格式化三件事都在 `./logging`（纯模块），两侧共用。
 * 这里只负责「判定 → 格式化 → 送出去」，没有第二份格式。
 *
 * ## 为什么没有 index.ts 桶
 *
 * 本目录刻意**不做 barrel**：`electron/` 那边的模块（logStore / traceStore /
 * diagnostics）要以**值**的形式引 `logging` / `trace` / `retention`，而这三者不能
 * 反向牵进 `@/platform`（主进程产物是 esbuild cjs，`@` 别名只对 `import type` 有效）。
 * 一个桶会把 `logger.ts` 的 `platform` 依赖混进主进程的依赖图里——那种错误只在
 * 「重建 main.cjs」时才炸，且报错点离改动很远。直引文件，依赖边才是诚实的。
 *
 * ## 为什么 fire-and-forget
 *
 * 日志是旁路。给它造一个 await 点，等于让每个埋点都能拖慢对话；而写失败（磁盘满 /
 * 权限）更不该把用户的这一轮操作打挂。所以 `platform.appendLog` 返回 `void`，
 * 实现内部自行吞错。
 */

import { platform } from '@/platform';
import {
  DEFAULT_LOG_LEVEL,
  formatLogLine,
  normalizeLogLevel,
  shouldLog,
  type LogLevel,
  type LogModule,
} from './logging';

export type LogFn = (module: LogModule, message: string, detail?: unknown) => void;

/**
 * 当前最低等级。
 *
 * 开发态默认 `debug`（vite 的 `import.meta.env.DEV`）：本地排查时想直接看到细节，
 * 不值得为此加一个设置项。生产默认 `info` —— `debug` 落盘只会把有用信息淹掉。
 */
let minLevel: LogLevel = import.meta.env?.DEV ? 'debug' : DEFAULT_LOG_LEVEL;

/** 改最低等级（给「设置里能看到当前等级 / 排查时临时放开」留的口） */
export function setLogLevel(level: LogLevel): void {
  minLevel = normalizeLogLevel(level);
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

function emit(level: LogLevel, module: LogModule, message: string, detail?: unknown): void {
  // 先判等级再格式化：被挡掉的行不该付出 JSON 化的代价
  if (!shouldLog(level, minLevel)) return;
  try {
    platform.appendLog({
      module,
      level,
      line: formatLogLine({ at: Date.now(), level, module, message, detail }),
    });
  } catch {
    /* 日志写不出去不是业务错误 */
  }
}

export const log = {
  debug: (module: LogModule, message: string, detail?: unknown) => emit('debug', module, message, detail),
  info: (module: LogModule, message: string, detail?: unknown) => emit('info', module, message, detail),
  warn: (module: LogModule, message: string, detail?: unknown) => emit('warn', module, message, detail),
  error: (module: LogModule, message: string, detail?: unknown) => emit('error', module, message, detail),
} satisfies Record<LogLevel, LogFn>;
