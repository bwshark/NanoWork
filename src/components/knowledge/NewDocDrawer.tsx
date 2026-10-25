import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  InputBase,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import CloseIcon from "@mui/icons-material/Close";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import EventNoteOutlinedIcon from "@mui/icons-material/EventNoteOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ChecklistOutlinedIcon from "@mui/icons-material/ChecklistOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import { KB_UPLOAD_ACCEPT } from "@/lib/kb/kbUpload";

/**
 * 「新建文档」抽屉（点「+ → 文档」打开）。
 *
 * ## 为什么是抽屉而不是弹窗
 *
 * 写正文是一个**会停很久**的动作：弹窗那种「一个小框 + 确定/取消」的形态会让人
 * 下意识写两句就交，而资料入库的价值全在写得够不够。抽屉占满整屏高度、正文区
 * 自成一个可滚动区，是「我要在这儿写点东西」的信号；它也留出了模板与字数这些
 * 副信息的位置。
 *
 * ## 四个必须做对的地方（都是踩过同类坑的结论）
 *
 * 1. **关掉不等于丢**：草稿留在页面状态里，重开抽屉还在（同一页内）。真丢了才提示，
 *    所以在**有内容**时关抽屉要先问一句 —— 无内容时多问一次只是烦。
 * 2. **标题可以留空**：服务端必须有标题，但让人先想标题是反的（想到什么先写下来）。
 *    留空时用正文首行兜底，标题框的 placeholder 里把这件事说出来。
 * 3. **入库后正文不可再改**（服务端只有改名接口）——这句话必须写在提交按钮旁边，
 *    否则用户会把它当在线文档用，第二天发现改不了。
 * 4. **失败不清稿**：409（重复）与解析失败都会让内容留在抽屉里，重开重试都还在。
 */
export interface NewDocTemplate {
  id: string;
  name: string;
  /** 卡片上的一句话（写「这个模板能省掉什么」，不是正文的截断） */
  desc: string;
  title: string;
  body: string;
}

/**
 * 模板：结构与名字都是给真实用途的（不是占位符）。
 *
 * 它们只在**正文为空**时出现：已经在写的人不需要再看到一排模板。
 */
export const NEW_DOC_TEMPLATES: readonly NewDocTemplate[] = [
  {
    id: 'meeting',
    name: '会议纪要',
    desc: '议题、结论、待办三段式',
    title: '会议纪要',
    body: `会议主题：
时间：
参会人：
记录人：

一、议题
1.

二、结论
-

三、待办
- [ ] 负责人 · 截止日期
`,
  },
  {
    id: 'weekly',
    name: '工作周报',
    desc: '本周完成 / 进行中 / 下周计划',
    title: '工作周报',
    body: `一、本周完成
-

二、进行中
-

三、下周计划
-

四、风险与需要的支持
-
`,
  },
  {
    id: 'task',
    name: '任务管理',
    desc: '背景、目标、范围、验收标准',
    title: '任务说明',
    body: `背景


目标


范围（做什么 / 不做什么）
- 做：
- 不做：

验收标准
1.

排期与依赖
`,
  },
  {
    id: 'team',
    name: '团队管理',
    desc: '适用范围、角色职责、流程',
    title: '团队制度',
    body: `一、适用范围


二、角色与职责


三、流程


四、例外与审批


五、生效日期
`,
  },
];

const TEMPLATE_ICONS: Record<string, ReactNode> = {
  meeting: <EventNoteOutlinedIcon sx={{ fontSize: 18 }} />,
  weekly: <DescriptionOutlinedIcon sx={{ fontSize: 18 }} />,
  task: <ChecklistOutlinedIcon sx={{ fontSize: 18 }} />,
  team: <GroupsOutlinedIcon sx={{ fontSize: 18 }} />,
};

