import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { MemoryService } from '@/lib/memory';
import { platform } from '@/platform';
import { MEMORY_FILENAME } from '@/lib/constants';
import { toast } from '@/components/Toast';

/**
 * 记忆页：在线编辑工作区记忆（MEMORY.md）。
 * 支持 保存（覆盖写）/ 导出（Electron 落盘、Web 下载）/ 清空。
 */
export function MemoryPage() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await MemoryService.load();
      if (!cancelled) {
        setText(loaded);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runAction = useCallback(
    async (action: () => Promise<void>, okMsg: string, failPrefix: string) => {
      setBusy(true);
      try {
        await action();
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

  const save = () => runAction(() => MemoryService.save(text), '记忆已保存', '保存失败');

  const exportFile = () =>
    runAction(
      () => platform.writeTextFile(MEMORY_FILENAME, text),
      `已导出 ${MEMORY_FILENAME}`,
      '导出失败',
    );

  const clearAll = () =>
    runAction(
      async () => {
        await MemoryService.clear();
        setText('');
      },
      '记忆已清空',
      '清空失败',
    );

  const meta = MemoryService.meta(text);

  return (
    <Box sx={{ p: 3, maxWidth: 900, margin: '0 auto' }}>
      <Typography variant="h5" fontWeight={700} gutterBottom>
        记忆
      </Typography>
      <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 2 }}>
        工作区长期记忆（{MEMORY_FILENAME}）。开启注入后，内容会在每次会话以标签块追加到 system
        提示末尾，不会污染 Agent 自身的提示词模板。
      </Typography>

      <Paper variant="outlined" sx={{ p: 2, bgcolor: 'background.paper' }}>
        <TextField
          fullWidth
          multiline
          minRows={16}
          maxRows={28}
          placeholder={
            loading ? '加载中…' : '# 我的工作区记忆\n\n> 在这里记录长期偏好、关键决策与待办。'
          }
          value={text}
          disabled={loading}
          onChange={(e) => setText(e.target.value)}
          InputProps={{ sx: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 } }}
        />

        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
          <Button variant="contained" onClick={save} disabled={loading || busy}>
            保存
          </Button>
          <Button variant="outlined" onClick={exportFile} disabled={loading || busy}>
            导出
          </Button>
          <Button color="error" variant="outlined" onClick={clearAll} disabled={loading || busy}>
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
