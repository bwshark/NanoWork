/**
 * 会话索引纯逻辑的**主进程入口**。
 *
 * 实现已下沉到 `src/events/indexFile.ts`——因为 Electron 落盘与 Web 分片降级
 * 共用同一套索引语义，放在 `src/` 才能被两侧同时 import 而不重复实现。
 * 本文件仅保留再导出，避免改动主进程侧既有调用点（含单测）。
 */
export * from '../src/events/indexFile';
