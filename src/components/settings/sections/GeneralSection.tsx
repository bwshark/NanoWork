import { Box, Switch, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { useDesktopConfig } from '@/hooks/useDesktopConfig';
import { platform } from '@/platform';
import { normalizeTheme, useSettingsStore } from '@/stores/settingsStore';
import type { Settings } from '@/types';

/**
 * 桌面端专有设置：系统托盘 / 开机自启 / Dock。
 * 仅在 Electron 环境渲染（Web 端无托盘能力，整块隐藏）。
 *
 * 「全局唤起快捷键」原先也在这里，现已迁到设置弹窗的「快捷键」分区——
 * 那里才是「键位」的归属地，放在桌面端卡片里会让用户在两处找同一件东西。
 * 主进程同步语义由 `useDesktopConfig` 统一提供，与本分区共享。
 */
function DesktopCard() {
  const { desktop, apply } = useDesktopConfig();
  const isMac = window.electronAPI?.getPlatform() === 'darwin';

  return (
    <SettingsCard
      title="桌面端"
      description="关闭窗口后应用会常驻系统托盘，像微信/钉钉一样在后台运行；需要结束时请从托盘图标右键菜单选择「退出」。"
    >
      <SettingsRow
        label="关闭窗口时最小化到托盘"
        hint="不退出进程，保留后台任务与 IM 频道连接"
        control={
          <Switch
            checked={desktop.closeToTray}
            onChange={(e) => void apply({ closeToTray: e.target.checked })}
          />
        }
      />
      <SettingsRow
        label="开机自动启动"
        hint="登录系统后自动在后台拉起 nanoWork"
        control={
          <Switch
            checked={desktop.openAtLogin}
            onChange={(e) => void apply({ openAtLogin: e.target.checked })}
          />
        }
      />
      {isMac && (
        <SettingsRow
          label="在 Dock 中显示图标"
          hint="关闭后仅保留菜单栏与托盘入口"
          control={
            <Switch
              checked={desktop.showInDock}
              onChange={(e) => void apply({ showInDock: e.target.checked })}
            />
          }
        />
      )}
    </SettingsCard>
  );
}

/** 通用：外观主题 + 桌面端行为 */
export function GeneralSection() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);

  return (
    <Box>
      <SettingsCard
        title="外观"
        description="选择界面配色模式，「跟随系统」会随操作系统外观自动切换。"
      >
        <SettingsRow
          label="主题"
          hint="主题属布局偏好，持久化在本地设置文件中"
          control={
            <ToggleButtonGroup
              exclusive
              size="small"
              value={normalizeTheme(settings.theme)}
              onChange={(_e, value: Settings['theme'] | null) => {
                if (value) setSettings({ theme: value });
              }}
              aria-label="外观主题"
            >
              <ToggleButton value="light">浅色</ToggleButton>
              <ToggleButton value="dark">深色</ToggleButton>
              <ToggleButton value="system">跟随系统</ToggleButton>
            </ToggleButtonGroup>
          }
        />
      </SettingsCard>

      {/* 桌面端专有：托盘 / 开机自启 / Dock；Web 端整块隐藏 */}
      {platform.env === 'electron' ? (
        <DesktopCard />
      ) : (
        <Typography sx={{ fontSize: 12, color: 'text.secondary', px: 0.5 }}>
          当前运行在 Web 端，托盘常驻、开机自启等桌面端能力不可用。
        </Typography>
      )}
    </Box>
  );
}
