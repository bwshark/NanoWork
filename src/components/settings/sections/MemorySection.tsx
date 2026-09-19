import { Box, Switch } from '@mui/material';
import {
  SettingsBlockLabel,
  SettingsCard,
  SettingsRow,
} from '@/components/settings/SettingsPrimitives';
import { MemoryPage } from '@/pages/memory/MemoryPage';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * 记忆分区：**开关**与**正文**分开。
 *
 * 上面的卡片改的是「记忆怎么被用」（注入与否、要不要自动沉淀），落点是
 * `settings.json`；下面的编辑器改的是「记忆里写了什么」，落点是 `~/.nanowork/`
 * 下的 markdown 文件。两者是不同性质的状态，混在一屏里不给分组会让人以为
 * 关掉开关就把记忆清空了。
 */
export function MemorySection() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);

  return (
    <Box>
      <SettingsCard
        title="记忆注入"
        description="长期记忆分两层：工作区级（按工作目录隔离，会话的决策与待办落这里）与用户级（跨项目生效，你的称呼 / 职业 / 稳定偏好落这里）。开启注入后，会话创建时读取一次并在 system 提示末尾以标签块注入。"
      >
        <SettingsRow
          label="注入记忆到会话"
          hint="关闭后新会话不再携带任何长期记忆，已有记忆文件不会被删除"
          control={
            <Switch
              checked={settings.memoryEnabled}
              onChange={(e) => setSettings({ memoryEnabled: e.target.checked })}
            />
          }
        />
        <SettingsRow
          label="会话结束自动沉淀摘要"
          hint="关闭则新会话不会记得你是谁——这是记忆的唯一自动写入源"
          control={
            <Switch
              checked={settings.autoSummarize}
              onChange={(e) => setSettings({ autoSummarize: e.target.checked })}
            />
          }
        />
      </SettingsCard>

      <SettingsBlockLabel description="直接编辑长期记忆正文。两个作用域是两份独立文件，切换时会重新读盘。">
        记忆内容
      </SettingsBlockLabel>
      <MemoryPage embedded />
    </Box>
  );
}
