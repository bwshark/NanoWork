import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { getChannelMeta } from '@/lib/channel/channelMeta';
import { useChannelsStore } from '@/stores/channelsStore';
import { toast } from '@/components/Toast';
import { platform } from '@/platform';
import { ChannelScanPanel } from '@/components/im/ChannelScanPanel';
import type { ChannelConfig, ChannelKind } from '@/types';
import type { ChannelFieldMeta } from '@/lib/channel/channelMeta';

/**
 * IM 频道配置弹窗。
 * 表单字段由渠道元数据（channelMeta）驱动，必填项校验后写入 channelsStore。
 *
 * 双模式（仅引擎提供 connector 且运行在桌面端时可用）：
 * - 扫码接入（推荐）：渲染 ChannelScanPanel，成功后回读凭证 + 重启网关；
 * - 手动配置：原有表单逻辑。
 * 默认模式：按凭证判定而非配置条目存在性——断开连接后条目保留（策略字段在）
 * 但凭证已清，此时应回到扫码接入；无凭证 → 扫码接入，有凭证（编辑场景）→ 手动配置。
 */

/** 配置弹窗模式 */
type DialogMode = 'scan' | 'manual';

/** 表单内部状态：字符串输入 + 布尔开关 */
interface FormState {
  values: Record<string, string>;
  bools: Record<string, boolean>;
}

/** 从已有配置初始化表单（allowFrom 数组 → 多行文本） */
function initForm(kind: ChannelKind, existing?: ChannelConfig): FormState {
  const meta = getChannelMeta(kind);
  const values: Record<string, string> = {};
  const bools: Record<string, boolean> = {};
  for (const f of meta.fields) {
    if (f.kind === 'bool') {
      bools[f.key] = (existing?.[f.key as keyof ChannelConfig] as boolean | undefined) ?? f.defaultBool ?? false;
      continue;
    }
    if (f.kind === 'list') {
      values[f.key] = (existing?.allowFrom ?? []).join('\n');
      continue;
    }
    if (f.kind === 'enum') {
      values[f.key] =
        (existing?.[f.key as keyof ChannelConfig] as string | undefined) ??
        f.choices?.[0]?.value ??
        '';
      continue;
    }
    values[f.key] = (existing?.[f.key as keyof ChannelConfig] as string | undefined) ?? '';
  }
  return { values, bools };
}

/**
 * 表单 → ChannelConfig 补丁（trim、空行过滤）。
 * allowFrom 留空时归一为 ['*']（放开接入）：nanobot 中空白名单是
 * 「仅配对码」模式——机器人只回配对码、无法正常对话，与表单
 * 「留空表示不限制」的语义不符，故统一兜底为开放接入。
 */
