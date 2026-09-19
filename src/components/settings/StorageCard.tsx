import { useEffect } from 'react';
import { Box, Button, IconButton, OutlinedInput, Tooltip, Typography } from '@mui/material';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import { SettingsCard } from '@/components/settings/SettingsPrimitives';
import { toast } from '@/components/Toast';
import { platform } from '@/platform';
import { useSettingsStore } from '@/stores/settingsStore';
import { useStorageInfoStore } from '@/stores/storageInfoStore';

/**
 * 字节数 → 人类可读（1024 进制）。
 *
 * 小数位数按**量级**分档而不是固定：`6.62 GB` 需要两位才看得出变化，
 * `300.0 GB` 再多一位纯属噪音。固定两位会让大容量数字长得像精确测量值
 * （`300.00 GB`），固定零位又会让小体积永远显示成 `0 GB`。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} ${units[0]}`;
  return `${value.toFixed(value >= 100 ? 1 : 2)} ${units[unit]}`;
}

/**
 * 占用条的三段配色。
 *
 * 「磁盘可用」刻意用 `action.disabledBackground`（浅灰）而不是 `divider`：
 * 前者在深色主题下是 12% 白、浅色下是 12% 黑，两边都**看得见**；
 * `divider` 在深色下只有 8% 白，画成条会直接糊进卡片底色里。
 */
const SEGMENT_COLOR = {
  cache: 'success.main',
  used: 'text.secondary',
  free: 'action.disabledBackground',
} as const;

/** 图例项：圆点 + 文案，值放 tooltip（参考图右侧只留「已用 / 共」一处数字） */
function LegendItem({
  color,
  label,
  title,
}: {
  color: string;
  label: string;
  title: string;
}) {
  return (
    <Tooltip title={title}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Box
          sx={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            bgcolor: color,
            flexShrink: 0,
          }}
        />
        <Typography sx={{ fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}>
          {label}
        </Typography>
      </Box>
    </Tooltip>
  );
}

/**
 * 设置「通用 → 存储」卡片。
 *
 * 两件事：**系统缓存目录**（在哪儿、占多大、一键打开）与**默认工作空间存储路径**
 * （新建任务落在哪儿、怎么改）。
 *
 * 为什么两块合成一张卡片而不是两张：它们回答的是同一个问题——「我的东西存在哪」。
 * 拆成两张会让「缓存目录」和「工作空间」看起来是两件互不相干的事，而实际上
 * 用户关心的往往是「这个盘要满了该怎么办」，需要一眼同时看到两处。
 *
 * 占用条按参考图分三段（系统缓存 / 磁盘已用 / 磁盘可用）而不是一段：
 * 只画「缓存占磁盘多少」时，绿色几乎永远是 3% 不到的一条细线，看不出任何信息；
 * 加上「已用」这段之后，用户能立刻分辨「是应用吃了盘」还是「盘本来就满」。
 */
