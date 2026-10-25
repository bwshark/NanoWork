import { useEffect, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { EngineSelfCheckCard } from '@/components/settings/sections/EngineSelfCheckCard';
import { UpdateCard } from '@/components/settings/sections/UpdateCard';
import { toast } from '@/components/Toast';
import { APP_DISPLAY_NAME, APP_DISPLAY_SUB, APP_NAME, APP_VERSION } from '@/lib/core/constants';
import { platform } from '@/platform';
import type { AppInfo } from '@/platform/types';

/**
 * 关于：应用标识 + 运行环境。
 *
 * 版本号的取法分两层：桌面端以**主进程** `app.getVersion()` 为准（那是打包产物的
 * 真实版本），Web 端没有主进程，退回 `APP_VERSION` 常量。两边都拿不到时宁可显示
 * 「未知」也不编一个——版本号是用来对报错日志的，编错比空着更坏。
 *
 * ⚠️ `TitleBar` 里有一个**同源的关于弹窗**（托盘菜单「关于」唤起），两者都读
 * `appGetInfo` 这一个 IPC，因此数据不会分叉；差别只是呈现（那边是窄弹窗的等宽
 * 信息表，这边是设置卡片）。真要收敛成一处，应把信息表抽成共用组件——现在还没做，
 * 因为两边的排版诉求本来就不同。
 */
export function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let alive = true;
    void platform
      .appInfo()
      .then((next) => {
        if (alive) setInfo(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const version =
    info?.version ?? (platform.env === 'electron' ? '未知' : APP_VERSION);
  const runtime = info
    ? `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`
    : '浏览器 Web 端';

  const copyInfo = async () => {
    const lines = [
      `${APP_NAME} ${version}`,
      `平台：${platform.env === 'electron' ? '桌面端' : 'Web 端'}`,
      `运行时：${runtime}`,
      info ? `系统：${info.platform} ${info.osVersion} (${info.arch})` : '',
      info?.deviceId ? `设备 ID：${info.deviceId}` : '',
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success('环境信息已复制');
    } catch {
      toast.error('复制失败，请手动选择文本');
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 0.5, pb: 2 }}>
        <Box
          sx={{
            width: 48,
            height: 48,
            borderRadius: 2,
            bgcolor: 'action.hover',
            display: 'grid',
            placeItems: 'center',
            fontSize: 20,
            fontWeight: 700,
            color: 'text.primary',
          }}
        >
          N
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 15, fontWeight: 700 }}>
            {APP_DISPLAY_NAME}{' '}
            <Box component="span" sx={{ fontWeight: 400, color: 'text.secondary' }}>
              {APP_DISPLAY_SUB}
            </Box>
          </Typography>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.25 }}>
            版本 {version}
          </Typography>
        </Box>
      </Box>

      <SettingsCard title="运行环境">
        <SettingsRow label="运行形态" hint={runtime} />
        <SettingsRow
          label="系统"
          hint={
            info
              ? `${info.platform} ${info.osVersion} · ${info.arch}`
              : '由浏览器提供，桌面端可查看更完整的系统信息'
          }
        />
        <SettingsRow
          label="设备 ID"
          hint={info?.deviceId ?? '仅桌面端可见，用于本地设备识别与后续同步'}
        />
      </SettingsCard>

      {/* 引擎自检（FR-13.6）：放在「运行环境」之后 —— 上面说「你是什么环境」，
          这里说「这个环境的引擎到底能不能跑」，两件事挨着看最顺。 */}
      <EngineSelfCheckCard />

      {/* 自动更新（B4-01）：紧邻自检卡。两者是同一类问题——「这个安装到底能不能
          长期用下去」：自检管现在能不能跑，更新管以后怎么升上去。 */}
      <UpdateCard />

      <SettingsCard
        title="说明"
        description="nanoWork 是本地优先的智能体工作台：会话、记忆、身份文件与插件都落在本机，模型经由 nanobot 网关访问。"
      >
        <SettingsRow
          label="引擎"
          hint="由 nanobot 提供 OpenAI 兼容网关；引擎不可用时界面会进入离线态，不影响查看历史会话"
        />
        <SettingsRow
          label="环境信息"
          hint="报错时把这段信息一并附上，能省掉一轮「你是什么版本」的往返"
          control={
            <Button variant="outlined" onClick={() => void copyInfo()}>
              复制环境信息
            </Button>
          }
        />
      </SettingsCard>
    </Box>
  );
}
