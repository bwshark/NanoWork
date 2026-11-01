import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Button, Paper, useTheme } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { CodeBlockView } from './CodeBlockView';
import type { Artifact } from '@/types';
import { isHtmlArtifact } from '@/lib/artifact/fileArtifact';
import { MarkdownView } from './MarkdownView';
import { ARTIFACT_PREVIEW_CSP } from './artifacts/artifactCsp';
import { ExtensionPreviewAction } from './extensions/ExtensionPreviewAction';

/** 胶囊式小按钮的两种选中态（与产物面板「全部 / 变更」同一套视觉语言） */
const chipSx = (active: boolean) => ({
  textTransform: 'none' as const,
  fontSize: 12,
  minWidth: 0,
  px: 1,
  py: 0.25,
  borderRadius: 999,
  color: active ? 'primary.contrastText' : 'text.secondary',
  bgcolor: active ? 'primary.main' : 'action.hover',
  '&:hover': { bgcolor: active ? 'primary.main' : 'action.selected' },
});

/**
 * 「预览 / 源码」双视图容器（html / markdown / mermaid 共用）。
 *
 * 这三类产物都有「渲染形态」与「原文」两种看法，且都常常要来回切：看效果 → 核对或复制
 * 原文 → 回去看效果。切换按钮因此**常驻**而不是折叠（旧实现是「展开预览 / 收起预览」，
 * 每看一次都要多点一次，且收起状态下完全看不出这是个页面型产物）。
 *
 * 源码视图统一走 Prism 高亮，`language` 决定高亮规则。
 */
function DualView({
  preview,
  source,
  language,
}: {
  preview: ReactNode;
  source: string;
  language: string;
}) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview');

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 0.5, mb: 1 }}>
        {(['preview', 'source'] as const).map((m) => (
          <Button
            key={m}
            size="small"
            disableRipple
            aria-label={m === 'preview' ? '预览' : '源码'}
            onClick={() => setMode(m)}
            sx={chipSx(mode === m)}
          >
            {m === 'preview' ? '预览' : '源码'}
          </Button>
        ))}
      </Box>
      {mode === 'preview' ? (
        preview
      ) : (
        // FR-13.5：改走懒加载的代码高亮。本组件在 AppLayout 的**静态**依赖链上，
        // 直接 import 高亮库会把 772 KB 的 markdown 分包写进首屏 modulepreload。
        <CodeBlockView language={language} source={source} />
      )}
    </Box>
  );
}

/**
 * html 的预览体：iframe 把页面跑起来。
 *
 * 正文来自模型或文件，所以只给 `allow-scripts`、**不给** `allow-same-origin`——
 * 它摸不到父页面的 DOM（我们只是要它把页面画出来）。
 * 叠加 `csp`（FR-8.12）：产物里的 `fetch` / WebSocket 等出网通道被 `connect-src 'none'`
 * 掐断，堵住把对话内容外传的口子。
 */
function HtmlPreview({ html, title }: { html: string; title?: string }) {
  return (
    <iframe
      title={title ?? 'html 预览'}
      sandbox="allow-scripts"
      csp={ARTIFACT_PREVIEW_CSP}
      srcDoc={html}
      style={{
        width: '100%',
        // 面板里要能真的用起来（小游戏这类），消息流内联时又不至于吃掉整屏
        height: 'clamp(320px, 60vh, 720px)',
        border: 'none',
        borderRadius: 8,
        background: '#fff',
      }}
    />
  );
}

/** markdown 的双视图（文档渲染 / 原文），围栏产物与 `.md` 文件产物共用 */
function markdownView(content: string): ReactNode {
  return (
    <DualView
      language="markdown"
      source={content}
      preview={<MarkdownView content={content} />}
    />
  );
}

/** Mermaid 图渲染（懒加载 mermaid，避免 600KB+ 依赖拖慢首屏） */
function Mermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 图表主题跟随当前 MUI 模式（浅色用 mermaid 默认主题，深色用 dark）
  const { palette } = useTheme();
  const mermaidTheme = palette.mode === 'dark' ? 'dark' : 'default';

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
    // 动态 import：mermaid 被 manualChunks 单独分包，仅在渲染 mermaid 时加载
    import('mermaid')
      .then(({ default: mermaid }) => {
        if (cancelled) return;
        mermaid.initialize({ startOnLoad: false, theme: mermaidTheme });
        return mermaid.render(id, code);
      })
      .then((result) => {
        if (!cancelled && result?.svg && ref.current) ref.current.innerHTML = result.svg;
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, mermaidTheme]);

  if (error) {
    return <Box sx={{ color: 'error.main', fontSize: 12 }}>Mermaid 渲染失败：{error}</Box>;
  }
  if (loading) {
    return <Box sx={{ color: 'text.secondary', fontSize: 12 }}>Mermaid 渲染中…</Box>;
  }
  return <Box ref={ref} sx={{ my: 1 }} />;
}

interface ArtifactRendererProps {
  artifact: Artifact;
  /**
   * 是否渲染自带的「标题 + 下载」头。
   *
   * 消息流里内联渲染用默认值 `true`；产物面板自带预览头（返回 / 打开位置 / 复制路径），
   * 传 `false` 避免出现两层标题。
   */
  header?: boolean;
}