export function StorageCard() {
  const info = useStorageInfoStore((s) => s.info);
  const error = useStorageInfoStore((s) => s.error);
  const refresh = useStorageInfoStore((s) => s.refresh);
  const customPath = useSettingsStore((s) => s.settings.defaultWorkspacePath);
  const setSettings = useSettingsStore((s) => s.setSettings);

  // 每次打开卡片都重算一次：缓存体积与剩余空间一直在变，沿用上次的数字
  // 会让「清完缓存回来一看没变」变成一次误导。store 内部对并发做了去重。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const custom = customPath?.trim() ?? '';
  const workspacePath = custom || info?.defaultWorkspaceDir || '';

  const { cacheBytes, disk } = info ?? {
    cacheBytes: 0,
    disk: { totalBytes: 0, usedBytes: 0, freeBytes: 0 },
  };
  const hasDisk = disk.totalBytes > 0;
  // 三段各自占总量的百分比。只有「已用」需要扣掉缓存——缓存本身就落在
  // 「已用」里面，不扣的话两段会重叠，加起来就不是一回事了。
  const cachePct = hasDisk ? Math.min(100, (cacheBytes / disk.totalBytes) * 100) : 0;
  const usedPct = hasDisk
    ? Math.min(100 - cachePct, (Math.max(0, disk.usedBytes - cacheBytes) / disk.totalBytes) * 100)
    : 0;

  const openCacheDir = async () => {
    if (!info) return;
    const result = await platform.openPath(info.cacheDir);
    if (!result.ok) toast.error(result.error ?? '打开目录失败');
  };

  const openWorkspaceDir = async () => {
    if (!workspacePath) return;
    const result = await platform.openPath(workspacePath);
    if (!result.ok) toast.error(result.error ?? '打开目录失败');
  };

  const changeWorkspace = async () => {
    const dir = await platform.pickDirectory();
    if (!dir) return; // 用户取消
    setSettings({ defaultWorkspacePath: dir });
    toast.success('默认工作空间已更新，新建任务将存放在该路径下');
  };

  const resetWorkspace = () => {
    // 传 undefined 而不是空串：让这个键从持久化数据里消失，回到「从未设置过」
    // 的状态。写空串也能跑（读取侧把两者当同义），但存一个空值只是噪音。
    setSettings({ defaultWorkspacePath: undefined });
    toast.success('已恢复为内置默认路径，新建任务将存放在该路径下');
  };

  return (
    <SettingsCard
      title="存储"
      description="对话记录、运行缓存与新建任务的落点都在这台机器上，不上传云端。"
    >
      {/* —— 系统缓存目录 —— */}
      <Box sx={{ py: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}>
              系统缓存目录
            </Typography>
            <Typography
              sx={{
                fontSize: 12.5,
                color: 'text.secondary',
                mt: 0.375,
                lineHeight: 1.65,
                wordBreak: 'break-all',
              }}
            >
              {info ? info.cacheDir : '正在读取…'}
              {info && ' · 存放对话记录、运行缓存与临时文件'}
            </Typography>
            {/* 本项目的应用数据刻意分成两个根（见「数据管理 → 数据落点」）。
                占用条与「打开目录」都以缓存目录为准，那用户资产那半边就永远
                看不见了——补一行说明，比让人以为「记忆和技能不存在磁盘上」好。 */}
            {info && (
              <Typography
                sx={{
                  fontSize: 12,
                  color: 'text.secondary',
                  opacity: 0.85,
                  mt: 0.25,
                  lineHeight: 1.65,
                  wordBreak: 'break-all',
                }}
              >
                用户资产（设置、记忆、技能、插件）另存于 {info.assetsDir}
              </Typography>
            )}
          </Box>
          <Button
            size="small"
            startIcon={<FolderOpenOutlinedIcon fontSize="small" />}
            disabled={!info}
            onClick={() => void openCacheDir()}
            sx={{
              flexShrink: 0,
              textTransform: 'none',
              color: 'text.secondary',
              fontSize: 12.5,
              mt: -0.25,
              '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
            }}
          >
            打开目录
          </Button>
        </Box>

        {/* 占用条：只画「缓存」与「已用」两段，剩下的容器底色天然就是「可用」——
            第三段再用一个 div 去填，等于把「容器还剩多少」这件事说了两遍，
            还会因为百分比四舍五入出现 1px 的缝。 */}
        <Box
          sx={{
            mt: 1.5,
            display: 'flex',
            height: 6,
            borderRadius: 999,
            overflow: 'hidden',
            bgcolor: SEGMENT_COLOR.free,
          }}
          role="img"
          aria-label={
            hasDisk
              ? `磁盘占用：系统缓存 ${formatBytes(cacheBytes)}，已用 ${formatBytes(disk.usedBytes)}，可用 ${formatBytes(disk.freeBytes)}，共 ${formatBytes(disk.totalBytes)}`
              : '磁盘占用：暂不可用'
          }
        >
          <Box sx={{ width: `${cachePct}%`, bgcolor: SEGMENT_COLOR.cache }} />
          <Box sx={{ width: `${usedPct}%`, bgcolor: SEGMENT_COLOR.used }} />
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 1, flexWrap: 'wrap' }}>
          <LegendItem
            color={SEGMENT_COLOR.cache}
            label="系统缓存"
            title={`系统缓存目录占用 ${formatBytes(cacheBytes)}`}
          />
          <LegendItem
            color={SEGMENT_COLOR.used}
            label="磁盘已用"
            title={hasDisk ? `磁盘已用 ${formatBytes(disk.usedBytes)}` : '磁盘信息不可用'}
          />
          <LegendItem
            color={SEGMENT_COLOR.free}
            label="磁盘可用"
            title={hasDisk ? `磁盘可用 ${formatBytes(disk.freeBytes)}` : '磁盘信息不可用'}
          />
          <Box sx={{ flex: 1, minWidth: 8 }} />
          <Typography sx={{ fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}>
            {hasDisk
              ? `已用 ${formatBytes(cacheBytes)} / 共 ${formatBytes(disk.totalBytes)}`
              : error ?? '存储信息不可用'}
          </Typography>
        </Box>
      </Box>

      {/* —— 默认工作空间存储路径 —— */}
      <Box sx={{ py: 2 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}>
          NanoWork 默认工作空间存储路径
        </Typography>
        <Typography
          sx={{ fontSize: 12.5, color: 'text.secondary', mt: 0.375, lineHeight: 1.65 }}
        >
          新建任务、工作空间时将自动存放在该路径下；修改后不影响已有数据。
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.25 }}>
          {/* 只读展示而不是可编辑输入框：这是个**目录路径**，手敲既要处理分隔符、
              又要处理 Windows 保留字符，还得判断目录存不存在。目录选择器天然
              给出一个真实存在的绝对路径，把编辑入口收窄到「选一个」，
              这一整类路径合法性问题就不存在了。 */}
          <OutlinedInput
            readOnly
            size="small"
            fullWidth
            value={custom}
            placeholder={info?.defaultWorkspaceDir ?? '桌面端可用'}
            // aria-label 必须放进 `inputProps`：MUI 的 InputBase 只把认得的
            // 字段透传给 `<input>`，其余（含所有 aria-*）会落到**最外层 div** 上。
            // 挂在 div 上既不是无障碍标注（它没有 role），按标签也查不到输入框。
            inputProps={{ 'aria-label': '默认工作空间存储路径' }}
            sx={{
              bgcolor: 'action.hover',
              fontSize: 12.5,
              '& input': { cursor: 'default', color: custom ? 'text.primary' : 'text.secondary' },
            }}
          />
          <Tooltip title="在文件管理器中打开该路径">
            <span>
              <IconButton
                size="small"
                aria-label="打开默认工作空间目录"
                disabled={!workspacePath}
                onClick={() => void openWorkspaceDir()}
              >
                <FolderOpenOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Button
            size="small"
            variant="outlined"
            onClick={() => void changeWorkspace()}
            sx={{ flexShrink: 0, textTransform: 'none', px: 2 }}
          >
            更改
          </Button>
          {custom && (
            <Tooltip title="恢复为内置默认路径">
              <IconButton
                size="small"
                aria-label="恢复默认工作空间路径"
                onClick={resetWorkspace}
              >
                <RestartAltOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </Box>
    </SettingsCard>
  );
}
