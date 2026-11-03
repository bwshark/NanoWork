import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  TextField,
  Typography,
} from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { toast } from '@/components/Toast';
import { isFileArtifact } from '@/lib/artifact/fileArtifact';
import { readLocalTextFile } from '@/lib/artifact/localFilePreview';
import { startSelectionRewrite } from '@/lib/artifact/selectionRewriteService';
import {
  isValidSelection,
  normalizeSelection,
  selectedText,
  type TextSelection,
} from '@/lib/artifact/selectionRewrite';
import type { Artifact } from '@/types';

/**
 * FR-7.5 圈选改写编辑器。
 *
 * ## 为什么用 textarea 而不是在渲染好的正文上直接圈选
 *
 * Markdown / 代码高亮产物渲染后是**一棵 DOM 树**，浏览器选区给的是
 * `Range`（节点 + 节点内偏移）。把它换算成原文的字符偏移要遍历所有文本节点、
 * 还要处理 `<br>`、表格单元格、被吞掉的标记符号——任何一处算漏，改写就会落到
 * 错误的段落上，而用户看到的只是「改坏了」。
 *
 * `textarea` 的 `selectionStart / selectionEnd` **本身就是原文字符偏移**，
 * 与 `content` 同一坐标系，不需要任何换算。代价是这段正文退化为纯文本视图
 * （没有高亮），但改写场景下用户要的是「精确框住要改的那几句」，纯文本更合适。
 *
 * ## 正文从哪来
 *
 * 与 `ArtifactPreviewBody` 同一条判据：文件产物入库时正文快照可能为空
 * （`edit` / `apply_patch` 拿不到全文），此时按 `path` 回读磁盘。回读不到就
 * **不进入编辑**（提示原因），而不是给一个空 textarea —— 后者一保存就是把文件清空。
 */

interface SelectionRewriteEditorProps {
  artifact: Artifact;
  /** 改写成功（已升版）后回调；参数是新版本号 */
  onApplied: (version: number) => void;
  onClose: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'unavailable'; reason: string };

