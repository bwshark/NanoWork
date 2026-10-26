import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Box,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import FormatBoldIcon from "@mui/icons-material/FormatBold";
import FormatItalicIcon from "@mui/icons-material/FormatItalic";
import FormatUnderlinedIcon from "@mui/icons-material/FormatUnderlined";
import FormatStrikethroughIcon from "@mui/icons-material/FormatStrikethrough";
import CodeIcon from "@mui/icons-material/Code";
import LinkIcon from "@mui/icons-material/Link";
import FormatListBulletedIcon from "@mui/icons-material/FormatListBulleted";
import FormatListNumberedIcon from "@mui/icons-material/FormatListNumbered";
import FormatQuoteIcon from "@mui/icons-material/FormatQuote";
import DataObjectIcon from "@mui/icons-material/DataObject";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import { htmlToMarkdown, markdownToHtml } from "@/lib/kb/richText";
import { docTableSx } from "@/components/knowledge/docTableSx";
import { docFigureSx } from "@/components/knowledge/docFigureSx";

/**
 * 文档正文编辑器（contentEditable + 选区浮动工具条 + 块把手）。
 *
 * ## 三条硬约定
 *
 * 1. **DOM 不是真相**：编辑器只在重开文档时把 Markdown 写进 DOM，之后每次输入都
 *    立刻序列化回 Markdown 交给上层。任何"把 DOM 存起来"的做法会在浏览器升级后
 *    悄悄变形（`<b>` 变 `<strong>`、换行从 `<div>` 变 `<br>`）。
 * 2. **`execCommand` 是刻意的选择**：它被标记为废弃，但在 Chromium（桌面端就是
 *    Chromium）里是唯一零依赖、且能正确处理"选区跨多个文本节点"的行内格式化实现。
 *    自己操作 Range 做加粗，处理 `**` 的嵌套与撤销栈要几百行，收益是零。
 * 3. **粘贴只取纯文本**：从网页/Word 粘进来的 `text/html` 带满 `<span style>` 与
 *    `<table>`，而知识库的正文是要被切块检索的纯文本 —— 让这些壳子进来只会污染
 *    检索。要保留格式请用「上传文件」（服务端解析 `.docx`）。
 *
 * ## 工具条为什么用 fixed 定位
 *
 * 抽屉内部是可滚动容器，用 absolute 就要做「选区相对容器」的坐标换算（滚动、缩放、
 * 边界各一次），而 `getBoundingClientRect` 给的是视口坐标 —— 用 fixed 直接对齐，
 * 滚动时隐藏即可。
 */
export interface DocEditorProps {
  /** 换文档时的重置依据（不能用 markdown 当 key：那会每敲一个字就重建 DOM） */
  docKey: string;
  markdown: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  /**
   * 上传一张图片（粘贴 / 选文件）。
   *
   * 上层负责调云端；编辑器只管把结果插进光标处。返回 `null` = 失败
   * （提示由上层给，编辑器不重复报错）。
   */
  onUploadImage?: (file: File) => Promise<UploadedImage | null>;
}

/** 一张刚上传好的图片：资产 id（存库用）+ 可加载地址（显示用）+ 图注。 */
export interface UploadedImage {
  assetId: string;
  blobUrl: string;
  alt: string;
}

/** 父组件能调用的编辑器能力。 */
export interface DocEditorHandle {
  /** 在光标处插一张图（地址与图注都已就绪）。 */
  insertImage: (blobUrl: string, alt: string) => void;
  /**
   * 记下当前选区（打开文件对话框**之前**调用）。
   *
   * 为什么需要：文件对话框会让编辑器失焦，而失焦后 `window.getSelection()` 未必
   * 还指在这儿 —— 插图就会落到别处（甚至文档开头）。
   */
  captureSelection: () => void;
}

/** HTML 属性值转义（文件名里可能有引号，不转义就会破掉整个标签）。 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 块类型菜单里的一项（`formatBlock` 的参数）。 */
const BLOCK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'div', label: '正文' },
  { value: 'h1', label: '标题 1' },
  { value: 'h2', label: '标题 2' },
  { value: 'h3', label: '标题 3' },
  { value: 'blockquote', label: '引用' },
  { value: 'pre', label: '代码块' },
];