/** 正文首行当标题（截断靠调用方；这里只负责「取第一行有内容的」）。 */
export function titleFromContent(content: string, limit = 60): string {
  for (const line of content.split(/\r?\n/)) {
    const text = line.replace(/^[#>\-\s]+/, '').trim();
    if (text !== '') return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }
  return '';
}

export interface NewDocDrawerProps {
  open: boolean;
  busy: boolean;
  /** 目标库（显示在元信息行，让人确认写进哪儿） */
  kbName: string;
  /** 「谁 · 什么时候」这一行里的「谁」 */
  authorLabel: string;
  title: string;
  content: string;
  onTitleChange: (value: string) => void;
  onContentChange: (value: string) => void;
  /**
   * 关闭请求。`discard = true` 表示用户明确选了「丢弃」——
   * 只有这时调用方才清空草稿；Esc / 关闭按钮默认保留（草稿留在页面里）。
   */
  onClose: (discard: boolean) => void;
  onSubmit: () => void;
}

export function NewDocDrawer({
  open,
  busy,
  kbName,
  authorLabel,
  title,
  content,
  onTitleChange,
  onContentChange,
  onClose,
  onSubmit,
}: NewDocDrawerProps) {
  const [wide, setWide] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const dirty = title.trim() !== '' || content.trim() !== '';
  const chars = content.replace(/\s/g, '').length;
  const fallbackTitle = useMemo(() => titleFromContent(content), [content]);
  // 元信息里的时间只在「每次打开」时取一次：写半小时之后还显示「今天 18:37」才是对的
  // （那是这篇文档的创建时刻，不是现在几点）
  const stamp = useMemo(() => {
    const now = new Date();
    const hh = `${now.getHours()}`.padStart(2, '0');
    const mm = `${now.getMinutes()}`.padStart(2, '0');
    return `今天 ${hh}:${mm}`;
  }, [open]);

  // 打开后把焦点给标题：这是唯一一个「不填也能提交」的字段，但先聚焦能省一次点击
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => titleRef.current?.focus(), 220);
    return () => window.clearTimeout(timer);
  }, [open]);

  /**
   * 正文框随内容长高。
   *
   * 先把高度设成 `auto` 再读 `scrollHeight`：不重置的话它只会**单向变大**，
   * 删掉几行后留一大片空白，看起来像卡住了。
   */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 150)}px`;
  }, [content, open]);

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setConfirmOpen(true);
      return;
    }
    onClose(false);
  };

  const applyTemplate = (template: NewDocTemplate) => {
    // 只在空稿上覆盖：已经写了字的人点模板，等于把内容清掉（那该走确认）
    onTitleChange(template.title);
    onContentChange(template.body);
  };

  const canSubmit = !busy && content.trim() !== '';

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={requestClose}
      ModalProps={{ keepMounted: false }}
      PaperProps={{
        // 让 `[role="dialog"]` 仍然能定位到这个抽屉（无障碍与现有用例共用同一个判据）
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "kb-doc-drawer-heading",
        sx: {
          width: wide ? "100%" : { xs: "100%", sm: 860 },
          maxWidth: "100%",
          bgcolor: "background.paper",
          backgroundImage: "none",
        },
      }}
    >
      <Stack
        direction="column"
        sx={{ height: "100%", minHeight: 0 }}
        onKeyDown={(event) => {
          // ⌘/Ctrl+Enter 保存：写长文的肌肉记忆（不拦 Enter，正文要换行）
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSubmit) {
            event.preventDefault();
            onSubmit();
          }
        }}
      >
        {/* 顶栏：文档类型 + 操作。刻意与正文区用一条分割线隔开 —— 正文是滚动区 */}
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ pl: 2, pr: 1.25, height: 52, flexShrink: 0, borderBottom: "1px solid", borderColor: "divider" }}
        >
          <ArticleOutlinedIcon sx={{ fontSize: 18, color: "text.secondary" }} />
          <Typography
            id="kb-doc-drawer-heading"
            sx={{ fontSize: 13.5, fontWeight: 600, flex: 1, minWidth: 0 }}
          >
            文档
          </Typography>
          <Button
            size="small"
            variant="contained"
            disabled={!canSubmit}
            data-testid="doc-submit"
            onClick={onSubmit}
            sx={{ flexShrink: 0 }}
          >
            {busy ? "入库中…" : "入库"}
          </Button>
          <Tooltip title={wide ? "还原宽度" : "全宽"}>
            <IconButton
              size="small"
              aria-label={wide ? "还原宽度" : "全宽"}
              onClick={() => setWide((previous) => !previous)}
            >
              {wide ? <CloseFullscreenIcon fontSize="small" /> : <OpenInFullIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title="关闭">
            <IconButton
              size="small"
              aria-label="关闭"
              data-testid="doc-drawer-close"
              disabled={busy}
              onClick={requestClose}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>

        {/* 元信息：写进哪个库、谁、什么时候、多少字 */}
        <Box sx={{ px: { xs: 2.5, sm: 4.5 }, pt: 2, flexShrink: 0 }}>
          <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.25 }}>
            <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>文档</Typography>
          </Stack>
          <Typography sx={{ fontSize: 11.5, color: "text.secondary" }} data-testid="doc-meta">
            入库到「{kbName}」· {authorLabel} · {stamp} · {chars} 字
          </Typography>
        </Box>

        {/* 正文：标题 + 内容在同一个滚动区里，像一张纸 */}
        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: { xs: 2.5, sm: 4.5 }, pb: 3 }}>
          <InputBase
            inputRef={titleRef}
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="无标题文档"
            inputProps={{
              "data-testid": "doc-title",
              "aria-label": "标题",
              maxLength: 200,
            }}
            sx={{
              width: "100%",
              mt: 3,
              mb: 1,
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: -0.2,
              "& input": { p: 0 },
              // 用 `.MuiInputBase-input` 定位而不是 `input`：placeholder 的样式
              // 被 MUI 自己的规则写在同一个元素上，靠后代选择器才稳定盖得住
              "& .MuiInputBase-input::placeholder": { color: "text.disabled", opacity: 1 },
            }}
          />

          <Box
            component="textarea"
            ref={(el: HTMLTextAreaElement | null) => {
              bodyRef.current = el;
            }}
            value={content}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              onContentChange(event.target.value)
            }
            placeholder="直接粘贴或输入正文。空行分段，每段会切成一块参与检索。"
            data-testid="doc-content"
            aria-label="正文"
            spellCheck={false}
            sx={{
              width: "100%",
              // 高度由内容决定（见下面的 useLayoutEffect）：写长文时不该在一个
              // 150px 的小框里上下翻——滚动交给我外面的「纸张」区
              minHeight: 150,
              mt: 1,
              border: "none",
              outline: "none",
              resize: "none",
              overflow: "hidden",
              bgcolor: "transparent",
              color: "inherit",
              font: "inherit",
              fontSize: 14.5,
              lineHeight: 1.95,
              "&::placeholder": { color: "text.disabled", opacity: 1 },
            }}
          />

          {/* 模板只在空稿时出现：已经在写的人不需要再看一排模板 */}
          {content.trim() === "" && (
            <Box sx={{ mt: 2 }}>
              <Typography sx={{ fontSize: 12, color: "text.secondary", mb: 1 }}>
                从模板创建
              </Typography>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                  gap: 1.25,
                }}
              >
                {NEW_DOC_TEMPLATES.map((template) => (
                  <Paper
                    key={template.id}
                    variant="outlined"
                    role="button"
                    tabIndex={0}
                    data-testid={`doc-template-${template.id}`}
                    onClick={() => applyTemplate(template)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        applyTemplate(template);
                      }
                    }}
                    sx={{
                      p: 1.25,
                      borderRadius: 2,
                      cursor: "pointer",
                      "&:hover": { borderColor: "text.secondary", bgcolor: "action.hover" },
                    }}
                  >
                    <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.75, color: "text.secondary" }}>
                      {TEMPLATE_ICONS[template.id]}
                      <Typography sx={{ fontSize: 12.5, fontWeight: 600, color: "text.primary" }}>
                        {template.name}
                      </Typography>
                    </Stack>
                    <Typography
                      sx={{
                        fontSize: 10.5,
                        color: "text.secondary",
                        lineHeight: 1.7,
                      }}
                    >
                      {template.desc}
                    </Typography>
                  </Paper>
                ))}
              </Box>
            </Box>
          )}
        </Box>

        <Divider />
        <Box sx={{ px: { xs: 2.5, sm: 4.5 }, py: 1.25, flexShrink: 0 }}>
          <Typography sx={{ fontSize: 11, color: "text.secondary" }} data-testid="doc-drawer-hint">
            {fallbackTitle !== "" && title.trim() === ""
              ? `标题留空将使用正文首行：${fallbackTitle}`
              : `入库后正文不可再编辑（只能改标题）；单篇上限 20 万字。要保留原格式请用「上传文件」（${KB_UPLOAD_ACCEPT.split(",").join(" / ")}）。`}
          </Typography>
        </Box>
      </Stack>

      {/* 有内容时关抽屉要先问。三个出口而不是两个：「关掉但留着」是真实需求
          （我要去看一眼别的库再回来接着写），只给「丢弃/继续写」会逼人二选一 */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>这次输入还没入库</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
            保留草稿后，本页再次打开「文档」时会带你回到现在的内容（离开本页就没了）。
            丢弃则清空，无法撤销。
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 1.75 }}>
          <Button size="small" onClick={() => setConfirmOpen(false)}>
            继续写
          </Button>
          <Button
            size="small"
            variant="outlined"
            data-testid="doc-keep-confirm"
            onClick={() => {
              setConfirmOpen(false);
              onClose(false);
            }}
          >
            保留草稿
          </Button>
          <Button
            size="small"
            color="error"
            variant="contained"
            data-testid="doc-discard-confirm"
            onClick={() => {
              setConfirmOpen(false);
              onClose(true);
            }}
          >
            丢弃并关闭
          </Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  );
}
