import { Suspense, lazy } from 'react';
import { Box } from '@mui/material';

/**
 * 代码高亮的懒加载边界（FR-13.5），给**不走 markdown** 的那条路径用：
 * 产物面板的「源码视图」（`ArtifactRenderer`）。
 *
 * `ArtifactRenderer` 此前直接 `import { Prism as SyntaxHighlighter } from
 * 'react-syntax-highlighter'`，而它是 `AppLayout → ArtifactPanel → ArtifactRenderer`
 * 这条**静态**链上的一环 —— 于是 772 KB 的 `markdown` 分包被写进了首屏
 * `modulepreload`，只为「用户万一打开产物面板的源码视图」。
 *
 * fallback 刻意用等宽纯文本：源码视图的价值就是「我能看到原文」，
 * 高亮晚一点到无所谓，字必须在。
 */
const CodeBlock = lazy(() =>
  import('./markdown/MarkdownRenderer').then((m) => ({ default: m.CodeBlock })),
);

export function CodeBlockView({
  language,
  source,
  sx,
}: {
  language?: string;
  source: string;
  sx?: object;
}) {
  return (
    <Suspense
      fallback={
        <Box
          component="pre"
          sx={{
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            fontSize: 13,
            m: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            ...sx,
          }}
        >
          {source}
        </Box>
      }
    >
      <CodeBlock language={language} source={source} />
    </Suspense>
  );
}
