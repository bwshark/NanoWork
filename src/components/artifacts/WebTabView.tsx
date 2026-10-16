import { useEffect, useState } from 'react';
import { Box, IconButton, InputBase, Tooltip, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import RefreshIcon from '@mui/icons-material/Refresh';
import LaunchIcon from '@mui/icons-material/Launch';
import LanguageIcon from '@mui/icons-material/Language';
import { toast } from '@/components/Toast';
import { platform } from '@/platform';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import type { ArtifactPanelTab } from '@/stores/sessionUiStore';
import { ARTIFACT_PREVIEW_CSP } from './artifactCsp';

/** 网页标签（`kind: 'web'`）的完整形态 */
export type WebTab = Extract<ArtifactPanelTab, { kind: 'web' }>;

/** 只放行这几种协议：`javascript:` / `data:` 之类不给进 iframe（等于让面板执行任意代码） */
const ALLOWED_PROTOCOL = /^(https?|file):\/\//i;

/**
 * 地址栏输入 → 可加载的 URL。
 *
 * 用户不会老老实实敲 `https://`：
 * - `localhost:5176`、`127.0.0.1:8080` → 本地服务，补 `http://`（补 https 必然连不上）；
 * - `D:\aa\snake.html`、`D:/aa/snake.html` → Windows 绝对路径，转 `file:///`；
 * - 其余（`example.com`）→ 补 `https://`。
 *
 * 返回空串表示「不是个能加载的地址」，由调用方决定怎么提示。
 */
export function normalizeUrlInput(raw: string): string {
  const value = raw.trim();
  if (value === '') return '';
  // 1) Windows 盘符路径（`D:\x` / `D:/x`）**必须最先判**：`D:` 也长得像协议
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return `file:///${value.replace(/\\/g, '/')}`;
  }
  // 2) 带 `//` 的显式协议：白名单外一律拒（`javascript:` / `data:` 不进 iframe）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return ALLOWED_PROTOCOL.test(value) ? value : '';
  }
  // 3) 形如 `xxx:yyy` 但没有 `//`：可能是 host:port（`localhost:5176`），
  //    也可能是伪协议（`javascript:alert(1)`）。只有前者才是地址。
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (!/^[a-z0-9.-]+:\d+([/?#]|$)/i.test(value)) return '';
    return isLocalHost(value) ? `http://${value}` : `https://${value}`;
  }
  // 4) 无协议：本地地址走 http（补 https 必然连不上），其余走 https
  return isLocalHost(value) ? `http://${value}` : `https://${value}`;
}

/** 本机地址（含 `[::1]` 这种带方括号的写法）：它们只可能跑 http */
function isLocalHost(value: string): boolean {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i.test(value);
}

/** 取地址里可读的一段（主机名）当标签文字；取不到就退回原串 */
export function urlHostLabel(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1] : url;
}

/**
 * 本地绝对路径 → `file:///` URL。
 *
 * 只认**绝对路径**（Windows 盘符 / 已是 `file:` 协议 / Unix 的 `/x`）：相对路径在
 * 渲染进程里没有「相对于谁」的答案，硬转会得到一个指向不明目录的地址 —— 那比报错更难查。
 */