export const DocEditor = forwardRef<DocEditorHandle, DocEditorProps>(function DocEditor(
  { docKey, markdown, onChange, readOnly = false, onUploadImage },
  ref,
) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [toolbar, setToolbar] = useState<{ top: number; left: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  /**
   * 块菜单的位置用**视口坐标**而不是 anchorEl。
   *
   * 把手是随 hover 出现/消失的，点开菜单时它可能已经被重新渲染掉；一旦 anchorEl
   * 指向脱离文档的节点，MUI 量出来的矩形全是 0，菜单就跑到屏幕左上角去了。
   */
  const [blockMenu, setBlockMenu] = useState<{
    position: { top: number; left: number };
    target: HTMLElement;
  } | null>(null);
  const [handle, setHandle] = useState<{ top: number; target: HTMLElement } | null>(null);
  /**
   * 打开链接输入框时先存下选区。
   *
   * 点输入框会让编辑器失焦、选区塌陷，等用户敲完回车再 `createLink` 时已经没有
   * 可作用的目标了 —— 表现是「填了链接但什么都没发生」。
   */
  const savedRange = useRef<Range | null>(null);

  /** DOM → Markdown。所有改动（输入 / execCommand / 块操作）最后都走这里。 */
  const sync = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    onChange(htmlToMarkdown(editor.innerHTML));
  }, [onChange]);

  /** 记下当前选区（供稍后插入用）。 */
  const captureSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      savedRange.current = selection.getRangeAt(0).cloneRange();
    }
  }, []);

  /**
   * 在光标处插一张图。
   *
   * 选区的取用顺序是「**当前选区 → 上次记下的**」：
   * - 当前选区：用户刚点完「插入图片」或刚粘贴完，光标就在那儿；
   * - 上次记下的：上传是异步的（几百毫秒），这期间用户可能点了别的地方。
   *
   * 只用「上次记下的」会插错位置 —— 上一轮记的是**更早**的选区，
   * 于是「先粘贴的图」会跑到「后选的文件」后面，顺序反了。
   *
   * 插进去的是 `<figure><img><figcaption>` 而不是裸 `<img>`：图注是图片**唯一的
   * 检索信号**，藏在 `alt` 里等于让用户看不见自己「已经写过图注」。默认用文件名
   * （服务端给的 alt）当图注，用户想改就直接点那行字改。
   */
  const insertImage = useCallback(
    (blobUrl: string, alt: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      const selection = window.getSelection();
      const live =
        selection && selection.rangeCount > 0 && editor.contains(selection.anchorNode)
          ? selection.getRangeAt(0)
          : null;
      const range = live ?? savedRange.current;
      if (range) {
        editor.focus();
        selection?.removeAllRanges();
        selection?.addRange(range);
      } else {
        editor.focus();
      }
      const caption = escapeAttr(alt);
      // eslint-disable-next-line deprecation/deprecation
      document.execCommand(
        'insertHTML',
        false,
        `<figure><img src="${escapeAttr(blobUrl)}" alt="${caption}">` +
          `<figcaption>${caption}</figcaption></figure>`,
      );
      sync();
    },
    [sync],
  );

  useImperativeHandle(ref, () => ({ insertImage, captureSelection }), [insertImage, captureSelection]);

  // 换文档才把 Markdown 写进 DOM（之后再写会把光标顶到开头）
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.innerHTML = markdownToHtml(markdown);
    // markdown 刻意不进依赖：它是"外部换了一篇"的信号，不是"每次输入都要重刷"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // 选区浮动工具条
  useEffect(() => {
    if (readOnly) return;
    const onSelectionChange = () => {
      const selection = window.getSelection();
      const editor = editorRef.current;
      if (!editor || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setToolbar(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) {
        setToolbar(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setToolbar(null);
        return;
      }
      setToolbar({ top: Math.max(8, rect.top - 48), left: rect.left + rect.width / 2 });
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [readOnly]);

  /**
   * 执行一条行内 / 列表命令。
   *
   * `execCommand` 在 Chromium 里会自己触发 `input`，但 React 的合成事件不一定接得住
   * （它依赖 DOM 事件冒泡到根节点；某些输入法/程序化调用不会冒泡）→ 显式再同步一次。
   */
  const run = useCallback(
    (command: string, value?: string) => {
      editorRef.current?.focus();
      // eslint-disable-next-line deprecation/deprecation —— 见文件头第 2 条
      document.execCommand(command, false, value);
      sync();
    },
    [sync],
  );

  /** 给已选中的文字加链接：先把打开输入框前存下的选区还回去。 */
  const applyLink = useCallback(() => {
    const range = savedRange.current;
    if (range) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    run('createLink', linkValue);
    setLinkOpen(false);
  }, [linkValue, run]);

  /** 把某个块元素整体选中（块菜单的「转换为」需要先有选区）。 */
  const selectBlock = useCallback((element: HTMLElement) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

  /** 鼠标在正文里移动时，给当前块左侧挂一个把手（参考界面里的 ⋮⋮）。 */
  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const editor = editorRef.current;
    if (!editor) return;
    let target = event.target as HTMLElement | null;
    while (target && target.parentElement !== editor) {
      target = target.parentElement;
    }
    if (!target) {
      setHandle(null);
      return;
    }
    const editorRect = editor.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    setHandle({ top: rect.top - editorRect.top + editor.scrollTop, target });
  };

  const blockMenuItems = useMemo<
    Array<{ key: string; label: string; icon: ReactNode; danger?: boolean; run: () => void }>
  >(
    () => [
      {
        key: 'duplicate',
        label: '复制本段文字',
        icon: <ContentCopyIcon sx={{ fontSize: 16 }} />,
        run: () => {
          if (!blockMenu) return;
          void navigator.clipboard?.writeText(blockMenu.target.innerText ?? '');
        },
      },
      {
        key: 'append',
        label: '在下方添加行',
        icon: <AddIcon sx={{ fontSize: 16 }} />,
        run: () => {
          if (!blockMenu) return;
          const next = document.createElement('div');
          next.innerHTML = '<br>';
          blockMenu.target.after(next);
          const range = document.createRange();
          range.setStart(next, 0);
          range.collapse(true);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          editorRef.current?.focus();
          sync();
        },
      },
      {
        key: 'delete',
        label: '删除本段',
        icon: <DeleteOutlineIcon sx={{ fontSize: 16 }} color="error" />,
        danger: true,
        run: () => {
          if (!blockMenu) return;
          blockMenu.target.remove();
          sync();
        },
      },
    ],
    [blockMenu, sync],
  );

  return (
    <Box sx={{ position: 'relative' }}>
      {/* 块把手：只在鼠标悬停到某个块时出现，点开是「转换为 / 删除 / 下方插入」 */}
      {!readOnly && handle && (
        <Tooltip title="段落操作">
          <IconButton
            size="small"
            aria-label="段落操作"
            data-testid="kb-editor-block-handle"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setBlockMenu({ position: { top: rect.bottom + 4, left: rect.right + 4 }, target: handle.target });
            }}
            sx={{
              position: 'absolute',
              left: -30,
              top: handle.top + 2,
              color: 'text.disabled',
              zIndex: 2,
            }}
          >
            <DragIndicatorIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}

      {/* 正文。宽高交给外层滚动容器，这里只负责"像一张纸"的排版 */}
      <Box
        ref={editorRef}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="正文"
        data-testid="kb-editor"
        spellCheck={false}
        onInput={sync}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHandle(null)}
        onPaste={(event) => {
          event.preventDefault();
          /*
           * 粘贴分两种：
           * - **图片**（截图 / 从网页复制）→ 先入库拿到 id，再在光标处插图。
           *   必须在 preventDefault 之后、await 之前把选区存下来：上传要几百毫秒，
           *   这期间光标可能已经跑掉了。
           * - **其它** → 只取纯文本（见文件头第 3 条）。
           */
          const items = Array.from(event.clipboardData?.items ?? []);
          const imageItem = items.find(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          );
          const file = imageItem?.getAsFile() ?? null;
          if (file && onUploadImage) {
            captureSelection();
            void onUploadImage(file).then((uploaded) => {
              if (uploaded) insertImage(uploaded.blobUrl, uploaded.alt);
            });
            return;
          }
          const text = event.clipboardData?.getData("text/plain") ?? "";
          // eslint-disable-next-line deprecation/deprecation
          document.execCommand("insertText", false, text);
          sync();
        }}
        sx={{
          minHeight: 320,
          outline: 'none',
          fontSize: 14.5,
          lineHeight: 1.95,
          '& h1': { fontSize: 30, fontWeight: 700, letterSpacing: -0.2, mt: 0, mb: 2 },
          '& h2': { fontSize: 21, fontWeight: 700, mt: 3.5, mb: 1.25 },
          '& h3': { fontSize: 17, fontWeight: 600, mt: 2.5, mb: 1 },
          '& div, & p': { my: 0.75 },
          // 项目符号要显式写回来：全局 reset 把 ul/ol 的 list-style 去掉了，
          // 只给 padding 的结果是「列表变成一段段缩进的行」（编辑时看着像格式丢了）
          '& ul': { listStyle: 'disc', pl: 3, my: 1 },
          '& ol': { listStyle: 'decimal', pl: 3, my: 1 },
          '& li': { display: 'list-item', my: 0.5 },
          '& li::marker': { color: 'text.secondary' },
          // 表格：全局 reset 把 border-collapse 也去掉了，不写回来就是一堆没有边框的
          // 文字块 —— 用户完全看不出那是张表。样式与阅读端共用一份，避免只改一处。
          ...docTableSx('&'),
          // 图片 + 图注：图注是正文里的一行字（可编辑），样式与阅读端共用一份
          ...docFigureSx('&'),
          // 图片：不加 max-width 的话大图会横向撑破抽屉。
          // ⚠️ 圆角写**字符串**：`sx` 里的数字会按 spacing 换算（`4` 实测变成 40px）
          '& img': { maxWidth: '100%', height: 'auto', borderRadius: '6px', my: 0.5 },
          '& blockquote': {
            borderLeft: '3px solid',
            borderColor: 'divider',
            pl: 2,
            my: 2,
            color: 'text.secondary',
          },
          '& pre': {
            p: 1.5,
            my: 2,
            borderRadius: 1.5,
            bgcolor: 'action.hover',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12.5,
            whiteSpace: 'pre-wrap',
          },
          '& a': { color: 'info.main' },
          '&:empty::before': {
            content: '"直接输入，或用上方工具条设置标题与样式。空行分段。"',
            color: 'text.disabled',
          },
        }}
      />

      {/* 选区浮动工具条：fixed 定位，滚动时隐藏（重算代价不如重新选区） */}
      {/* 块菜单开着时收起工具条：两个浮层叠在一起会盖掉正文，也容易点错 */}
      {toolbar && !readOnly && blockMenu === null && (
        <Paper
          elevation={8}
          onMouseDown={(event) => event.preventDefault()}
          sx={{
            position: 'fixed',
            top: toolbar.top,
            left: toolbar.left,
            transform: 'translateX(-50%)',
            zIndex: 1300,
            px: 0.75,
            py: 0.25,
            borderRadius: 2,
            border: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Stack direction="row" alignItems="center" spacing={0.25}>
            <Tooltip title="加粗">
              <IconButton size="small" aria-label="加粗" data-testid="kb-fmt-bold" onClick={() => run('bold')}>
                <FormatBoldIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="斜体">
              <IconButton size="small" aria-label="斜体" data-testid="kb-fmt-italic" onClick={() => run('italic')}>
                <FormatItalicIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="下划线">
              <IconButton size="small" aria-label="下划线" data-testid="kb-fmt-underline" onClick={() => run('underline')}>
                <FormatUnderlinedIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="删除线">
              <IconButton size="small" aria-label="删除线" data-testid="kb-fmt-strike" onClick={() => run('strikeThrough')}>
                <FormatStrikethroughIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="行内代码">
              <IconButton
                size="small"
                aria-label="行内代码"
                data-testid="kb-fmt-code"
                onClick={() => {
                  const selection = window.getSelection();
                  const text = selection?.toString() ?? '';
                  if (text === '') return;
                  const escaped = text
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                  run('insertHTML', `<code>${escaped}</code>`);
                }}
              >
                <CodeIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />
            <Tooltip title="链接">
              <IconButton
                size="small"
                aria-label="链接"
                data-testid="kb-fmt-link"
                onClick={() => {
                  const selection = window.getSelection();
                  savedRange.current =
                    selection && selection.rangeCount > 0
                      ? selection.getRangeAt(0).cloneRange()
                      : null;
                  setLinkValue('https://');
                  setLinkOpen(true);
                }}
              >
                <LinkIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />
            <Tooltip title="无序列表">
              <IconButton size="small" aria-label="无序列表" onClick={() => run('insertUnorderedList')}>
                <FormatListBulletedIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="有序列表">
              <IconButton size="small" aria-label="有序列表" onClick={() => run('insertOrderedList')}>
                <FormatListNumberedIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="引用">
              <IconButton size="small" aria-label="引用" onClick={() => run('formatBlock', 'blockquote')}>
                <FormatQuoteIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="代码块">
              <IconButton size="small" aria-label="代码块" onClick={() => run('formatBlock', 'pre')}>
                <DataObjectIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>
          </Stack>
        </Paper>
      )}

      {/* 链接输入：`window.prompt` 在 Electron 里被禁用（永远返回 null），只能自绘 */}
      {linkOpen && (
        <Paper
          elevation={8}
          sx={{
            position: 'fixed',
            top: toolbar?.top ?? 80,
            left: toolbar?.left ?? 200,
            transform: 'translateX(-50%)',
            zIndex: 1300,
            p: 1,
            borderRadius: 2,
            border: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            gap: 1,
            alignItems: 'center',
          }}
        >
          <TextField
            autoFocus
            size="small"
            placeholder="https://"
            value={linkValue}
            onChange={(event) => setLinkValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                applyLink();
              }
              if (event.key === 'Escape') setLinkOpen(false);
            }}
            inputProps={{ 'data-testid': 'kb-fmt-link-input' }}
            sx={{ width: 240 }}
          />
          <IconButton
            size="small"
            aria-label="确定"
            data-testid="kb-fmt-link-confirm"
            onClick={applyLink}
          >
            <LinkIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Paper>
      )}

      {/* 块类型菜单（把手点开） */}
      <Menu
        anchorReference="anchorPosition"
        anchorPosition={blockMenu?.position}
        open={blockMenu !== null}
        onClose={() => setBlockMenu(null)}
        // 把手在正文左侧之外，菜单必须往**右**展开：往左开会盖住应用侧栏
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 200, py: 0.5 } } }}
      >
        <Typography sx={{ px: 2, pt: 0.5, pb: 0.5, fontSize: 11, color: 'text.secondary' }}>
          转换为
        </Typography>
        {BLOCK_OPTIONS.map((option) => (
          <MenuItem
            key={option.value}
            data-testid={`kb-block-${option.value}`}
            onClick={() => {
              if (blockMenu) selectBlock(blockMenu.target);
              setBlockMenu(null);
              // 选区被 Menu 抢走焦点后仍可用：selectBlock 已经重新设好 Range
              run('formatBlock', option.value);
            }}
            sx={{ py: 0.5 }}
          >
            <ListItemText
              primary={option.label}
              primaryTypographyProps={{
                fontSize: option.value.startsWith('h') ? 13 + Number(option.value[1]) * 0.5 : 13,
                fontWeight: option.value.startsWith('h') ? 700 : 400,
              }}
            />
          </MenuItem>
        ))}
        <Divider sx={{ my: 0.5 }} />
        <MenuItem
          onClick={() => {
            if (blockMenu) {
              selectBlock(blockMenu.target);
              run('insertUnorderedList');
            }
            setBlockMenu(null);
          }}
          sx={{ py: 0.5 }}
        >
          <ListItemIcon sx={{ minWidth: 30 }}>
            <FormatListBulletedIcon sx={{ fontSize: 16 }} />
          </ListItemIcon>
          <ListItemText primary="无序列表" primaryTypographyProps={{ fontSize: 13 }} />
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (blockMenu) {
              selectBlock(blockMenu.target);
              run('insertOrderedList');
            }
            setBlockMenu(null);
          }}
          sx={{ py: 0.5 }}
        >
          <ListItemIcon sx={{ minWidth: 30 }}>
            <FormatListNumberedIcon sx={{ fontSize: 16 }} />
          </ListItemIcon>
          <ListItemText primary="有序列表" primaryTypographyProps={{ fontSize: 13 }} />
        </MenuItem>
        <Divider sx={{ my: 0.5 }} />
        {blockMenuItems.map((item) => (
          <MenuItem
            key={item.key}
            data-testid={`kb-block-${item.key}`}
            onClick={() => {
              item.run();
              setBlockMenu(null);
            }}
            sx={{ py: 0.5 }}
          >
            <ListItemIcon sx={{ minWidth: 30 }}>{item.icon}</ListItemIcon>
            <ListItemText
              primary={item.label}
              primaryTypographyProps={{
                fontSize: 13,
                color: item.danger ? 'error.main' : undefined,
              }}
            />
          </MenuItem>
        ))}
      </Menu>

    </Box>
  );
});