export function SelectionRewriteEditor({ artifact, onApplied, onClose }: SelectionRewriteEditorProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  /** 进行中的改写句柄（取消 / 卸载时 abort） */
  const handleRef = useRef<{ cancel(): void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });

    const ready = (content: string) => {
      if (cancelled) return;
      if (content === '') {
        // 空正文不进入编辑：textarea 里按一下保存就等于把文件清空
        setLoad({ status: 'unavailable', reason: '这个产物没有可编辑的正文快照' });
        return;
      }
      setLoad({ status: 'ready', content });
    };

    const snapshot = artifact.content;
    if (snapshot !== '') {
      ready(snapshot);
      return () => {
        cancelled = true;
      };
    }

    if (!isFileArtifact(artifact) || !artifact.path?.trim()) {
      ready('');
      return () => {
        cancelled = true;
      };
    }

    void readLocalTextFile(artifact.path).then((result) => {
      if (cancelled) return;
      if (!result) {
        setLoad({
          status: 'unavailable',
          reason: '无法读取该文件内容（仅桌面端可编辑，或文件已不存在）',
        });
        return;
      }
      ready(result.content);
    });

    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.content, artifact.path]);

  // 卸载即取消：否则用户关掉面板后模型还在跑，回来时正文已被悄悄改掉
  useEffect(
    () => () => {
      handleRef.current?.cancel();
      handleRef.current = null;
    },
    [],
  );

  const content = load.status === 'ready' ? load.content : '';
  const selectionValid = isValidSelection(selection, content.length);
  const selectionText = selectionValid ? selectedText(content, selection) : '';

  /** 读当前选区。用 `selectionStart/End` 而不是 `window.getSelection()`：
   *  后者在 textarea 里拿不到偏移，只能拿到空串。 */
  const syncSelection = useCallback(() => {
    const area = areaRef.current;
    if (!area) return;
    const next = normalizeSelection(area.selectionStart, area.selectionEnd, area.value.length);
    setSelection(next);
  }, []);

  const run = async () => {
    if (!selectionValid || !selection) {
      toast.warning('请先在正文里圈选要改写的那一段');
      return;
    }
    if (instruction.trim() === '') {
      toast.warning('请说明想怎么改');
      return;
    }
    setBusy(true);
    const handle = startSelectionRewrite({ artifact, selection, instruction });
    handleRef.current = handle;
    const result = await handle.result;
    handleRef.current = null;
    setBusy(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }
    toast.success(`已改写并生成 v${result.version}`);
    onApplied(result.version);
  };

  const preview = useMemo(() => {
    if (!selectionValid) return '';
    return selectionText.length > 120 ? `${selectionText.slice(0, 120)}…` : selectionText;
  }, [selectionValid, selectionText]);

  if (load.status === 'loading') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary', py: 2 }}>
        <CircularProgress size={12} sx={{ color: 'text.secondary' }} />
        <Typography sx={{ fontSize: 12.5 }}>读取正文中…</Typography>
      </Box>
    );
  }

  if (load.status === 'unavailable') {
    return (
      <Box sx={{ py: 1.5 }}>
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary', lineHeight: 1.6 }}>
          {load.reason}
        </Typography>
        <Button size="small" sx={{ mt: 1, textTransform: 'none' }} onClick={onClose}>
          返回
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minHeight: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AutoFixHighIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary', flex: 1, minWidth: 0 }}>
          圈住要改的一段，然后说明怎么改
        </Typography>
        <Button size="small" sx={{ textTransform: 'none', minWidth: 0 }} onClick={onClose} disabled={busy}>
          取消
        </Button>
      </Box>

      <TextField
        inputRef={areaRef}
        value={content}
        onChange={() => undefined}
        // 只读输入框：正文由产物决定，这里不让用户直接编辑（直接编辑是另一件事，
        // 会绕开「改写」的意图说明与审计）。只用来取选区。
        multiline
        minRows={8}
        maxRows={20}
        fullWidth
        aria-label="产物正文（可圈选）"
        onSelect={syncSelection}
        onMouseUp={syncSelection}
        onKeyUp={syncSelection}
        // MUI v5 使用 InputProps（v6+ 才统一为 slotProps.input）
        InputProps={{
          readOnly: true,
          sx: {
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            fontSize: 12.5,
            lineHeight: 1.6,
          },
        }}
      />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ fontSize: 11.5, color: 'text.secondary', flexShrink: 0 }}>
          {selectionValid ? `已选 ${selectionText.length} 字` : '未选择'}
        </Typography>
        {selectionValid && (
          <Typography
            noWrap
            sx={{ fontSize: 11.5, color: 'text.disabled', minWidth: 0, flex: 1 }}
            title={selectionText}
          >
            {preview}
          </Typography>
        )}
      </Box>

      <TextField
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="例如：改得更简洁；把这三行改成英文；把循环换成 map"
        size="small"
        fullWidth
        disabled={busy}
        aria-label="改写要求"
        InputProps={{ sx: { fontSize: 12.5 } }}
      />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button
          size="small"
          variant="contained"
          disableElevation
          sx={{ textTransform: 'none' }}
          onClick={() => void run()}
          disabled={busy || !selectionValid || instruction.trim() === ''}
          startIcon={busy ? <CircularProgress size={12} /> : <AutoFixHighIcon sx={{ fontSize: 15 }} />}
        >
          {busy ? '改写中…' : '让 AI 改写'}
        </Button>
        {busy && (
          <Button
            size="small"
            sx={{ textTransform: 'none' }}
            onClick={() => handleRef.current?.cancel()}
          >
            停止
          </Button>
        )}
        <Typography sx={{ fontSize: 11.5, color: 'text.secondary', flex: 1, textAlign: 'right' }}>
          改写会新开一版，可在版本历史里回退
        </Typography>
      </Box>
    </Box>
  );
}