function toPatch(meta: ReturnType<typeof getChannelMeta>, form: FormState): Partial<ChannelConfig> {
  const patch: Partial<ChannelConfig> = {};
  for (const f of meta.fields) {
    const raw = form.values[f.key];
    switch (f.kind) {
      case 'bool':
        (patch as Record<string, unknown>)[f.key] = form.bools[f.key];
        break;
      case 'list': {
        const list = (raw ?? '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        patch.allowFrom = list.length > 0 ? list : ['*'];
        break;
      }
      default:
        (patch as Record<string, unknown>)[f.key] = (raw ?? '').trim();
    }
  }
  return patch;
}

export function ChannelConfigDialog({
  open,
  kind,
  onClose,
}: {
  open: boolean;
  kind: ChannelKind;
  onClose: () => void;
}) {
  const meta = getChannelMeta(kind);
  const existing = useChannelsStore((s) => s.configs.find((c) => c.kind === kind));
  const saveConfig = useChannelsStore((s) => s.saveConfig);
  const refreshFromNanobot = useChannelsStore((s) => s.refreshFromNanobot);
  const vaultAvailable = useChannelsStore((s) => s.vaultAvailable);
  const secretKeys = useChannelsStore((s) => s.secretKeys);

  /**
   * 已存进保险库的密钥字段（值不在渲染层，只能靠 key 名清单判定）。
   *
   * 它们与「明文落 `channels.json`」时代的差别是**表单不再回显值**：重启后本地没有
   * 明文可填，输入框必然是空的。所以留空必须解释为「不修改」——否则用户只想改一下
   * 白名单，却会被必填校验拦下，且除重填密钥外无路可走。
   */
  const vaultedSecretKeys = secretKeys[kind] ?? [];
  const isVaultedSecret = (key: string) => vaultedSecretKeys.includes(key);

  /** 是否支持扫码接入：引擎提供 connector 且运行在桌面端 */
  const scanSupported = Boolean(meta.scanConnect) && platform.env === 'electron';
  /** 引擎支持扫码但当前环境非桌面端：弹窗内显式提示降级，不静默隐藏 */
  const scanUnavailableInEnv = Boolean(meta.scanConnect) && platform.env !== 'electron';

  /**
   * 默认模式判定（初始值与 open 重置两处同步）：按凭证而非条目存在性——
   * 断开后条目保留（策略字段在）但凭证已清，默认应回到扫码接入。
   *
   * 判据必须**纳入保险库**：明文已不落本地，重启后 `cfg.token` / `cfg.appId` 可能为空，
   * 只看配置会把「已配置好」误判成「未配置」→ 默认模式莫名跳回扫码接入。
   */
  const hasCredential =
    vaultedSecretKeys.length > 0 ||
    (kind === 'weixin' ? !!existing?.token : !!existing?.appId);
  const defaultMode: DialogMode = scanSupported && !hasCredential ? 'scan' : 'manual';

  const [form, setForm] = useState<FormState>(() => initForm(kind, existing));
  const [error, setError] = useState('');
  const [mode, setMode] = useState<DialogMode>(defaultMode);
  /** 扫码成功时序幂等保护（一次会话只执行一遍回读 + 重启） */
  const scanDoneRef = useRef(false);

  /** 打开时按当前渠道与已有配置重置表单与模式 */
  useEffect(() => {
    if (open) {
      setForm(initForm(kind, existing));
      setError('');
      // 与初始值同源：按当前凭证状态重算默认模式（见 defaultMode 注释）
      setMode(defaultMode);
      scanDoneRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  /**
   * 扫码成功时序：
   * 1. refreshFromNanobot 回读引擎写入的凭证（飞书 appSecret 只在 config.json，必须回读）；
   * 2. 直接重启网关（nanobot 已写好 config，禁止走 saveConfig/syncAll——
   *    旧片段会覆盖引擎刚写入的凭证）；
   * 3. 按结果 toast，成功后关闭弹窗。
   */
  const handleScanSucceeded = useCallback(() => {
    if (scanDoneRef.current) return;
    scanDoneRef.current = true;
    void (async () => {
      try {
        await refreshFromNanobot(kind);
      } catch {
        // 回读失败不阻断重启：凭证已在引擎侧写入，卡片可下次启动时补齐
      }
      const result = await platform.restartNanobotGateway(meta.scanConnect?.engineChannel);
      if (!result.ok) {
        toast.error(result.message || `${meta.name} 已连接，但网关重启失败，请手动重启`);
        return;
      }
      if (result.needsRestart) {
        // 外部托管：对齐 ImChannelsPage 的 needsRestart 分支（warning 展示结果消息）
        toast.warning(result.message || `${meta.name} 已连接，网关由外部托管，请手动重启后生效`);
      } else {
        toast.success(`${meta.name} 已连接，网关已重启生效`);
      }
      onClose();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, meta.name, refreshFromNanobot, onClose]);

  const inScanMode = scanSupported && mode === 'scan';

  const setValue = (key: string, v: string) =>
    setForm((f) => ({ ...f, values: { ...f.values, [key]: v } }));
  const setBool = (key: string, v: boolean) =>
    setForm((f) => ({ ...f, bools: { ...f.bools, [key]: v } }));

  const handleSave = () => {
    // 必填校验：提示首个缺失字段
    for (const key of meta.requiredKeys) {
      const field = meta.fields.find((f) => f.key === key);
      if ((form.values[key] ?? '').trim()) continue;
      // 保险库里已有该密钥 → 留空表示「沿用已保存的」，不算缺失
      if (field?.kind === 'secret' && isVaultedSecret(key)) continue;
      setError(`请填写${field?.label ?? key}`);
      return;
    }
    saveConfig({ kind, ...toPatch(meta, form) });
    if (platform.env === 'electron' && vaultAvailable === false) {
      // 如实告知：本机没有系统凭据库时凭据不会加密落盘（且重启后需要重填）。
      // 静默成功才是危险的——用户会以为密钥已经安全保存。
      toast.warning(`${meta.name} 配置已保存，但本机没有可用的系统凭据库，凭据未加密保存`);
      onClose();
      return;
    }
    toast.success(`${meta.name} 配置已保存`);
    onClose();
  };

  const rendered = useMemo(() => meta.fields, [meta]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 0.5 }}>配置{meta.name}</DialogTitle>
      <DialogContent>
        {scanUnavailableInEnv && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            扫码接入仅桌面端可用，当前环境请使用手动配置。
          </Alert>
        )}
        {scanSupported && (
          <RadioGroup
            row
            value={mode}
            onChange={(e) => setMode(e.target.value as DialogMode)}
            sx={{ mb: 1.5 }}
          >
            <FormControlLabel
              value="scan"
              control={<Radio size="small" />}
              label="扫码接入（推荐）"
            />
            <FormControlLabel value="manual" control={<Radio size="small" />} label="手动配置" />
          </RadioGroup>
        )}
        {inScanMode ? (
          // 扫码模式：面板自带成功流程；切回手动模式时面板卸载，
          // hook 自动停止轮询并尽力通知远端取消会话。
          <ChannelScanPanel
            key={kind}
            kind={kind}
            onSucceeded={handleScanSucceeded}
            onSwitchToManual={() => setMode('manual')}
            onRestart={() => {
              // 刷新二维码开启新一轮扫码：重置成功时序幂等位，
              // 否则第二次扫码成功时 onSucceeded 永不触发（如重启失败后刷新再扫）
              scanDoneRef.current = false;
            }}
          />
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              在{' '}
              <a href={meta.officialUrl} target="_blank" rel="noreferrer">
                {meta.officialUrl}
              </a>{' '}
              创建机器人后，将凭证填入下方。
            </Typography>
            {meta.setupHint && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mb: 2, lineHeight: 1.7 }}
              >
                {meta.setupHint}
              </Typography>
            )}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {rendered.map((f: ChannelFieldMeta) =>
                renderField(f, form, setValue, setBool, isVaultedSecret),
              )}
            </Box>
            {error && (
              <Typography color="error" sx={{ mt: 1.5, fontSize: 13 }}>
                {error}
              </Typography>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit">
          取消
        </Button>
        {!inScanMode && (
          <Button variant="contained" onClick={handleSave}>
            保存
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

/**
 * 按字段类型渲染单个表单项。
 * @param isVaultedSecret 该字段的密钥是否已存进加密保险库（用于「留空则不修改」提示：
 *   值不回传渲染层，重启后输入框必然是空的，不给提示就成了「看不出来配没配过」）
 */
function renderField(
  f: ChannelFieldMeta,
  form: FormState,
  setValue: (k: string, v: string) => void,
  setBool: (k: string, v: boolean) => void,
  isVaultedSecret: (k: string) => boolean,
) {
  switch (f.kind) {
    case 'bool':
      return (
        <FormControlLabel
          key={f.key}
          control={
            <Switch
              checked={form.bools[f.key] ?? false}
              onChange={(e) => setBool(f.key, e.target.checked)}
            />
          }
          label={f.label}
        />
      );
    case 'enum':
      return (
        <TextField
          key={f.key}
          select
          size="small"
          label={f.label}
          value={form.values[f.key] ?? ''}
          onChange={(e) => setValue(f.key, e.target.value)}
          helperText={f.hint}
        >
          {(f.choices ?? []).map((c) => (
            <MenuItem key={c.value} value={c.value}>
              {c.label}
            </MenuItem>
          ))}
        </TextField>
      );
    case 'list':
      return (
        <TextField
          key={f.key}
          size="small"
          label={f.label}
          placeholder={f.placeholder}
          helperText={f.hint}
          multiline
          minRows={2}
          value={form.values[f.key] ?? ''}
          onChange={(e) => setValue(f.key, e.target.value)}
        />
      );
    default:
      return (
        <TextField
          key={f.key}
          size="small"
          label={f.label}
          placeholder={f.placeholder}
          type={f.kind === 'secret' ? 'password' : 'text'}
          value={form.values[f.key] ?? ''}
          onChange={(e) => setValue(f.key, e.target.value)}
          helperText={
            f.kind === 'secret' && isVaultedSecret(f.key)
              ? '已加密保存，留空则不修改'
              : undefined
          }
        />
      );
  }
}
