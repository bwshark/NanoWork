import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Link, Box } from '@mui/material';

/**
 * 需要 `markdown` 分包（react-markdown + remark-gfm + react-syntax-highlighter，
 * 打包后约 772 KB）的渲染器**全部收在这个模块里**（FR-13.5）。
 *
 * ## 为什么合成一个模块
 *
 * 「谁在花掉这 772 KB」这件事必须在文件结构上**看得见**：本模块是**唯一**静态
 * import 那三个依赖的地方，于是「把 markdown 移出首屏」＝「让本模块只经 `import()`
 * 到达」，一眼可查、一处可改。两个渲染器分开成两个文件的话，将来很容易在某处又
 * 静态 import 一个，而那种回归**没有任何报错** —— 只是首屏悄悄多 772 KB。
 *
 * ## 为什么代码块也在这里
 *
 * `CodeBlock` 被产物面板的「源码视图」直接用（不走 markdown），但它和 markdown
 * 共用同一个 `react-syntax-highlighter`：拆成两个迟到模块只会让 rollup 把
 * 同一份依赖规划进两条懒加载路径，首次使用时**下载两次**的概率更高。
 *
 * ⚠️ 本模块**只能**被 `MarkdownView` / `CodeBlockView` 经 `import()` 到达。任何
 * 静态 import（包括 `export * from`）都会把它拽回入口的静态依赖图，Vite 便会在
 * `dist/index.html` 里为它打一条 `modulepreload` —— 首屏白付 772 KB。
 * 判据由 `tasks/verify-b5-first-paint.mjs` 量（见该脚本头注释）。
 */

/** 代码块统一外观：圆角 + 13px + 横向可滚。三处用法（markdown 围栏 / 产物源码）共用。 */
const CODE_STYLE = { borderRadius: 8, fontSize: 13, maxWidth: '100%', overflowX: 'auto' } as const;

export function CodeBlock({ language, source }: { language?: string; source: string }) {
  return (
    <SyntaxHighlighter
      style={oneDark}
      language={language || undefined}
      PreTag="div"
      customStyle={CODE_STYLE}
    >
      {source}
    </SyntaxHighlighter>
  );
}

interface MarkdownRendererProps {
  content: string;
  sx?: object;
  /**
   * 放行 `blob:` 图片地址。
   *
   * react-markdown 默认的 `urlTransform` 只放行已知协议，`blob:` 会被清空
   * （图片变成空 src，整个 src 是空的）。知识库的图片正是 `blob:` 地址 ——
   * `<img>` 不能带 Authorization 头，所以由 JS 取回字节后换成 blob 地址。
   *
   * 安全：只**额外**放行 `blob:`，其余仍走默认实现（`javascript:` 之类照样被拦）。
   * ⚠️ 这个判断必须留在本模块里 —— `react-markdown` 是 772KB 的懒加载边界，
   * 在别处 import 它（哪怕只是 import 一个函数）会把它拽回首屏静态图。
   */
  allowBlobUrls?: boolean;
}

/** 只额外放行 `blob:`，其余交给 react-markdown 的默认实现。 */
const allowBlobUrl = (url: string): string =>
  url.startsWith('blob:') ? url : defaultUrlTransform(url);

/**
 * Markdown 渲染封装：GFM 表格 + 代码高亮。
 * 链接强制新窗口打开；代码块使用 react-syntax-highlighter。
 */
export function MarkdownRenderer({ content, sx, allowBlobUrls }: MarkdownRendererProps) {
  return (
    <Box className="md-body" sx={sx}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={allowBlobUrls ? allowBlobUrl : undefined}
        components={{
          a: ({ node, ...props }: any) => (
            <Link href={props.href} target="_blank" rel="noopener noreferrer" {...props} />
          ),
          pre: ({ children }: any) => <>{children}</>,
          code: ({ node, className, children, ...rest }: any) => {
            const match = /language-(\w+)/.exec(className || '');
            if (match) {
              return <CodeBlock language={match[1]} source={String(children).replace(/\n$/, '')} />;
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </Box>
  );
}