export function toFileUrl(path: string): string {
  const value = path.trim();
  if (value === '') return '';
  if (/^file:\/\//i.test(value)) return value;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return `file:///${value.replace(/\\/g, '/')}`;
  if (value.startsWith('/')) return `file://${value}`;
  return '';
}

/**
 * 网页标签的**地址栏**（挂在面板第二行的位置）。
 *
 * 与页面本体拆成两个组件，因为它们在面板里占的是**两行**：地址栏在第二行（与产物名
 * 同一条水平线），iframe 在内容区。合成一个组件就得把「第二行」整块让出去，
 * 标签栏与内容区之间会多出一层没有意义的包裹。
 *
 * 输入中的地址是**组件本地 state**（`draft`）：直接绑 `tab.url` 的话，用户每敲一个字
 * 都会触发一次 store 写入 → iframe 立刻导航到半截地址。
 */
export function WebUrlBar({ tab, onReload }: { tab: WebTab; onReload: () => void }) {
  const navigate = useSessionUiStore((s) => s.navigateWebTab);
  const step = useSessionUiStore((s) => s.stepWebTabHistory);
  const [draft, setDraft] = useState(tab.url);

  // 后退 / 前进 / 换标签回来都会改当前地址，地址栏要跟上
  useEffect(() => {
    setDraft(tab.url);
  }, [tab.url]);

  const submit = () => {
    const url = normalizeUrlInput(draft);
    if (url === '') {
      toast.warning('地址无效（只支持 http / https / file）');
      return;
    }
    navigate(tab.id, url);
  };

  const openExternal = () => {
    if (tab.url === '') {
      // 「产物预览」模式的正文只活在面板里（没有磁盘文件 / 地址），系统浏览器打不开
      toast.warning(tab.doc ? '这是产物预览，没有可交给系统浏览器的地址' : '地址栏还是空的');
      return;
    }
    void platform.openUrl(tab.url).then((result) => {
      if (!result.ok) toast.error(result.error ?? '无法用系统浏览器打开');
    });
  };

  /** 「产物预览」模式下地址栏是空的，用占位文案说明当前看的是什么 */
  const placeholder = tab.doc ? `产物预览：${tab.label ?? '未命名'}` : '输入网址';

  const btnSx = { p: 0.4 } as const;
  const iconSx = { fontSize: 16 } as const;

  return (
    // 外边距交给面板的第二行容器（那一行的 px / pb 与产物态、列表态共用一套节奏），
    // 这里只负责自己内部的排列并把这行撑满
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flex: 1, minWidth: 0 }}>
      <IconButton
        size="small"
        aria-label="后退"
        disabled={tab.cursor <= 0}
        sx={btnSx}
        onClick={() => step(tab.id, -1)}
      >
        <ArrowBackIcon sx={iconSx} />
      </IconButton>
      <IconButton
        size="small"
        aria-label="前进"
        disabled={tab.cursor >= tab.history.length - 1}
        sx={btnSx}
        onClick={() => step(tab.id, 1)}
      >
        <ArrowForwardIcon sx={iconSx} />
      </IconButton>

      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1,
          height: 30,
          borderRadius: 999,
          bgcolor: 'action.hover',
        }}
      >
        <LanguageIcon sx={{ fontSize: 15, color: 'text.secondary', flexShrink: 0 }} />
        <InputBase
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          sx={{ flex: 1, minWidth: 0, fontSize: 12.5 }}
          inputProps={{ 'aria-label': '地址栏', spellCheck: false }}
        />
      </Box>

      <Tooltip title="刷新" placement="bottom">
        <IconButton
          size="small"
          aria-label="刷新"
          sx={btnSx}
          // 产物预览模式没有地址，但有正文快照 —— 刷新（重挂 iframe）同样有意义
          disabled={tab.url === '' && !tab.doc}
          onClick={onReload}
        >
          <RefreshIcon sx={iconSx} />
        </IconButton>
      </Tooltip>
      <Tooltip title="用系统浏览器打开" placement="bottom">
        <IconButton size="small" aria-label="用系统浏览器打开" sx={btnSx} onClick={openExternal}>
          <LaunchIcon sx={iconSx} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

/**
 * 网页标签的**页面本体**（面板内容区）。
 *
 * ## 为什么用 iframe 而不是 `<webview>`
 *
 * `<webview>` 要在主进程开 `webviewTag`——等于把「渲染层能起独立浏览器进程」这个能力
 * 交出去。而这里的用途是**预览本地页面 / 内网服务**（本地 html 产物、dev server），
 * iframe 够用且不开新面。代价是外站可能用 `X-Frame-Options` 拒绝被嵌入，
 * 此时表现是一片空白 —— 空态文案要把这层原因说出来，免得用户以为面板坏了。
 *
 * ## 历史栈为什么自己维护
 *
 * iframe 的内容窗口跨域，`contentWindow.history` 碰不得；后退 / 前进只能由 store 记
 * （见 `sessionUiStore.navigateWebTab` / `stepWebTabHistory`）。
 */
export function WebFrame({ tab, reloadKey }: { tab: WebTab; reloadKey: number }) {
  if (tab.doc === undefined && tab.url === '') {
    return (
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          px: 3,
          textAlign: 'center',
        }}
      >
        <LanguageIcon sx={{ fontSize: 34, color: 'text.disabled' }} />
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
          在上方输入网址开始浏览
        </Typography>
        <Typography sx={{ fontSize: 11.5, color: 'text.disabled', lineHeight: 1.7 }}>
          支持 http / https，以及本地文件路径（如 D:/aa/snake.html）
          <br />
          本地服务可写 localhost:5176
        </Typography>
      </Box>
    );
  }

  // 产物预览模式：正文来自快照（围栏 html 没有磁盘文件），用 srcDoc 渲染。
  // srcDoc 里没有 base，相对路径资源加载不到 —— 单文件 html 产物不受影响。
  const docMode = tab.doc !== undefined;
  const title = tab.label ?? (docMode ? '产物预览' : tab.url);

  return (
    <Box sx={{ flex: 1, minHeight: 0, bgcolor: '#fff' }}>
      <iframe
        key={`${tab.doc ?? tab.url}#${reloadKey}`}
        title={title}
        {...(docMode ? { srcDoc: tab.doc } : { src: tab.url })}
        // 文档预览模式（docMode）是模型/Agent 生成的不可控 HTML → 套严格 CSP（FR-8.12），
        // 把 fetch/WebSocket 等出网通道用 connect-src 'none' 掐断，防对话内容外传。
        // 真机浏览标签页（url 模式）不套 CSP，否则普通网页打不开。
        {...(docMode ? { csp: ARTIFACT_PREVIEW_CSP } : {})}
        // 不给 `allow-top-navigation`：页面不能把顶层窗口导走
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
      />
    </Box>
  );
}
