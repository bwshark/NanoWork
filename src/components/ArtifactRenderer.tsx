import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Button, Paper, useTheme } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Artifact } from '@/types';
import { MarkdownView } from './MarkdownView';

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
  const [open, setOpen] = useState(false);

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
        <Box>
          <Box sx={{ mb: 1 }}>
            <Button size="small" onClick={() => setOpen((v) => !v)}>
              {open ? '收起预览' : '展开预览'}
            </Button>
          </Box>
          {open && (
            <iframe
              title={artifact.title}
              sandbox="allow-scripts"
              srcDoc={artifact.content}
              style={{
                width: '100%',
                height: 320,
                border: 'none',
                borderRadius: 8,
                background: '#fff',
              }}
            />
          )}
        </Box>
      );
      break;
    case 'mermaid':
      body = <Mermaid code={artifact.content} />;
      break;
    case 'file':
      body =
        artifact.language === 'markdown' ? (
          <MarkdownView content={artifact.content} />
        ) : (
          <SyntaxHighlighter
            style={oneDark}
            language={artifact.language ?? 'text'}
            PreTag="div"
            customStyle={{
              borderRadius: 8,
              fontSize: 13,
              maxWidth: '100%',
              overflowX: 'auto',
            }}
          >
            {artifact.content}
          </SyntaxHighlighter>
        );
      break;
    case 'code':
      body = (
        <SyntaxHighlighter
          style={oneDark}
          language={artifact.language ?? 'text'}
          PreTag="div"
          customStyle={{ borderRadius: 8, fontSize: 13, maxWidth: '100%', overflowX: 'auto' }}
        >
          {artifact.content}
        </SyntaxHighlighter>
      );
      break;
    case 'markdown':
    default:
      body = <MarkdownView content={artifact.content} />;
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

  // 自带头的关闭态：文件产物在面板里由外层提供标题与操作，这里直接给正文
  if (!header) return <Box>{body}</Box>;

  return (
    <Paper variant="outlined" sx={{ p: 1.5, my: 1, bgcolor: 'background.paper' }}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 1,
        }}
      >
        <Box sx={{ fontWeight: 600, fontSize: 13 }}>{artifact.title ?? artifact.type}</Box>
        <Button
          size="small"
          startIcon={<DownloadIcon />}
          onClick={handleDownload}
        >
          下载
        </Button>
      </Box>
      <Box>{body}</Box>
    </Paper>
  );
}