/**
 * 富产物渲染分发（FR-007 + 文件产物）。
 * 支持：HTML(iframe) / SVG / 图像 / 视频(外链) / Mermaid / 代码高亮 / Markdown /
 * 文件（按扩展名推断语言；`markdown` 走文档渲染，其余走高亮）。
 *
 * 注意：`file` 类型的 `content` 是**写入时的正文快照**——改写类工具
 * （`edit` / `apply_patch`）拿不到全文，此时 `content` 为空串，调用方
 * （产物面板）应改走「按需回读磁盘」，不要把空正文渲染成「空文件」。
 */
export function ArtifactRenderer({ artifact, header = true }: ArtifactRendererProps) {
  let body: ReactNode;
  switch (artifact.type) {
    case 'image':
      body = (
        <Box>
          <img
            src={artifact.url ?? ''}
            alt={artifact.title ?? 'image'}
            style={{ maxWidth: '100%', borderRadius: 8 }}
          />
        </Box>
      );
      break;
    case 'video':
      body = artifact.url ? (
        <video src={artifact.url} controls style={{ maxWidth: '100%', borderRadius: 8 }} />
      ) : (
        <Box>无视频地址</Box>
      );
      break;
    case 'svg':
      body = (
        <Box
          sx={{ borderRadius: 1, overflow: 'hidden', bgcolor: '#fff' }}
          dangerouslySetInnerHTML={{ __html: artifact.content }}
        />
      );
      break;
    case 'html':
      body = (
        <DualView
          language="html"
          source={artifact.content}
          preview={<HtmlPreview html={artifact.content} title={artifact.title} />}
        />
      );
      break;
    case 'mermaid':
      // 渲染失败时错误提示在预览里，用户可切「源码」自己看语法 —— 这正是双视图的意义
      body = (
        <DualView
          language="mermaid"
          source={artifact.content}
          preview={<Mermaid code={artifact.content} />}
        />
      );
      break;
    case 'file':
      body = isHtmlArtifact(artifact) ? (
        // .html / .htm 文件同样给「页面 / 源码」两视图：它和围栏 html 只差正文来源
        <DualView
          language="html"
          source={artifact.content}
          preview={<HtmlPreview html={artifact.content} title={artifact.title} />}
        />
      ) : artifact.language === 'markdown' ? (
          markdownView(artifact.content)
        ) : (
          <CodeBlockView language={artifact.language ?? 'text'} source={artifact.content} />
        );
      break;
    case 'code':
      body = <CodeBlockView language={artifact.language ?? 'text'} source={artifact.content} />;
      break;
    case 'markdown':
    default:
      body = markdownView(artifact.content);
      break;
  }

  const handleDownload = () => {
    const blob = new Blob([artifact.url ?? artifact.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = artifact.title ?? artifact.id;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** 扩展预览入口（未命中任何扩展时不渲染任何东西） */
  const extensionAction = <ExtensionPreviewAction artifact={artifact} />;

  // 自带头的关闭态：文件产物在面板里由外层提供标题与操作，这里直接给正文
  if (!header)
    return (
      <Box sx={{ width: '100%', minWidth: 0 }}>
        {extensionAction}
        {body}
      </Box>
    );

  return (
    <Paper
      variant="outlined"
      /**
       * ⚠️ `width: '100%'` 与 `minWidth: 0` 都不能省。
       *
       * 消息流里的本卡片是「列向 flex + `alignItems: 'flex-start'`」的子项，交叉轴
       * 不给宽度时尺寸退化为 fit-content；而卡片内部的代码块只有 `maxWidth: '100%'`
       * ——百分比在父宽**不定**时按 auto 处理，于是一行长代码（实测 `systemPrompt`
       * 那条）的 max-content 宽度一路顶上来，整张卡片被撑到 1000px 开外，右边界
       * 越过对话列、盖住窗口右侧（截图中被圈出的那个框）。
       *
       * 给成定宽后，内部 `maxWidth: 100% + overflowX: auto` 才真正生效：卡片右边界
       * 与正文 Paper / 用户气泡齐平，超长代码改为在卡片内横向滚动。
       */
      sx={{ width: '100%', minWidth: 0, p: 1.5, my: 1, bgcolor: 'background.paper' }}
      // 列宽对齐的回归钩子（tasks/verify-chat-column-align.mjs 直接量这一层）
      data-artifact-card=""
    >
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 1,
          gap: 1,
        }}
      >
        <Box
          sx={{
            fontWeight: 600,
            fontSize: 13,
            // 长标题（文件绝对路径）单行省略，不许把「下载」挤出卡片
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {artifact.title ?? artifact.type}
        </Box>
        <Button
          size="small"
          startIcon={<DownloadIcon />}
          onClick={handleDownload}
          sx={{ flexShrink: 0 }}
        >
          下载
        </Button>
      </Box>
      <Box sx={{ minWidth: 0 }}>{extensionAction}</Box>
      <Box sx={{ minWidth: 0 }}>{body}</Box>
    </Paper>
  );
}
