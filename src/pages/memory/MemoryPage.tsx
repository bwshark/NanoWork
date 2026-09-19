import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import { MemoryService, memoryDiskPath } from '@/lib/memory';
import {
  CURATED_MEMORY_FILE,
  dailyMemoryFileName,
  isDailyMemoryFileName,
  sortMemoryFileNames,
} from '@/lib/workspaceMemory';
import { dirBasename } from '@/lib/workspaceLabel';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { platform } from '@/platform';
import { toast } from '@/components/Toast';
import type { MemoryScope, MemoryScopeSummary } from '@/types';

/**
 * 记忆页（FR-4.2 / FR-4.5）：在线编辑长期记忆。
 *
 * 两层作用域（design §14.1 的四层在 V1 落地两层），用顶部切换器切换：
 *
 * | 作用域 | 落点 | 写入时机 |
 * |---|---|---|
 * | 用户级（L2） | `~/.nanowork/MEMORY.md` **单文件** | 用户显式编辑本页 + 自动沉淀识别出的**身份类**事实 |
 * | 工作区级（L3） | `<工作目录>/.nanowork/memory/` **目录** | 会话结束自动摘要 + 「记住这条」+ Agent 的 `<memory-save>` |
 *
 * ## 工作区级为什么是「先选文件、再编辑」
 *
 * 工作区记忆的磁盘形态是**一个目录**（`MEMORY.md` 精炼记忆 + 若干 `YYYY-MM-DD.md`
 * 每日日志），而注入时读的是它们的**合并视图**。如果编辑器仍绑合并视图：
 * 保存就会把日期文件里的内容整体复制进 `MEMORY.md`，同一句话遂在磁盘上存两份，
 * 此后每次注入都重复一遍。所以这里显式地分两层——
 * **切到工作区级要再选一份文件，编辑器里的内容与「保存」都只针对那一份**。
 *
 * `MEMORY.md` 与「今天的日志」这两项**即使磁盘上不存在也常驻列表**：前者是本页的
 * 主编辑目标，后者是当下要写的落点，两者都是「接下来很可能会写」的文件——
 * 让它们先隐形、等用户写完第一行才出现，只会让「今天该记的东西记到哪」变成猜谜。
 *
 * ## 两个刻意的设计点
 *
 * 1. **切换作用域 / 切换文件必须重新读盘**。三者的正文是三份独立内容，共用一份
 *    `text` state 会让人把 A 的内容存进 B——这是静默的数据串台，比报错难查得多。
 * 2. **导出文件名按作用域区分**。工作区级带上目录名：两层都可能导出 `MEMORY.md`，
 *    同名会在导出目录里互相覆盖，而用户通常只有一份备份。
 *
 * 这一页现在有两种宿主：设置弹窗（`embedded`）与独立路由页。嵌入态去掉外层页面
 * 内边距、`maxWidth` 与那个大标题——弹窗自己的标题栏已经写了「记忆」，再顶一个 h5
 * 就是同一句话说两遍，还会把正文挤下去。
 */
