import { useState } from 'react';
import { useEffect } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { SyncStatusIndicator } from '@/components/SyncStatusBadge';
import { toast } from '@/components/Toast';
import { ROUTES } from '@/lib/constants';
import { platform } from '@/platform';
import {
  ARCHIVE_LOCAL_KEYS,
  archiveFileName,
  applyArchive,
  buildArchive,
  parseArchive,
} from '@/lib/accountArchive';
import type { ArchiveWorkspaceMemory } from '@/lib/accountArchive';
import { MemoryService } from '@/lib/memory';
import type { SessionMeta, SessionEvent } from '@/types/event';
import { getEventStore } from '@/events';
import { isEventStreamSession, toMetaFromEntity, useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsUiStore } from '@/stores/settingsUiStore';
import { getSyncRuntime, useSyncStatus } from '@/sync';
import type { AccountSession, CloudExport } from '@/sync';

/**
 * 设置弹窗「账户」分区（批次 4，FR-10）+ 数据主权（批次 6a，FR-10.6）。
 *
 * 账户分区只做三件事：展示登录态（邮箱 / 设备 ID / 上次同步 / 状态徽章）、未登录入口、
 * 登出。**不手调 `engine.stop()`**——登出经 `account.logout()` → `account.subscribe`
 * 已在 runtime 内触发 `engine.stop()` + `resetSyncStatus()`，手调会漏 reset 或重复。
 *
 * 数据主权（批次 6a）：
 * - 「导出全部数据」：组装本地持久化 + 会话（meta + 事件流）+ 云端副本（若已登录）为
 *   自描述归档，写盘到 `~/.nanowork/`（Electron）或浏览器下载（Web）。**未登录仍可点**
 *   ——只导本地段（D1 / D4）。
 * - 「彻底删除账户」：二次确认后调 `account.deleteAccount()`（清云端 + 清本地会话，
 *   但**不删本机业务数据**，D8）。未登录禁用。
 *
 * runtime 一律用 `getSyncRuntime()` 读取（不在这里 `initSyncRuntime`）：App 启动块
 * 已负责初始化单例；设置分区只消费，避免页面一多就各造一份 runtime。
 */

/** ISO 时间 → 本地可读串；无则占位。 */
function formatSyncedAt(iso: string | null): string {
  if (!iso) return '尚未同步';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toLocaleString();
}

  /**
   * 收集**当前工作区**的记忆文件全集（批次 6b）。
   *
   * 读不到（Web 端无文件系统 / 还没有工作区 / 目录为空）一律返回 `null`——导出不该
   * 因为这一段失败，它只是「本机备份」的一部分。
   *
   * 只导**当前**工作区而不是全部已知工作区：归档是「此刻这台机器的状态」的快照，
   * 把历史工作区全塞进来会让导入时的落点变得无法解释。
   */
  async function collectWorkspaceMemory(): Promise<ArchiveWorkspaceMemory | null> {
    try {
      const workdir = MemoryService.resolveWorkspaceDir();
      const names = await MemoryService.listFiles(workdir);
      if (names.length === 0) return null;
      const files: Record<string, string> = {};
      for (const name of names) {
        const text = await MemoryService.readFile(workdir, name);
        if (typeof text === 'string') files[name] = text;
      }
      return Object.keys(files).length > 0 ? { workdir, files } : null;
    } catch {
      return null;
    }
  }

