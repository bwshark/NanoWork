import { useCallback, useEffect, useState } from 'react';
import { Box, Switch, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { HotkeyInput } from '@/components/HotkeyInput';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { toast } from '@/components/Toast';
import { platform } from '@/platform';
import {
  DEFAULT_DESKTOP,
  normalizeTheme,
  useSettingsStore,
} from '@/stores/settingsStore';
import type { DesktopConfig, Settings } from '@/types';

/**
 * 桌面端专有设置：系统托盘 / 全局快捷键 / 开机自启。
 * 仅在 Electron 环境渲染（Web 端无托盘与全局快捷键能力，整块隐藏）。
 *
 * 状态同步要点：渲染层 store 保存的是"用户期望值"，主进程保存的是"实际生效值"。
 * 两者可能不一致（例如快捷键被系统占用注册失败），因此挂载时以主进程回读为准，
 * 每次修改后也用主进程返回值覆盖本地，避免出现"UI 显示已生效、实际没生效"的假象。
 */
function DesktopCard() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const isMac = window.electronAPI?.getPlatform() === 'darwin';

  const [desktop, setDesktop] = useState<DesktopConfig>(
    settings.desktop ?? DEFAULT_DESKTOP,
  );
  const [hotkeyError, setHotkeyError] = useState('');

  /** 本地状态与 store 同步写入，保证刷新后仍是同一份配置 */
  const commit = useCallback(
    (next: DesktopConfig) => {
      setDesktop(next);
      setSettings({ desktop: next });
    },
    [setSettings],
  );

  // 挂载时以主进程实际状态为准：开机自启可能被用户在系统设置里改过，
  // 快捷键也可能因被占用而没注册上
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let alive = true;
    void api
      .appGetDesktopConfig()
      .then((cfg) => {
        if (alive) commit(cfg);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [commit]);

  // 托盘菜单里改了开关 → 同步回 UI。
  // 只更新视图与持久化，绝不回写主进程，否则形成"主进程→渲染层→主进程"回环
  useEffect(() => {
    if (!window.electronAPI) return;
    return window.electronAPI.onDesktopConfigChange(commit);
  }, [commit]);

  /** 应用补丁：本地先更新保证即时反馈，再让主进程生效并回读实际值 */
  const apply = async (patch: Partial<DesktopConfig>) => {
    commit({ ...desktop, ...patch });

    const res = await window.electronAPI
      ?.appSetDesktopConfig(patch)
      .catch(() => undefined);
    if (!res) return;
    if (res.ok) {
      setHotkeyError('');
      return;
    }
    // 快捷键注册失败（被系统或其它应用占用）：提示并回退到主进程实际生效值
    setHotkeyError(res.error ?? '快捷键设置失败');
    toast.error(res.error ?? '快捷键设置失败');
    commit(res.config);
  };

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
      <SettingsRow
        label="全局唤起快捷键"
        hint="在任意应用里按下即可呼出主窗口；被系统占用时会提示并回退"
        control={
          <Box sx={{ width: 220 }}>
            <HotkeyInput
              value={desktop.hotkey}
              onChange={(accelerator) => void apply({ hotkey: accelerator })}
              error={hotkeyError}
            />
          </Box>
        }
      />
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

      {/* 桌面端专有：托盘 / 全局快捷键 / 开机自启；Web 端整块隐藏 */}
      {platform.env === 'electron' ? (
        <DesktopCard />
      ) : (
        <Typography sx={{ fontSize: 12, color: 'text.secondary', px: 0.5 }}>
          当前运行在 Web 端，托盘常驻、开机自启、全局快捷键等桌面端能力不可用。
        </Typography>
      )}
    </Box>
  );
}