export function MemoryPage({ embedded = false }: { embedded?: boolean }) {
  const [scope, setScope] = useState<MemoryScope>('workspace');
  /** 工作区级当前编辑的文件名（用户级固定 `MEMORY.md`） */
  const [file, setFile] = useState<string>(CURATED_MEMORY_FILE);
  /** 工作区级可选文件列表（含常驻的 `MEMORY.md` 与今天的日志） */
  const [files, setFiles] = useState<string[]>([CURATED_MEMORY_FILE]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [summaries, setSummaries] = useState<MemoryScopeSummary[]>([]);
  /** 危险操作的待确认项（null = 无弹窗） */
  const [pendingConfirm, setPendingConfirm] = useState<'clear' | 'removeFile' | null>(null);
  /** 每次成功写盘后自增，驱动文件列表与正文重读 */
  const [reloadToken, setReloadToken] = useState(0);

  /** 重新读取两层规模概览（保存/清空后调用，保证切换器上的数字是新鲜的） */
  const refreshSummaries = useCallback(async () => {
    const next = await MemoryService.scopeSummaries();
    setSummaries(next);
  }, []);

  useEffect(() => {
    void refreshSummaries();
  }, [refreshSummaries, reloadToken]);

  // 文件列表：用户级只有一份；工作区级列目录，并把两份「常驻项」补进去。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (scope === 'user') {
        if (!cancelled) setFiles([CURATED_MEMORY_FILE]);
        return;
      }
      const listed = await MemoryService.listFiles();
      if (cancelled) return;
      const next = sortMemoryFileNames([
        ...new Set([CURATED_MEMORY_FILE, ...listed, dailyMemoryFileName()]),
      ]);
      setFiles(next);
      // 选中的文件可能已经不在了（在别处被清空/删除）→ 回落精炼记忆
      setFile((current) => (next.includes(current) ? current : CURATED_MEMORY_FILE));
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, reloadToken]);

  // 正文：只读**当前选中的那一份**，不读合并视图（理由见文件头注释）。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const loaded =
        scope === 'user'
          ? await MemoryService.load('user')
          : ((await MemoryService.readFile(undefined, file)) ?? '');
      if (cancelled) return;
      setText(loaded);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, file, reloadToken]);

  const runAction = useCallback(
    async (action: () => Promise<void>, okMsg: string, failPrefix: string) => {
      setBusy(true);
      try {
        await action();
        setReloadToken((n) => n + 1);
        toast.success(okMsg);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`${failPrefix}：${msg}`);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const save = () =>
    runAction(
      () =>
        scope === 'user'
          ? MemoryService.save(text, 'user')
          : MemoryService.writeFile(undefined, file, text),
      '记忆已保存',
      '保存失败',
    );

  /** 工作区记忆的真实落点（目录）；用户级是一个文件 */
  const workspaceDir = MemoryService.resolveWorkspaceDir();
  const diskPath = memoryDiskPath(scope, workspaceDir);

  /**
   * 导出当前**选中的这一份**。
   *
   * 工作区级带上工作目录末级名（`nanowork.2026-09-19.md`）：两层都可能导出
   * `MEMORY.md`，同名会在导出目录里互相覆盖。
   */
  const exportName =
    scope === 'user'
      ? CURATED_MEMORY_FILE
      : `${dirBasename(workspaceDir ?? '') || 'workspace'}.${file}`;

  const exportFile = () =>
    runAction(
      () => platform.writeTextFile(exportName, text),
      `已导出 ${exportName}`,
      '导出失败',
    );

  /**
   * 清空当前作用域。
   *
   * 工作区级是**删掉该工作目录记忆目录下的全部文件**（精炼记忆 + 所有日期日志），
   * 因此必须先确认——它落在用户自己的工程目录里，误按一次等于把长期积累一起清掉。
   */
  const clearAll = () =>
    runAction(
      async () => {
        await MemoryService.clear(scope);
        setText('');
      },
      '记忆已清空',
      '清空失败',
    );

  /** 删除当前选中的那一份文件（仅工作区级：用户级只有一份，删它等于清空） */
  const removeCurrentFile = () =>
    runAction(
      async () => {
        await MemoryService.removeFile(undefined, file);
        setText('');
      },
      `已删除 ${file}`,
      '删除失败',
    );

  /** 清空 / 删除的确认文案里要不要带上落点：Web 端没有文件系统，那句人话塞进路径位置读着别扭 */
  const hasRealPath = platform.env === 'electron';
  const clearMessage =
    scope === 'user'
      ? '将清空用户级长期记忆（~/.nanowork/MEMORY.md）。此操作不可撤销。'
      : `将删除这个工作区记忆目录下的全部记忆文件（精炼记忆 + 所有日期日志）。${
          hasRealPath ? `\n${diskPath}\n` : ''
        }此操作不可撤销，且不会经过回收站。`;

  const meta = MemoryService.meta(text);
  const current = summaries.find((s) => s.scope === scope);
  const today = dailyMemoryFileName();
  /** 文件切换器上的短标签：精炼记忆保留全名，日期文件只显示日期 */
  const fileLabel = (name: string): string => {
    const base = isDailyMemoryFileName(name) ? name.replace(/\.md$/i, '') : name;
    return name === today ? `${base} · 今天` : base;
  };

  return (
    <Box sx={embedded ? undefined : { p: 3, maxWidth: 900, margin: '0 auto' }}>
      {!embedded && (
        <Typography variant="h5" fontWeight={700} gutterBottom>
          记忆
        </Typography>
      )}
      <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 2 }}>
        长期记忆分两层注入。开启注入后，内容会在每次会话以标签块追加到 system
        提示末尾，不会污染 Agent 自身的提示词模板；会话结束时自动沉淀，身份类事实
        进用户级、项目结论进工作区级。
      </Typography>

      <ToggleButtonGroup
        exclusive
        size="small"
        value={scope}
        onChange={(_e, value: MemoryScope | null) => {
          if (!value || value === scope) return;
          // 切层时先清空再进 loading：否则会短暂显示上一层的内容，
          // 用户此时若手快点了保存，就把 A 层写进了 B 层
          setLoading(true);
          setText('');
          setScope(value);
        }}
        aria-label="记忆作用域"
        sx={{ mb: 1.5 }}
      >
        {summaries.map((s) => (
          <ToggleButton key={s.scope} value={s.scope} sx={{ gap: 0.75, px: 1.75 }}>
            {s.scope === 'user' ? (
              <PersonOutlineIcon sx={{ fontSize: 16 }} />
            ) : (
              <FolderOutlinedIcon sx={{ fontSize: 16 }} />
            )}
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
              {s.label}
            </Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
              {s.chars} 字符
            </Typography>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <Paper variant="outlined" sx={{ p: 2, bgcolor: 'background.paper' }}>
        {current && (
          <Box
            sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}
          >
            {/* 磁盘落点：让「记忆到底存在哪」看得见，而不是只能靠文档描述去猜 */}
            <Tooltip
              title={
                scope === 'user'
                  ? `这份记忆的实际落点：${diskPath}`
                  : `这个工作区的记忆目录：${diskPath}（下面选的每一份都是它的直接子文件）`
              }
            >
              <Chip
                size="small"
                variant="outlined"
                icon={<FolderOutlinedIcon sx={{ fontSize: 14 }} />}
                label={diskPath}
                sx={{
                  fontSize: 11,
                  height: 22,
                  maxWidth: '100%',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  cursor: 'help',
                }}
              />
            </Tooltip>
            <Tooltip title={current.description}>
              <Typography
                noWrap
                sx={{ fontSize: 12, color: 'text.secondary', cursor: 'help', minWidth: 0 }}
              >
                {current.description}
              </Typography>
            </Tooltip>
          </Box>
        )}

        {/* 工作区级：文件切换器。文件之间是并列的三份内容，不是一份的多个版本。 */}
        {scope === 'workspace' && (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={file}
            onChange={(_e, value: string | null) => {
              if (!value || value === file) return;
              // 与切层同理：先清空再进 loading，避免把上一份的内容存进这一份
              setLoading(true);
              setText('');
              setFile(value);
            }}
            aria-label="记忆文件"
            sx={{ mb: 1.25, flexWrap: 'wrap', gap: 0.5 }}
          >
            {files.map((name) => (
              <ToggleButton
                key={name}
                value={name}
                sx={{ gap: 0.5, px: 1.25, py: 0.25, textTransform: 'none' }}
              >
                <InsertDriveFileOutlinedIcon sx={{ fontSize: 14 }} />
                <Typography
                  sx={{
                    fontSize: 12,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  }}
                >
                  {fileLabel(name)}
                </Typography>
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        )}

        <TextField
          fullWidth
          multiline
          minRows={16}
          maxRows={28}
          placeholder={
            loading
              ? '加载中…'
              : scope === 'user'
                ? '# 我的长期偏好\n\n> 只在明确希望「跨项目都生效」时才写这里。'
                : file === CURATED_MEMORY_FILE
                  ? '# 这个项目的长期记忆\n\n> 精炼后的结论与约定。注入时排在最前，适合放稳定的事实。'
                  : `# ${file.replace(/\.md$/i, '')} 的日志\n\n> 这一天的沉淀会自动追加到这里；你也可以手动补充。`
          }
          value={text}
          disabled={loading}
          onChange={(e) => setText(e.target.value)}
          InputProps={{
            sx: {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 13,
            },
          }}
        />

        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
          <Button variant="contained" onClick={save} disabled={loading || busy}>
            保存
          </Button>
          <Button variant="outlined" onClick={exportFile} disabled={loading || busy}>
            导出
          </Button>
          {scope === 'workspace' && (
            <Button
              color="warning"
              variant="outlined"
              onClick={() => setPendingConfirm('removeFile')}
              disabled={loading || busy}
            >
              删除此文件
            </Button>
          )}
          <Button
            color="error"
            variant="outlined"
            onClick={() => setPendingConfirm('clear')}
            disabled={loading || busy}
          >
            清空
          </Button>
          <Box sx={{ flex: 1 }} />
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
            {meta.chars} 字符 · 约 {meta.entries} 条
            {meta.lastWrittenAt ? ` · 最后写入 ${meta.lastWrittenAt}` : ''}
          </Typography>
        </Stack>
      </Paper>

      <ConfirmDialog
        open={pendingConfirm !== null}
        danger
        title={pendingConfirm === 'removeFile' ? '删除这一份记忆' : '清空记忆'}
        message={
          pendingConfirm === 'removeFile'
            ? `将删除「${file}」。此操作不可撤销，文件内容不会进入回收站。`
            : clearMessage
        }
        confirmText={pendingConfirm === 'removeFile' ? '删除' : '清空'}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const kind = pendingConfirm;
          setPendingConfirm(null);
          if (kind === 'removeFile') void removeCurrentFile();
          else void clearAll();
        }}
      />
    </Box>
  );
}
