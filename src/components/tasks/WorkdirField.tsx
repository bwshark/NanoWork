/**
 * 任务级工作目录（FR-5.8）的录入控件。
 *
 * 为什么给一个「选择目录…」按钮而不是纯输入框：工作目录必须是**绝对路径**，而引擎对
 * 相对路径的处理是**静默回落默认工作空间**（抛出的 `WorkspaceScopeError` 被吞掉、不报错）。
 * 手打一个错路径的代价是「配了没生效、还查不出原因」。按钮走 `platform.pickDirectory()`，
 * 与聊天里切换工作目录**同一个入口**，行为一致。
 *
 * 留空 = 不绑定，任务跟随默认工作空间。
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Button, IconButton, TextField, Tooltip } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ClearIcon from '@mui/icons-material/Clear';
import { platform } from '@/platform';
import { useDefaultWorkspacePath } from '@/stores/storageInfoStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { DEFAULT_WORKSPACE_LABEL, resolveWorkspaceLabel } from '@/lib/workspace/workspaceLabel';

export interface WorkdirFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** 上方字段标签；由调用方给（沿用表单里 `FieldLabel` 的统一观感） */
  label?: ReactNode;
}

export function WorkdirField({ value, onChange, label }: WorkdirFieldProps) {
  const defaultPath = useDefaultWorkspacePath();
  const aliases = useSettingsStore((s) => s.settings.workspaceAliases);
  const [picking, setPicking] = useState(false);
  const trimmed = value.trim();

  const pick = async () => {
    setPicking(true);
    try {
      const dir = await platform.pickDirectory();
      // 取消返回 null：**绝不能**把 null 写成空串，那会顺手清掉用户已填的路径
      if (dir) onChange(dir);
    } finally {
      setPicking(false);
    }
  };

  return (
    <>
      {label}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
        <TextField
          size="small"
          fullWidth
          // 用 aria-label 而不是 MUI 的 `label`：上方已经有 `FieldLabel` 做区块标题，
          // 再来一个浮动 label 就是同一个字段两个标题（视觉噪音）。
          inputProps={{ 'aria-label': '工作目录' }}
          placeholder={defaultPath || DEFAULT_WORKSPACE_LABEL}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          helperText={
            trimmed
              ? // 回显解析后的名字：用户填的是路径，但认的是别名/末级目录名
                `${resolveWorkspaceLabel(trimmed, aliases, defaultPath)} · 任务在此目录下执行`
              : '留空 = 跟随默认工作空间'
          }
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={<FolderOpenIcon />}
          disabled={picking}
          onClick={() => void pick()}
          sx={{ textTransform: 'none', flexShrink: 0, mt: 0.25, whiteSpace: 'nowrap' }}
        >
          选择目录
        </Button>
        {trimmed !== '' && (
          <Tooltip title="不绑定目录（跟随默认工作空间）">
            <IconButton size="small" onClick={() => onChange('')} sx={{ mt: 0.5 }}>
              <ClearIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    </>
  );
}
