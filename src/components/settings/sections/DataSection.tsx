import { useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { toast } from '@/components/Toast';
import { platform } from '@/platform';

/**
 * 数据管理：本地持久化数据的落点说明 + 清空。
 *
 * 「清空」加确认弹窗是本次唯一的行为变更：原先点一下就把会话、Agent、技能、MCP、
 * 任务、产物全清了，而按钮和普通操作按钮长得一样。清空属不可逆操作，必须过一次确认。
 */
export function DataSection() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const clearData = async () => {
    setBusy(true);
    try {
      await platform.storage.clear();
      toast.success('本地数据已清空，即将刷新');
      setTimeout(() => window.location.reload(), 600);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <Box>
      <SettingsCard
        title="数据落点"
        description="用户资产统一落在家目录的 ~/.nanowork/ 下，按 key 一个文件：settings.json、MEMORY.md、prompts/、plugins/ 等；会话事件流与运行缓存落在应用数据目录。"
      >
        <SettingsRow
          label="用户资产目录"
          hint="~/.nanowork/ —— 记忆、身份文件、提示词覆盖、插件包、连接器凭据都在这里"
        />
        <SettingsRow
          label="运行数据目录"
          hint="会话事件流（*.jsonl）、索引、日志与临时缓存；随应用数据目录走"
        />
      </SettingsCard>

      <SettingsCard
        title="清空本地数据"
        description="清空会话、Agent、技能、MCP、任务、产物等本地持久化数据。"
      >
        <SettingsRow
          label="重置为初始状态"
          hint="插件目录与提示词覆盖属用户资产，不会被一并带走；操作不可撤销，完成后应用会自动刷新"
          control={
            <Button
              color="error"
              variant="outlined"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              清空本地数据
            </Button>
          }
        />
      </SettingsCard>

      <Typography sx={{ fontSize: 12, color: 'text.secondary', px: 0.5 }}>
        清空是本地行为，不会影响云端（若已接入同步）中已存在的数据。
      </Typography>

      <ConfirmDialog
        open={confirming}
        danger
        title="清空本地数据"
        message="将删除本地所有会话、Agent、技能、MCP、任务与产物配置。此操作不可撤销，确定继续吗？"
        confirmText="清空并刷新"
        onConfirm={() => void clearData()}
        onCancel={() => setConfirming(false)}
      />
    </Box>
  );
}
