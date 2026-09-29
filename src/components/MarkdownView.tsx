import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Link, Box } from '@mui/material';

interface MarkdownViewProps {
  content: string;
  sx?: object;
}

/**
 * Markdown 渲染封装：GFM 表格 + 代码高亮。
 * 链接强制新窗口打开；代码块使用 react-syntax-highlighter。
 */
export function MarkdownView({ content, sx }: MarkdownViewProps) {
  return (
    <Box className="md-body" sx={sx}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }: any) => (
            <Link href={props.href} target="_blank" rel="noopener noreferrer" {...props} />
          ),
          pre: ({ children }: any) => <>{children}</>,
          code: ({ node, className, children, ...rest }: any) => {
            const match = /language-(\w+)/.exec(className || '');
            if (match) {
              return (
                <SyntaxHighlighter
                  style={oneDark}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{ borderRadius: 8, fontSize: 13, maxWidth: '100%', overflowX: 'auto' }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              );
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
