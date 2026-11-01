/**
 * 右侧边栏「面板内终端」的 PTY 会话管理（主进程）。
 *
 * ## 为什么现在有了内置终端
 *
 * `openTerminal.ts` 顶部那段注释说明过：早先刻意只调**系统终端**，用零依赖换
 * 「不做集成」。参考稿（WorkBuddy）把终端做成了右栏的一个标签页，用户在会话里
 * 看改动、看文件、顺手敲命令，全程不离开这个窗口——这时「弹出另一个窗口」的
 * 代价已经高过一份 PTY 依赖了。所以本文件补齐这一半，系统终端那条路保留
 * （`terminal:openAt`），两条路各有用途。
 *
 * ## 会话生命周期
 *
 * - 渲染层 `pty:create` → 主进程 spawn 一个 shell，返回会话 id；
 * - 输出经 `pty:data` 广播（带 id），渲染层按 id 筛；
 * - 渲染层页面刷新 / 崩溃时 shell 必须被回收，否则会在后台堆出一串孤儿进程；
 *   因此按 **webContents id** 记账，`destroyed` 时整批 kill。
 *
 * ## 为什么不在这里做鉴权/白名单
 *
 * 终端天生就是「执行任意命令」的能力，给用户自己开的终端加命令白名单只会
 * 变成一个谎言（`cmd` / `bash` 里一行 `start` 就绕过去了）。产品边界靠的是
 * **只在桌面端、只在用户自己点开时**提供它，而不是假装能限制内容。
 */
import { app, ipcMain, BrowserWindow, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { spawn as spawnPty, type IPty } from 'node-pty';

/** 一条 PTY 会话 */
interface PtySession {
  proc: IPty;
  /** 归属的渲染进程（页面刷新 / 关闭时按它整批回收） */
  ownerId: number;
}

const sessions = new Map<string, PtySession>();
/** 已挂过 `destroyed` 监听的 webContents（避免重复挂） */
const hookedOwners = new Set<number>();
let nextId = 1;

/** 一条输出（渲染层按 `id` 筛自己的那一条） */
interface PtyDataEvent {
  id: string;
  data: string;
}

/** 一条退出通知 */
interface PtyExitEvent {
  id: string;
  code: number;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/** 该 shell 的可执行文件与参数（与系统终端保持同一套偏好） */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // Git Bash 在 Windows 上是开发者事实标准（参考稿里也是 MINGW64 的提示符），
    // 有就用它；没有则退回 cmd。**不猜 powershell**：它的启动耗时与输出编码
    // （UTF-16 vs UTF-8）都会让 xterm 里出现满屏乱码。
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (existsSync(gitBash)) return { file: gitBash, args: ['-i'] };
    return { file: process.env.ComSpec ?? 'cmd.exe', args: [] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

/** 回收某个渲染进程名下的全部会话 */
function killOwnedBy(ownerId: number): void {
  for (const [id, session] of sessions) {
    if (session.ownerId !== ownerId) continue;
    try {
      session.proc.kill();
    } catch {
      // 已经退出的会话再 kill 会抛；这里没必要上抛
    }
    sessions.delete(id);
  }
  hookedOwners.delete(ownerId);
}

/** 回收全部会话（应用退出时） */
export function disposeAllPtys(): void {
  for (const [id, session] of sessions) {
    try {
      session.proc.kill();
    } catch {
      // 同上
    }
    sessions.delete(id);
  }
  hookedOwners.clear();
}

/** 目录必须真实存在，否则 shell 起在哪儿是随机的（用户会以为终端坏了） */
function normalizeCwd(raw: unknown): string {
  const cwd = typeof raw === 'string' ? raw.trim() : '';
  if (cwd !== '' && existsSync(cwd)) return cwd;
  return process.env.USERPROFILE || process.env.HOME || process.cwd();
}

/**
 * 注册 PTY 相关 IPC。
 *
 * 由 `main.ts` 调用一次；重复调用会抛（ipcMain.handle 同名冲突），这也是
 * 「只注册一处」的天然守卫。
 */
export function registerPtyRoutes(): void {
  ipcMain.handle('pty:create', (event, opts?: { cwd?: string; cols?: number; rows?: number }) => {
    const shell = defaultShell();
    try {
      const proc = spawnPty(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: Math.max(20, Math.floor(opts?.cols ?? 80)),
        rows: Math.max(5, Math.floor(opts?.rows ?? 24)),
        cwd: normalizeCwd(opts?.cwd),
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
        // ConPTY 是 Windows 上现代终端后端；winpty 已停止维护，且中文输入更差
        useConpty: true,
      });
      const id = `pty-${nextId++}`;
      sessions.set(id, { proc, ownerId: event.sender.id });

      proc.onData((data) => broadcast('pty:data', { id, data } satisfies PtyDataEvent));
      proc.onExit(({ exitCode }) => {
        sessions.delete(id);
        broadcast('pty:exit', { id, code: exitCode } satisfies PtyExitEvent);
      });

      // 页面级回收：只挂一次，多个标签共用同一个监听
      if (!hookedOwners.has(event.sender.id)) {
        hookedOwners.add(event.sender.id);
        const owner: WebContents = event.sender;
        owner.once('destroyed', () => killOwnedBy(owner.id));
      }
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.on('pty:write', (_e, id: unknown, data: unknown) => {
    if (typeof id !== 'string' || typeof data !== 'string') return;
    sessions.get(id)?.proc.write(data);
  });

  ipcMain.on('pty:resize', (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return;
    const session = sessions.get(id);
    if (!session) return;
    try {
      // 面板拖宽 / 全屏切换都会触发；0 列 0 行会让 ConPTY 直接崩
      session.proc.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
    } catch {
      // 会话刚退出时的竞态：忽略即可，下一帧就不会再调
    }
  });

  ipcMain.on('pty:kill', (_e, id: unknown) => {
    if (typeof id !== 'string') return;
    const session = sessions.get(id);
    if (!session) return;
    try {
      session.proc.kill();
    } catch {
      // 同上
    }
    sessions.delete(id);
  });

  app.on('will-quit', () => disposeAllPtys());
}
