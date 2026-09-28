import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/Toast';
import { platform } from '@/platform';
import { DEFAULT_DESKTOP, useSettingsStore } from '@/stores/settingsStore';
import type { DesktopConfig } from '@/types';

/**
 * 桌面端（Electron）行为配置的读写。
 *
 * 抽成 hook 的原因：这份配置有两处消费者，且两处**必须共用同一套主进程同步语义**——
 * 「通用」分区管托盘常驻 / 开机自启 / Dock 显示，「快捷键」分区管全局唤起快捷键。
 * 若各写一份，很容易只在一处实现「注册失败后回退到主进程实际值」，
 * 另一处就会留下「UI 显示 Ctrl+Alt+S 已生效、实际没注册上」的假象。
 *
 * 状态同步要点：渲染层 store 保存的是**用户期望值**，主进程保存的是**实际生效值**。
 * 两者可能不一致（例如快捷键被系统占用注册失败），因此挂载时以主进程回读为准，
 * 每次修改后也用主进程返回值覆盖本地。
 *
 * 桥的有无由 platform 层吸收（Web 端 `getDesktopConfig()` 返回 `null`、
 * `onDesktopConfigChange` 是空订阅），本 hook 不再自己判断环境。
 */
export function useDesktopConfig() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);

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
  // 快捷键也可能因被占用而没注册上。
  // Web 端拿到 null → 保持本地值不动（不能把「读不到」当成「配置为空」）。
  useEffect(() => {
    let alive = true;
    void platform
      .getDesktopConfig()
      .then((cfg) => {
        if (alive && cfg) commit(cfg);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [commit]);

  // 托盘菜单里改了开关 → 同步回 UI。
  // 只更新视图与持久化，绝不回写主进程，否则形成「主进程→渲染层→主进程」回环。
  useEffect(() => platform.onDesktopConfigChange(commit), [commit]);

  /**
   * 应用补丁：本地先更新保证即时反馈，再让主进程生效并回读实际值。
   * @returns 主进程是否确认生效（非 Electron 环境或 IPC 不可用时为 false）
   */
  const apply = useCallback(
    async (patch: Partial<DesktopConfig>): Promise<boolean> => {
      commit({ ...desktop, ...patch });

      const res = await platform.setDesktopConfig(patch).catch(() => null);
      if (!res) return false;
      if (res.ok) {
        setHotkeyError('');
        return true;
      }
      // 快捷键注册失败（被系统或其它应用占用）：提示并回退到主进程实际生效值
      setHotkeyError(res.error ?? '快捷键设置失败');
      toast.error(res.error ?? '快捷键设置失败');
      commit(res.config);
      return false;
    },
    [commit, desktop],
  );

  return { desktop, apply, hotkeyError };
}
