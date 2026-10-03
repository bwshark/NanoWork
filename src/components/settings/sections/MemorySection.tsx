import { Box, Switch, TextField } from '@mui/material';
import {
  SettingsBlockLabel,
  SettingsCard,
  SettingsRow,
} from '@/components/settings/SettingsPrimitives';
import { MemoryPage } from '@/pages/memory/MemoryPage';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  DEFAULT_MEMORY_POLICY,
  MEMORY_POLICY_LIMITS,
  normalizeMemoryPolicy,
  type MemoryPolicySettings,
} from '@/types';

/**
 * 记忆分区：**开关**与**正文**分开。
 *
 * 上面的卡片改的是「记忆怎么被用」（注入与否、要不要自动沉淀），落点是
 * `settings.json`；下面的编辑器改的是「记忆里写了什么」，落点是记忆文件
 * （用户级 `~/.nanowork/MEMORY.md`、工作区级 `<工作目录>/.nanowork/memory/`）。
 * 两者是不同性质的状态，混在一屏里不给分组会让人以为关掉开关就把记忆清空了。
 */
export function MemorySection() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  // 读出来时归一化一次：持久化文件可能被手工改坏，而非法值（NaN / 负数 / 字符串）
  // 会让门槛**静默失效**（不报错，只是「怎么都不晋升」）——那是最难查的一类故障。
  const policy = normalizeMemoryPolicy(settings.memoryPolicy ?? DEFAULT_MEMORY_POLICY);

  /** 单个数字字段的输入框：越界/非数字时**不写盘**（保留用户正在输入的状态） */
  const NumberField = ({ field }: { field: keyof MemoryPolicySettings }) => {
    const limits = MEMORY_POLICY_LIMITS[field];
    return (
      <TextField
        size="small"
        type="number"
        value={String(policy[field])}
        inputProps={{
          min: limits.min,
          max: limits.max,
          'data-policy-field': field,
          'aria-label': field,
        }}
        onChange={(e) => {
          const next = normalizeMemoryPolicy({
            ...policy,
            [field]: Number(e.target.value),
          });
          // 归一化会把越界值夹回默认值；只有**确实变化**时才写，
          // 否则用户清空输入框的瞬间会被塞回默认数字，光标位置也丢了
          if (next[field] !== policy[field]) {
            setSettings({ memoryPolicy: { ...policy, ...next } });
          }
        }}
        sx={{ width: 120 }}
      />
    );
  };

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
        <SettingsRow
          label="跨会话召回"
          hint="按本轮问题在本机历史会话里检索相关片段（带来源与相关度）。关掉后只注入长期记忆，不检索历史对话"
          control={
            <Switch
              checked={settings.memoryRecall}
              onChange={(e) => setSettings({ memoryRecall: e.target.checked })}
            />
          }
        />
      </SettingsCard>

      {/*
        进阶：门槛与预算（FR-M5 / FR-M10 / FR-M33）。
        与上面的开关分开，因为这些**不该**是日常要碰的东西——默认值就是设计值。
        但把它们露出来是必要的：门槛直接决定「为什么我昨天说的它还不记得」，
        不给调、也不显示，用户只能猜。
      */}
      <SettingsCard
        title="记忆门槛与预算（进阶）"
        description="默认值就是设计值，通常不需要改。改动只影响本机：这些是策略而非事实，不参与云同步。"
      >
        <SettingsRow
          label="事实晋升为长期结论的年龄门槛"
          hint={`当前 ${policy.retentionDays} 天：比这更新的事实仍会进注入（按“最近事实”），但不会成为稳定结论`}
          control={<NumberField field="retentionDays" />}
        />
        <SettingsRow
          label="免重复晋升的最低重要度"
          hint={`当前 ${policy.minImportance}：达到它的事实不必重复出现也能晋升`}
          control={<NumberField field="minImportance" />}
        />
        <SettingsRow
          label="重复出现次数门槛"
          hint={`当前 ${policy.repeatThreshold} 次：重要度不够的事实重复这么多次也可晋升`}
          control={<NumberField field="repeatThreshold" />}
        />
        <SettingsRow
          label="替代既有结论所需的独立证据数"
          hint={`当前 ${policy.supersessionRepeatThreshold}：不足以替代时进入「待裁决」而不是直接改结论`}
          control={<NumberField field="supersessionRepeatThreshold" />}
        />
        <SettingsRow
          label="旧日志归档阈值"
          hint={`当前 ${policy.archiveAfterDays} 天：超过它的日文件移入 archive/。归档只移动、不删除，内容仍可查`}
          control={<NumberField field="archiveAfterDays" />}
        />
        <SettingsRow
          label="用户级注入预算"
          hint={`当前 ${policy.userChars} 字符`}
          control={<NumberField field="userChars" />}
        />
        <SettingsRow
          label="工作区级注入预算"
          hint={`当前 ${policy.workspaceChars} 字符；超出按确定优先级裁剪，并在会话头部提示「截断 N 条」`}
          control={<NumberField field="workspaceChars" />}
        />
        <SettingsRow
          label="注入里携带的最近事实条数"
          hint={`当前 ${policy.recentFactLimit} 条；这是「注入量不随日志天数增长」的实现`}
          control={<NumberField field="recentFactLimit" />}
        />
      </SettingsCard>

      <SettingsBlockLabel description="直接编辑长期记忆正文。用户级是一份文件；工作区级是一个目录（精炼记忆 MEMORY.md + 每天的日志），先选文件再编辑，切换时会重新读盘。">
        记忆内容
      </SettingsBlockLabel>
      <MemoryPage embedded />
    </Box>
  );
}
