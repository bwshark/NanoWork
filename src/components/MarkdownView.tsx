import { Suspense, lazy } from 'react';
import { Box } from '@mui/material';

/**
 * Markdown 渲染的**懒加载边界**（FR-13.5）。对外 API 与原实现逐字相同，
 * 所以 7 个调用点一行都不用改。
 *
 * ## 为什么边界在这层
 *
 * `react-markdown` + `remark-gfm` + `react-syntax-highlighter` 打包后约 772 KB，
 * 而且是**首屏不需要**的：会话列表、侧栏、任何一页的骨架都不依赖它。但它的调用点
 * 分布很广（助手消息 / 推理块 / 进程视图 / 技能详情 / 任务 / 产物预览），还有一条
 * 藏在 `AppLayout → ArtifactPanel → ArtifactRenderer` 这条**静态**链上 —— 也就是说
 * 「只要打开应用就在静态图里」。在这层做一次边界，等于**一次**改动就把它从
 * 静态图里摘掉，而不是去改 7 个调用点（那才是迟早漏一个的写法）。
 *
 * ## fallback 用「纯文本原样」而不是转圈
 *
 * 这层的使用者绝大多数是**对话正文**。chunk 到达前给一个转圈，用户看到的是一句
 * 话说到一半突然被吃掉、再冒出来；而给纯文本（`pre-wrap`）时，内容**立刻可读**，
 * 只是暂时没有排版，chunk 一到就地升级。同理也保住了「不白屏」这条DoD。
 *
 * ⚠️ 不要在这里直接 import `./markdown/MarkdownRenderer`：那会把 772 KB 拽回
 * 静态图（见那个模块的 docstring）。判据是 `dist/index.html` 的 modulepreload 总量。
 */
const MarkdownRenderer = lazy(() =>
  import('./markdown/MarkdownRenderer').then((m) => ({ default: m.MarkdownRenderer })),
);

interface MarkdownViewProps {
  content: string;
  sx?: object;
  /**
   * 放行 `blob:` 图片地址（知识库的图片是 blob 地址）。
   *
   * 刻意只透传一个**布尔**而不是传函数：`react-markdown` 是 772KB 的懒加载边界，
   * 在这里 import 它的任何一个导出（哪怕只是 `defaultUrlTransform`）都会把整包
   * 拽回首屏静态图。真正的判断留在 `markdown/MarkdownRenderer` 内部。
   */
  allowBlobUrls?: boolean;
  /**
   * 在图片下方显示一行图注（取 `alt`）。知识库文档打开：图注是图片唯一的检索信号，
   * 不显示等于让阅读的人以为这张图没有说明。
   */
  showImageCaptions?: boolean;
}

export function MarkdownView({ content, sx, allowBlobUrls, showImageCaptions }: MarkdownViewProps) {
  return (
    <Suspense
      fallback={
        <Box className="md-body" sx={sx} style={{ whiteSpace: 'pre-wrap' }}>
          {content}
        </Box>
      }
    >
      <MarkdownRenderer
        content={content}
        sx={sx}
        allowBlobUrls={allowBlobUrls}
        showImageCaptions={showImageCaptions}
      />
    </Suspense>
  );
}
