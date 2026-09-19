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
import { MemoryService, memoryDiskPath } from '@/lib/memory';
import { platform } from '@/platform';
import { MEMORY_FILENAME } from '@/lib/constants';
import { toast } from '@/components/Toast';
import type { MemoryScope, MemoryScopeSummary } from '@/types';

/**
 * 记忆页（FR-4.2 / FR-4.5）：在线编辑长期记忆。
 *
 * 两层作用域（design §14.1 的四层在 V1 落地两层），用顶部切换器切换：
 *
 * | 作用域 | 落点 | 写入时机 |
 * |---|---|---|
 * | 用户级（L2） | `~/.nanowork/MEMORY.md` | 用户显式编辑本页 + 自动沉淀识别出的**身份类**事实 |
 * | 工作区级（L3） | `~/.nanowork/memory/<workspaceKey>.md` | 会话结束自动摘要 + 「记住这条」+ Agent 的 `<memory-save>` |
 *
 * 两个刻意的设计点：
 *
 * 1. **切换作用域必须重新读盘**。两个作用域的正文是两份独立文件，共用一份
 *    `text` state 会让人把 A 层的内容存进 B 层——这是静默的数据串台，
 *    比报错难查得多。
 * 2. **导出文件名按作用域区分**。两者都叫 `MEMORY.md`，若导出同名会让用户在
 *    下载目录里覆盖掉另一个作用域的备份；工作区级因此带上 workspace key。
 *
 * 这一页现在有两种宿主：设置弹窗（`embedded`）与独立路由页。嵌入态去掉外层页面
 * 内边距、`maxWidth` 与那个大标题——弹窗自己的标题栏已经写了「记忆」，再顶一个 h5
 * 就是同一句话说两遍，还会把正文挤下去。
 */
export function MemoryPage({ embedded = false }: { embedded?: boolean }) {
  const [scope, setScope] = useState<MemoryScope>('workspace');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [summaries, setSummaries] = useState<MemoryScopeSummary[]>([]);

  /** 重新读取两层规模概览（保存/清空后调用，保证切换器上的数字是新鲜的） */
  const refreshSummaries = useCallback(async () => {
    const next = await MemoryService.scopeSummaries();
    setSummaries(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [loaded] = await Promise.all([
        MemoryService.load(scope),
        refreshSummaries(),
      ]);
      if (!cancelled) {
        setText(loaded);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, refreshSummaries]);

  const runAction = useCallback(
    async (action: () => Promise<void>, okMsg: string, failPrefix: string) => {
      setBusy(true);
      try {
        await action();
        await refreshSummaries();
        toast.success(okMsg);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`${failPrefix}：${msg}`);
      } finally {
        setBusy(false);
      }
    },
    [refreshSummaries],
  );

  const save = () =>
    runAction(() => MemoryService.save(text, scope), '记忆已保存', '保存失败');

  const workspaceKey = MemoryService.resolveWorkspaceKey();
  /** 磁盘上的真实落点（工作区级随活跃会话的工作目录变化） */
  const diskPath = memoryDiskPath(scope, workspaceKey);

  /**
   * 导出当前作用域。
   * 工作区级带 workspace key：两层默认文件名相同，不带 key 会在下载目录里
   * 互相覆盖，而用户通常只有一份备份。
   */
  const exportName =
    scope === 'user' ? MEMORY_FILENAME : `MEMORY.${workspaceKey}.md`;

  const exportFile = () =>
    runAction(
      () => platform.writeTextFile(exportName, text),
      `已导出 ${exportName}`,
      '导出失败',
    );

  const clearAll = () =>
    runAction(
      async () => {
        await MemoryService.clear(scope);
        setText('');
      },
      '记忆已清空',
      '清空失败',
    );

  const meta = MemoryService.meta(text);
  const current = summaries.find((s) => s.scope === scope);

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
            <Tooltip title={`记忆文件的实际落点：${diskPath}`}>
              <Chip
                size="small"
                variant="outlined"
                icon={<FolderOutlinedIcon sx={{ fontSize: 14 }} />}
                label={diskPath}
                sx={{
                  fontSize: 11,
                  height: 22,
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
                : '# 我的工作区记忆\n\n> 在这里记录长期偏好、关键决策与待办。'
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
          <Button
            color="error"
            variant="outlined"
            onClick={clearAll}
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
    </Box>
  );
}