export function AccountSection() {
  const navigate = useNavigate();
  const closeSettings = useSettingsUiStore((s) => s.closeSettings);
  const status = useSyncStatus();
  const runtime = getSyncRuntime();

  const [session, setSession] = useState<AccountSession | null>(
    () => runtime?.account.getSession() ?? null,
  );
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 二次确认对话框（删账户） */
  const [confirmOpen, setConfirmOpen] = useState(false);

  // 账户变更（登录 / 登出 / 轮换）驱动本分区重渲染
  useEffect(() => {
    if (!runtime) return;
    setSession(runtime.account.getSession());
    return runtime.account.subscribe(() => {
      setSession(runtime.account.getSession());
    });
  }, [runtime]);

  // 设备 ID：Web 端 `platform.appInfo()` 恒为 null → 优雅降级为「仅桌面端可见」
  useEffect(() => {
    let cancelled = false;
    void platform
      .appInfo()
      .then((info) => {
        if (!cancelled) setDeviceId(info?.deviceId ?? null);
      })
      .catch(() => {
        if (!cancelled) setDeviceId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 未登录入口：先关弹窗再跳登录页（否则弹窗会压在登录页上）。 */
  const goAuth = (): void => {
    closeSettings();
    navigate(ROUTES.auth);
  };

  const logout = async (): Promise<void> => {
    if (!runtime || busy) return;
    setBusy(true);
    try {
      // 只调 logout：engine.stop() + resetSyncStatus() 由 account.subscribe 触发。
      await runtime.account.logout();
      toast.success('已退出登录');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 导出全部数据（批次 6a，D1）。
   *
   * 组装顺序：本地持久化快照（可枚举的 `ARCHIVE_LOCAL_KEYS`）+ 本机会话
   * （meta 经 `toMetaFromEntity` 派生、事件流按会话从 `getEventStore` 读取）
   * + 云端副本（已登录时 `runtime.client.exportAccount()`，失败降级为 null）。
   *
   * 落盘走既有平台能力 `platform.writeTextFile`：Electron 解析相对路径到
   * `~/.nanowork/`、Web 降级为浏览器下载（D6），无需新增、无需动 `electron/`。
   */
  const exportData = async (): Promise<void> => {
    if (busy || !runtime) return;
    setBusy(true);
    try {
      const local: Record<string, string> = {};
      for (const key of ARCHIVE_LOCAL_KEYS) {
        const raw = await platform.storage.get<string>(key);
        if (typeof raw === 'string' && raw.length > 0) local[key] = raw;
      }

      // 会话 meta + 事件流（本地事实源）
      const sessionsState = useSessionsStore.getState();
      const metas: SessionMeta[] = sessionsState.sessions.map((s) =>
        toMetaFromEntity(s as unknown as Record<string, unknown>),
      );
      const sessionEvents: Record<string, SessionEvent[]> = {};
      for (const s of sessionsState.sessions) {
        if (!isEventStreamSession(s)) continue;
        const shard = s.streamWorkdir ?? s.workdir;
        if (!shard) continue;
        const evs = await getEventStore().readEvents(s.id, shard);
        if (evs.length > 0) sessionEvents[s.id] = evs;
      }

      // 云端副本：已登录才取；失败不阻断本地导出
      let cloud: CloudExport | null = null;
      if (runtime.client && session) {
        try {
          cloud = await runtime.client.exportAccount();
        } catch {
          cloud = null;
        }
      }

      // 工作区记忆（批次 6b，6a 的 D4 已知偏差 #2）：**只进归档、不进跨端同步**——
      // 工作区由路径标识而路径每台机器不同（无跨端身份），且它落在用户项目目录里。
      const workspaceMemory = await collectWorkspaceMemory();

      const archive = buildArchive(
        { local, sessionsMeta: metas, sessionEvents, cloud, workspaceMemory },
        {
          exportedAt: new Date().toISOString(),
          deviceId,
          account: session ? { userId: session.userId, email: session.email } : null,
        },
      );

      await platform.writeTextFile(archiveFileName(new Date()), JSON.stringify(archive, null, 2));
      toast.success(
        session
          ? '已导出本机与云端数据（归档含 API 密钥，请妥善保管）'
          : '已导出本机数据（未登录，仅本机；归档含 API 密钥，请妥善保管）',
      );
    } catch (err) {
      toast.error(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 导入归档（批次 6a 补齐 D7 已知偏差）。
   *
   * 流程：`platform.pickFile()` 弹窗选 .json 并读回内容 → `parseArchive` 校验/解析
   * → `applyArchive` 只写回 `local` 段（逐 key 调 `platform.storage.set`）。**未登录亦可点**
   * ——导入只动本机 `local` 段，不触云端、不回写会话/云端段。
   *
   * 失败分支：
   * - 用户取消（`pickFile` 返 null）：静默返回；
   * - `ArchiveParseError`（非归档 / 版本过高 / 段非法）：友好提示，不让整页崩。
   */
  const importData = async (): Promise<void> => {
    if (busy || !runtime) return;
    setBusy(true);
    try {
      const picked = await platform.pickFile();
      if (!picked) return; // 用户取消或环境不支持

      let arch;
      try {
        arch = parseArchive(picked.content);
      } catch (err) {
        // parseArchive 抛 ArchiveParseError（非归档 / 版本过高 / 段非法）：友好提示，不崩页。
        toast.error(`归档无法解析：${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      const report = await applyArchive(arch, (key, value) =>
        platform.storage.set(key, value),
      );

      // 工作区记忆：写进**本机当前工作区**（D4-3）。归档里的 `workdir` 在另一台机器上
      // 根本不存在，照抄它等于拿一台机器的路径去写另一台机器——与批次 5「拉来的事件流
      // 落接收方自己的分片」同一条结论。
      let wsCount = 0;
      if (arch.workspaceMemory) {
        const workdir = MemoryService.resolveWorkspaceDir();
        for (const [name, content] of Object.entries(arch.workspaceMemory.files)) {
          await MemoryService.writeFile(workdir, name, content);
          wsCount += 1;
        }
      }

      toast.success(
        report.written > 0 || wsCount > 0
          ? `已导入 ${report.written} 项本机数据${wsCount > 0 ? ` + ${wsCount} 个工作区记忆文件` : ''}（重启后生效）`
          : '归档中无可导入的本机数据',
      );
    } catch (err) {
      toast.error(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const requestDelete = (): void => {
    if (!session) return;
    setConfirmOpen(true);
  };

  /**
   * 确认删除账户（批次 6a，D8）。
   *
   * 成功后 `account.deleteAccount()` 内部已走与 `logout()` 相同的本地收口
   * （清会话 + 通知订阅者）；服务端失败时它**抛错且不清本地会话**，这里据此提示，
   * 把「云端还在、本机以为删了」的最坏状态挡在门外。
   */
  const confirmDelete = async (): Promise<void> => {
    if (!runtime) return;
    setConfirmOpen(false);
    setBusy(true);
    try {
      await runtime.account.deleteAccount();
      toast.success('云端账户已删除，本机数据保留');
      closeSettings();
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <SettingsCard
        title="账户与同步"
        description="登录后可跨设备同步你的 Agent、会话与设置；不登录也能使用全部本地功能。"
      >
        {session ? (
          <>
            <SettingsRow
              label="邮箱"
              hint="当前登录账户"
              control={
                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                  {session.email}
                </Typography>
              }
            />
            <SettingsRow
              label="设备 ID"
              hint="本机标识，用于标记同步改动的来源"
              control={
                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                  {deviceId ?? '仅桌面端可见'}
                </Typography>
              }
            />
            <SettingsRow
              label="上次同步"
              hint="最近一次成功同步的时刻"
              control={
                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                  {formatSyncedAt(status.lastSyncedAt)}
                </Typography>
              }
            />
            <SettingsRow label="同步状态" control={<SyncStatusIndicator state={status} />} />
            <SettingsRow
              label="退出登录"
              hint="仅断开本机与云端的同步，本地数据保留"
              control={
                <Button
                  color="error"
                  variant="outlined"
                  disabled={busy}
                  onClick={() => void logout()}
                  sx={{ textTransform: 'none', fontSize: 13 }}
                >
                  退出登录
                </Button>
              }
            />
          </>
        ) : (
          <SettingsRow
            label="登录 / 注册"
            hint="登录后可跨设备同步你的 Agent、会话与设置"
            control={
              <Button
                variant="contained"
                onClick={goAuth}
                sx={{ textTransform: 'none', fontSize: 13 }}
              >
                登录 / 注册
              </Button>
            }
          />
        )}
      </SettingsCard>

      <SettingsCard
        title="数据主权"
        description="导出你在 nanoWork 中的全部数据；或彻底删除云端账户与同步数据。归档含 API 密钥等凭据，请妥善保管。"
      >
        <SettingsRow
          label="导出全部数据"
          hint="导出本地全部数据 + 云端副本（JSON 归档）。未登录时仅导本地数据"
          control={
            <Button
              variant="outlined"
              disabled={busy}
              onClick={() => void exportData()}
              sx={{ textTransform: 'none', fontSize: 13 }}
            >
              导出全部数据
            </Button>
          }
        />
        <SettingsRow
          label="导入归档"
          hint="从 .json 归档恢复本机数据（仅 local 段，未登录也可导入）"
          control={
            <Button
              variant="outlined"
              disabled={busy}
              onClick={() => void importData()}
              sx={{ textTransform: 'none', fontSize: 13 }}
            >
              导入归档
            </Button>
          }
        />
        <SettingsRow
          label="彻底删除账户"
          hint={
            session
              ? '删除云端账户与全部同步数据（不可撤销）；本机数据保留'
              : '未登录无需删除云端账户'
          }
          control={
            <Button
              color="error"
              variant="outlined"
              disabled={busy || !session}
              onClick={requestDelete}
              sx={{ textTransform: 'none', fontSize: 13 }}
            >
              彻底删除账户
            </Button>
          }
        />
      </SettingsCard>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>彻底删除账户？</DialogTitle>
        <DialogContent>
          <DialogContentText>
            此操作将删除云端账户及全部同步数据（Agent、会话、设置等），不可撤销。
            本机业务数据不会被删除。请输入确认以继续。
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} sx={{ textTransform: 'none' }}>
            取消
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void confirmDelete()}
            sx={{ textTransform: 'none' }}
          >
            确认删除
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
