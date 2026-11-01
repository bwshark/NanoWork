import { useEffect, useRef, useState } from 'react';
import { Box, Typography, useTheme } from '@mui/material';
import TerminalIcon from '@mui/icons-material/Terminal';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { platform } from '@/platform';

/**
 * 面板内终端（xterm + 主进程 PTY）。
 *
 * ## 生命周期为什么由组件独占
 *
 * 一个标签 = 一个 shell 会话。PTY 在主进程里是真实进程，渲染层只是在旁边画它：
 * 组件卸载时**必须** kill 掉，否则关掉标签后 shell 还挂在后台（用户看不见，
 * 但它占着内存、还可能继续往磁盘写日志）。
 *
 * 反过来，切标签不该销毁它——所以面板层把这个组件保持挂载，只切 `display`；
 * 一旦卸载重挂，滚动历史和正在跑的命令就全没了。
 *
 * ## 为什么不用 `display: none` 之外的方式隐藏
 *
 * xterm 的 canvas 在 `visibility: hidden` 下仍会参与布局计算，`fit()` 会算出
 * 错的列数；`display: none` 时 `fit()` 直接跳过（宽度为 0），重新显示时再算一次
 * ——见下面 `active` 变化时的 refit。
 */
export function TerminalView({
  tabId,
  cwd,
  active,
}: {
  /** 标签 id：仅用于日志与 key，不参与 PTY 协议 */
  tabId: string;
  /** 起始目录（会话工作空间）；空串则由主进程退回用户主目录 */
  cwd: string;
  /** 当前是否可见（不可见时不做 fit，避免按 0 宽算列数） */
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();

  // 主题色在挂载时取一次即可：xterm 的 theme 改起来要重绘整个屏，而面板配色在
  // 一次会话里基本不变（真要切主题，切一次标签重挂就能拿到新值）
  const isDark = theme.palette.mode === 'dark';

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      // 与代码块同一套等宽栈：终端里的对齐（表格、diff）靠的就是字体一致
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: true,
      scrollback: 2000,
      convertEol: false,
      theme: {
        // 背景跟着面板走（xterm 需要不透明底色，写死深色会在浅色主题里留一块黑砖）
        background: theme.palette.background.paper,
        foreground: theme.palette.text.primary,
        cursor: theme.palette.text.primary,
        selectionBackground: isDark ? 'rgba(120,140,180,0.35)' : 'rgba(80,120,200,0.25)',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    termRef.current = terminal;
    fitRef.current = fit;

    // 先算一次尺寸再建 PTY：先建后算会让 shell 以 80x24 起步，随后 resize 触发
    // 一次 SIGWINCH，命令行工具（如 `less`、`vim`）开局就要重排一遍
    try {
      fit.fit();
    } catch {
      // 容器还没有尺寸（极窄 / 未布局完）→ 用默认值，下面 ResizeObserver 会补
    }

    let disposed = false;
    const unsubscribeData = platform.onPtyData((event) => {
      if (event.id === ptyIdRef.current) terminal.write(event.data);
    });
    const unsubscribeExit = platform.onPtyExit((event) => {
      if (event.id !== ptyIdRef.current) return;
      ptyIdRef.current = null;
      terminal.write('\r\n\x1b[2m[进程已退出]\x1b[0m\r\n');
    });

    void platform
      .ptyCreate({ cwd: cwd === '' ? undefined : cwd, cols: terminal.cols, rows: terminal.rows })
      .then((result) => {
        if (disposed) {
          // 组件已卸载但会话建起来了：立刻回收，别留孤儿进程
          if (result.ok && result.id) platform.ptyKill(result.id);
          return;
        }
        if (!result.ok || !result.id) {
          setError(result.error ?? '终端启动失败');
          return;
        }
        ptyIdRef.current = result.id;
        terminal.onData((data) => platform.ptyWrite(result.id as string, data));
      });

    // 拖宽抓手 / 全屏切换 / 窗口缩放都走这里
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!fitRef.current || !termRef.current) return;
        if (termRef.current.element?.clientWidth === 0) return;
        try {
          fitRef.current.fit();
          const id = ptyIdRef.current;
          if (id) platform.ptyResize(id, termRef.current.cols, termRef.current.rows);
        } catch {
          // 极端窄宽下的 fit 失败不值得报错，下一帧还会再试
        }
      });
    });
    observer.observe(host);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      unsubscribeData();
      unsubscribeExit();
      const id = ptyIdRef.current;
      if (id) platform.ptyKill(id);
      ptyIdRef.current = null;
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // cwd / isDark 在标签生命周期内是常量（换工作空间会重建标签），故不做依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // 从别的标签切回来：重新量一次尺寸（隐藏期间宽度是 0，fit 被跳过），并抢回焦点
  useEffect(() => {
    if (!active) return;
    const terminal = termRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit) return;
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
        const id = ptyIdRef.current;
        if (id) platform.ptyResize(id, terminal.cols, terminal.rows);
      } catch {
        // 同上
      }
      terminal.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <Box sx={{ flex: 1, minHeight: 0, position: 'relative', bgcolor: 'background.paper' }}>
      {error !== null && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            px: 3,
            textAlign: 'center',
            bgcolor: 'background.paper',
            zIndex: 1,
          }}
        >
          <TerminalIcon sx={{ fontSize: 30, color: 'text.disabled' }} />
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>{error}</Typography>
          <Typography sx={{ fontSize: 11.5, color: 'text.disabled', lineHeight: 1.7 }}>
            面板内终端需要桌面端（本地 shell）。Web 端可改用系统终端。
          </Typography>
        </Box>
      )}
      <Box ref={hostRef} sx={{ position: 'absolute', inset: 0, px: 0.75, py: 0.5 }} />
    </Box>
  );
}
