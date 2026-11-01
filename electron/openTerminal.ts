/**
 * 在指定目录打开系统终端。
 *
 * ## 与面板内终端的关系（2026-11 之后两条路并存）
 *
 * 内置终端（PTY + xterm）已经补上，见 `ptyRoutes.ts`——右栏的「打开终端」现在默认
 * 走那条，因为它能不离开会话就敲命令。这里保留的是**另一条**路：把系统终端拉起来。
 *
 * 仍然保留的理由：面板内终端只有一屏宽（右栏最宽 1000px），跑 `vim`、看长日志、
 * 长时间盯着的构建输出，用户还是想把它甩到第二个显示器上。系统终端在这些场景里
 * 是真·更好的工具，而不是「降级方案」。
 *
 * ## 安全
 *
 * - 只接受**已存在的目录**（主进程校验，不信渲染层）；
 * - Windows 下 `cmd /k` 会把参数当命令解析，所以路径里的 `& | < > ^ %` 要转义，
 *   并用双引号包住（引号内 cmd 仍会展开 `%VAR%`，所以 `%` 转义成 `%%`）；
 * - macOS / Linux 不经过 shell，参数直接传给 `open` / 终端程序。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * cmd.exe 需要转义的元字符。
 *
 * 导出是为了单测能直接验它——这条错了的后果是「在某个路径下执行的命令被截断/拼接」，
 * 而那种问题只在特定路径下出现，现场根本看不出来。
 *
 * `%` 要写成 `%%`（cmd 的变量展开），`& | < >` 是命令分隔符，`^` 本身是转义符，
 * 所以要先转义 `^` 再转义其它（顺序反了会把刚插进去的 `^` 再转义一遍）。
 */
export function escapeForCmd(value: string): string {
  return value
    // `^` 必须**先**转义：它自己是转义符，不先处理的话，后面为 `& | < >`
    // 插入的 `^` 会被这一步再转义一遍（`^&` 变成 `^^&`，cmd 读到的就是字面 `^&`）
    .replace(/\^/g, '^^')
    .replace(/&/g, '^&')
    .replace(/\|/g, '^|')
    .replace(/</g, '^<')
    .replace(/>/g, '^>')
    .replace(/%/g, '%%');
}

/**
 * 在 `dir` 打开终端。
 *
 * @param dir 目标目录（必须是已存在的目录）
 */
export async function openTerminalAt(dir: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof dir !== 'string' || !dir.trim()) {
    return { ok: false, error: '未指定目录' };
  }
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return { ok: false, error: `不是目录：${dir}` };
  } catch {
    return { ok: false, error: `目录不存在：${dir}` };
  }

  try {
    if (process.platform === 'win32') {
      const child = spawn(
        'cmd.exe',
        ['/k', `cd /d "${escapeForCmd(dir)}"`],
        { detached: true, stdio: 'ignore', windowsHide: false },
      );
      child.unref();
      return { ok: true };
    }
    if (process.platform === 'darwin') {
      const child = spawn('open', ['-a', 'Terminal', dir], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { ok: true };
    }
    // Linux：发行版差异大，按常见程度依次尝试
    for (const [cmd, args] of [
      ['x-terminal-emulator', [dir]],
      ['gnome-terminal', ['--working-directory', dir]],
      ['konsole', ['--workdir', dir]],
      ['xfce4-terminal', ['--working-directory', dir]],
    ] as const) {
      const ok = await trySpawn(cmd, args);
      if (ok) return { ok: true };
    }
    return { ok: false, error: '没有找到可用的终端程序（尝试过 x-terminal-emulator / gnome-terminal / konsole / xfce4-terminal）' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 试着拉起一个程序；失败返回 false（不抛） */
async function trySpawn(command: string, args: readonly string[]): Promise<boolean> {
  try {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
    child.unref();
    // `error` 事件是异步的（ENOENT 在这里才触发），等一小会儿再判断
    const failed = await new Promise<boolean>((resolve) => {
      let settled = false;
      child.once('error', () => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, 150);
    });
    return !failed;
  } catch {
    return false;
  }
}

/** 默认工作空间路径（与客户端的默认工作区规则一致） */
export function defaultTerminalDir(homeDir: string): string {
  return join(homeDir, 'NanoWork');
}
