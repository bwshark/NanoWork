import { useCallback, useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { toast } from '@/components/Toast';
import { platform } from '@/platform';
import { formatBytes } from '@/lib/fileArtifact';
import { DEFAULT_LOG_KEEP_DAYS } from '@/observability/logging';
import { DEFAULT_TRACE_KEEP_DAYS } from '@/observability/trace';
import type { DiagnosticsStats } from '@/platform/types';

/**
 * 诊断分区（FR-11.2 / FR-11.3 的出口）。
 *
 * ## 这一页回答三个问题
 *
 * 1. **东西在哪**——日志与 trace 的落点路径（可以直接打开去看，不必先导出）；
 * 2. **有多少**——文件数与体量（体量异常说明保留策略没生效，这是最先该看到的信号）；
 * 3. **怎么带走**——一键打包成 zip，附上应用版本与平台信息。
 *
 * ## 为什么「打开目录」与「导出」并列，而不是只留导出
 *
 * 用户自查（「刚才那轮到底报了什么」）和发给支持是两种场景：前者在自己的机器上，
 * 打开目录用编辑器看最快；后者要一个能发出去的包。只留导出会让自查变成
 * 「先压缩再解压」——多两步，而且中间那个 zip 还得自己删。
 *
 * ## 三种「没有数据」必须分开说（与「用量」分区同一纪律）
 *
 * 还没读（加载中）→ 读不到（Web 端没有本地数据目录）→ 读到了但确实没有记录。
 * 混成一句「暂无数据」会让人分不清「我没跑过」和「这功能坏了」，而这两种情况
 * 该做的下一步完全不同。
 */
export function DiagnosticsSection() {
  const [stats, setStats] = useState<DiagnosticsStats | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [exporting, setExporting] = useState(false);

  const refresh = useCallback(async () => {
    const next = await platform.diagnosticsStats();
    setStats(next);
    setLoaded(true);
  }, []);

  // 每次进分区都重读：体量会变（刚跑完一批任务），拿上次的数字比多读一次
  // 本地目录更难解释。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 打开目录。
   *
   * 目录「还没建出来」时 `openPath` 会失败（今天还没写过任何日志 / trace），
   * 而这恰恰是最常见的情况——**必须把失败说出来**，否则点一下什么都不发生，
   * 看起来像按钮坏了。文案里带上原因，用户才知道该等一条日志出现。
   */
  const openDir = useCallback(async (path: string) => {
    const res = await platform.openPath(path);
    if (!res.ok) toast.error(`打不开目录：${res.error ?? '路径不存在'}`);
  }, []);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const res = await platform.exportDiagnostics();
      // 取消**不是**错误：保存对话框里按 Esc 是最常见的操作，弹一个红 toast
      // 会让人以为导出失败了。
      if (res.canceled) return;
      if (!res.ok) {
        toast.error(`导出诊断包失败：${res.error ?? '未知原因'}`);
        return;
      }
      const skipped = res.skipped ? `，因体积上限略过 ${res.skipped} 个文件` : '';
      toast.success(`已导出诊断包（${formatBytes(res.bytes)}，${res.entryCount} 个文件）${skipped}`);
      await refresh();
    } finally {
      setExporting(false);
    }
  }, [refresh]);

  if (!loaded) {
    return (
      <Box sx={{ py: 1 }}>
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>正在读取诊断信息…</Typography>
        <Box sx={{ mt: 1.5, display: 'flex', justifyContent: 'center' }}>
          <CircularProgress size={20} />
        </Box>
      </Box>
    );
  }

  if (!stats) {
    return (
      <Box sx={{ py: 1 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>当前环境没有本地数据目录</Typography>
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mt: 0.5, lineHeight: 1.7 }}>
          运行日志与全链路 trace 只落在<strong>桌面端</strong>的本地数据目录里——浏览器里
          没有这个目录，也没有保存对话框。用桌面客户端打开时，这里会显示两者各自的落点与
          体量，并提供一键打包。
        </Typography>
      </Box>
    );
  }

  const empty = stats.logFiles === 0 && stats.traceFiles === 0;

  return (
    <>
      <SettingsCard
        title="诊断"
        description="排查问题时把现场一次性带走：日志按模块分文件，trace 按回合记录每一步工具调用"
      >
        <SettingsRow
          label="导出诊断包"
          hint={
            <>
              打包成 zip（内含运行日志、全链路 trace、应用与平台版本）。先保最新：超过 25MB
              会从最旧的开始略过，并在包内如实记下略过的数量。
              <br />
              <strong>不含</strong>提问正文、API Key 与渠道凭据，但工具参数与输出会带上
              ——发送前请自行确认。
            </>
          }
          control={
            <Button
              variant="contained"
              size="small"
              disableElevation
              startIcon={<DownloadOutlinedIcon />}
              disabled={exporting}
              onClick={() => void handleExport()}
            >
              {exporting ? '正在打包…' : '导出…'}
            </Button>
          }
        />

        <SettingsRow
          label="运行日志"
          hint={
            <>
              落点：{stats.logsDir}
              <br />
              {stats.logFiles === 0
                ? '还没有日志文件'
                : `${stats.logFiles} 个文件 · ${formatBytes(stats.logBytes)} · 覆盖 ${stats.logDates.length} 天`}
            </>
          }
          control={
            <Button
              size="small"
              startIcon={<FolderOpenOutlinedIcon />}
              onClick={() => void openDir(stats.logsDir)}
            >
              打开目录
            </Button>
          }
        />

        <SettingsRow
          label="全链路 trace"
          hint={
            <>
              落点：{stats.tracesDir}
              <br />
              {stats.traceFiles === 0
                ? '还没有 trace'
                : `${stats.traceFiles} 份 · ${formatBytes(stats.traceBytes)}`}
            </>
          }
          control={
            <Button
              size="small"
              startIcon={<FolderOpenOutlinedIcon />}
              onClick={() => void openDir(stats.tracesDir)}
            >
              打开目录
            </Button>
          }
        />

        <SettingsRow
          label="自动清理"
          hint={`日志保留 ${DEFAULT_LOG_KEEP_DAYS} 天、trace 保留 ${DEFAULT_TRACE_KEEP_DAYS} 天，启动时与运行中按小时自动清理；要长期留存请先用上面的按钮导出。`}
        />
      </SettingsCard>

      {empty && (
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary', lineHeight: 1.7, px: 0.5 }}>
          还没有任何诊断产物。跑一轮对话之后，trace 会按回合落在上面的目录里；
          日志则在出错、网关启动、同步等事件发生时逐条追加。
        </Typography>
      )}
    </>
  );
}
