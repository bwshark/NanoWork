import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { useExtensionsStore } from '@/stores/extensionsStore';
import { useSettingsUiStore, SETTINGS_SECTION_IDS } from '@/stores/settingsUiStore';
import { SETTINGS_NAV_ITEMS } from '@/components/settings/settingsNav';
import { ROUTES } from '@/lib/core/constants';
import { platform } from '@/platform';
import type { ExtensionSettingsEntry, InstalledExtension } from '@/types/extension';

/**
 * 扩展挂到设置页的条目（`extension.json` 的 `ui.settings`）。
 *
 * ## 两种呈现，一个数据源
 *
 * - `ExtensionSettingLinks`：**内嵌**在每个设置分区底部，只显示 `target` 命中当前分区的条目。
 *   这是为了贴近 WorkBuddy 的行为——扩展说"我要挂在数据管理里"，它就出现在数据管理里；
 * - `ExtensionsSection`：设置页的「扩展」分区，列出**全部**条目（含 target 对不上的）。
 *
 * 为什么必须有两个：本项目分区 id 与 WorkBuddy 不同名（扩展照原样写
 * `dataManagement` 在本项目不存在）。只做内嵌的话，那些条目会**永远看不到**，
 * 而用户以为"扩展的设置在哪儿都没出现"——那正是最难查的一类静默失败。
 *
 * ## 点开做什么
 *
 * 扩展的设置界面在扩展自己的 iframe 里（同一个 `ui.entry`），所以这里不弹二次弹窗
 * （设置弹窗上再叠一个弹窗，关起来会连环），而是**关掉设置并跳到扩展页**，
 * 由用户点「打开」。多一步，但不会出现"关了里层外层也没了"的困惑。
 */

/** 一条扩展设置项 + 它的来源扩展 */
interface SettingLink {
  extension: InstalledExtension;
  entry: ExtensionSettingsEntry;
}

/** 收集全部扩展设置项（按扩展扫描顺序，保持稳定） */
function collectSettingLinks(extensions: readonly InstalledExtension[]): SettingLink[] {
  const links: SettingLink[] = [];
  for (const extension of extensions) {
    for (const entry of extension.manifest.ui?.settings ?? []) {
      links.push({ extension, entry });
    }
  }
  return links;
}

/** target 是否是本应用认识的分区 */
function isKnownTarget(target: string): boolean {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(target);
}

function targetLabel(target: string): string {
  if (isKnownTarget(target)) {
    return SETTINGS_NAV_ITEMS[target as keyof typeof SETTINGS_NAV_ITEMS]?.label ?? target;
  }
  return `${target}（本应用无此分区）`;
}

/** 共享的「用扩展设置」动作 + 一行渲染 */
function useOpenExtension() {
  const navigate = useNavigate();
  const closeSettings = useSettingsUiStore((s) => s.closeSettings);
  return (extensionId: string) => {
    closeSettings();
    navigate(`${ROUTES.extensions}?focus=${encodeURIComponent(extensionId)}`);
  };
}

function LinkRows({ links }: { links: SettingLink[] }) {
  const openExtension = useOpenExtension();
  return (
    <>
      {links.map(({ extension, entry }) => (
        <SettingsRow
          key={`${extension.manifest.id}/${entry.id}`}
          label={entry.label}
          hint={`来自扩展「${extension.manifest.name}」${
            isKnownTarget(entry.target) ? '' : `，声明挂到 ${targetLabel(entry.target)}`
          }`}
          control={
            <Button
              size="small"
              endIcon={<OpenInNewIcon sx={{ fontSize: 15 }} />}
              onClick={() => openExtension(extension.manifest.id)}
              sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}
            >
              打开扩展
            </Button>
          }
        />
      ))}
    </>
  );
}

/**
 * 内嵌在某个设置分区底部的扩展条目。
 *
 * 没有条目时返回 `null`（不留空卡片、不留空行）——绝大多数分区不会有扩展挂进来。
 */
export function ExtensionSettingLinks({ target }: { target: string }) {
  const extensions = useExtensionsStore((s) => s.extensions);
  const ensureLoaded = useExtensionsStore((s) => s.ensureLoaded);
  const isElectron = platform.env === 'electron';

  useEffect(() => {
    if (!isElectron) return;
    void ensureLoaded();
  }, [ensureLoaded, isElectron]);

  const links = useMemo(
    () => collectSettingLinks(extensions).filter((link) => link.entry.target === target),
    [extensions, target],
  );

  if (!isElectron || links.length === 0) return null;

  return (
    <SettingsCard title="来自扩展" description="下面这些设置项由已安装的扩展声明。">
      <LinkRows links={links} />
    </SettingsCard>
  );
}

/** 设置页「扩展」分区：全部扩展设置项的汇总 */
export function ExtensionsSection() {
  const extensions = useExtensionsStore((s) => s.extensions);
  const error = useExtensionsStore((s) => s.error);
  const ensureLoaded = useExtensionsStore((s) => s.ensureLoaded);
  const isElectron = platform.env === 'electron';

  useEffect(() => {
    if (!isElectron) return;
    void ensureLoaded();
  }, [ensureLoaded, isElectron]);

  const links = useMemo(() => collectSettingLinks(extensions), [extensions]);

  if (!isElectron) {
    return (
      <SettingsCard title="扩展设置项">
        <Typography sx={{ fontSize: 13, color: 'text.secondary', py: 2 }}>
          {error ?? '扩展仅在桌面端可用。'}
        </Typography>
      </SettingsCard>
    );
  }

  if (links.length === 0) {
    return (
      <SettingsCard title="扩展设置项" description="扩展可以把设置项挂到这里，也可以挂到其它分区。">
        <Typography sx={{ fontSize: 13, color: 'text.secondary', py: 2 }}>
          还没有扩展声明设置项。把扩展放进 <code>~/.nanowork/extensions</code> 后回来即会显示。
        </Typography>
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary', pb: 2 }}>
          扩展本身的管理（打开界面 / 启动服务）在侧边栏「能力扩展 → 扩展」。
        </Typography>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard title="扩展设置项" description="全部扩展声明的设置项；能在对应分区显示的会同时出现在那里。">
      <LinkRows links={links} />
    </SettingsCard>
  );
}
