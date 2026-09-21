import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  ListSubheader,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { platform } from '@/platform';
import {
  AUTO_PROVIDER_VALUE,
  CUSTOM_PROVIDER_VALUE,
  MODEL_PROVIDER_GROUP_LABELS,
  findModelProvider,
  groupedModelProviders,
  providerNeedsApiKey,
  slugifyProviderKey,
} from '@/lib/modelProviders';
import type { ManagedModel, ModelFormValue } from '@/stores/modelsStore';
import type { ModelProbeResult } from '@/platform/types';

/** 连接测试超时提示（主进程 10s 中止，这里只负责文案） */
const PROBE_TIMEOUT_HINT = '连接超时（10s）';

/**
 * 添加 / 编辑模型。
 *
 * 三个字段的可见性随「供应商」变，这是本对话框唯一的动态逻辑：
 * - 内置供应商：只要 API Key（地址由引擎注册表自带，留空即默认）；
 * - 自定义 API：还要 API Base 与一个显示名（用来生成 `providers.<slug>` 的键）。
 *
 * **测试连接由主进程发起**：渲染层 fetch 会被 CORS 挡掉，而跨域失败与
 * 「key 无效」在界面上长得一模一样，降级成"看起来连上了"只会误导排查。
 */
export function ModelDialog({
  open,
  editing,
  onClose,
  onSubmit,
}: {
  open: boolean;
  editing?: ManagedModel;
  onClose: () => void;
  onSubmit: (value: ModelFormValue) => Promise<boolean>;
}) {
  const [provider, setProvider] = useState<string>('deepseek');
  const [customName, setCustomName] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [setDefault, setSetDefault] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ModelProbeResult | null>(null);
  const [saving, setSaving] = useState(false);

  const custom = provider === CUSTOM_PROVIDER_VALUE;
  const auto = provider === AUTO_PROVIDER_VALUE;
  const spec = useMemo(() => findModelProvider(provider), [provider]);
  const needsKey = providerNeedsApiKey(provider);

  // 每次打开（或切换到编辑另一条）都重置为这一条的真实值：
  // 对话框是常驻挂载的，不重置的话上一条填的 key 会残留到下一条。
  useEffect(() => {
    if (!open) return;
    if (editing) {
      // 目录里查不到、又不是 auto 的（比如引擎 WebUI 建出来的自定义供应商）
      // 一律按「自定义」呈现，否则下拉框无处可落
      const known = findModelProvider(editing.provider);
      setProvider(
        known
          ? editing.provider
          : editing.provider === AUTO_PROVIDER_VALUE
            ? AUTO_PROVIDER_VALUE
            : CUSTOM_PROVIDER_VALUE,
      );
      setCustomName(known || editing.provider === AUTO_PROVIDER_VALUE ? '' : editing.providerLabel);
      setApiBase(editing.apiBase);
      setApiKey(editing.apiKey);
      setModel(editing.model || editing.name);
      setSetDefault(editing.isDefault);
    } else {
      setProvider('deepseek');
      setCustomName('');
      setApiBase('');
      setApiKey('');
      setModel('');
      setSetDefault(false);
    }
    setProbe(null);
    setProbing(false);
  }, [open, editing]);

  // 改供应商就作废上一次的测试结果：地址与 key 都换了，旧结论没有意义
  useEffect(() => {
    setProbe(null);
  }, [provider, apiBase, apiKey]);

  const canProbe = Boolean(apiBase.trim() || spec?.probe) && (!needsKey || Boolean(apiKey.trim()));

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      const result = await platform.probeModel({
        provider: custom ? slugifyProviderKey(customName || apiBase) : provider,
        apiBase: apiBase.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      setProbe(result);
    } finally {
      setProbing(false);
    }
  };

  const submit = async () => {
    const name = model.trim();
    if (!name) return;
    if (custom && !apiBase.trim()) return;
    setSaving(true);
    try {
      const ok = await onSubmit({
        provider,
        customProviderName: customName,
        apiBase,
        apiKey,
        model: name,
        setDefault,
        original: editing,
      });
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    Boolean(model.trim()) &&
    (!custom || Boolean(apiBase.trim())) &&
    (!needsKey || Boolean(apiKey.trim()));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="xs"
      PaperProps={{ sx: { borderRadius: 2.5 } }}
      aria-label={editing ? '编辑模型' : '添加模型'}
    >
      <DialogTitle sx={{ fontSize: 15, fontWeight: 700, pb: 1 }}>
        {editing ? '编辑模型' : '添加模型'}
      </DialogTitle>
      <DialogContent sx={{ pt: 0.5 }}>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Box>
            <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.75 }}>供应商</Typography>
            <Select
              fullWidth
              size="small"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              MenuProps={{ PaperProps: { sx: { maxHeight: 340 } } }}
            >
              {/* ⚠️ 分组只能展开成**扁平数组**（`flatMap`），不能包 `<Fragment>`：
                  MUI 的 SelectInput 用 `React.Children.toArray` 收子节点，而它**不展开
                  Fragment**——被 clone 上 `onClick` / `value` / `data-value` 的会是那个
                  Fragment 本身，包在里面的 MenuItem 一个都拿不到。现象是「点供应商没反应」，
                  且因为匹配不到选中项，`displaySingle` 为空，框里连当前值都只渲染一个零宽字符
                  （看起来就是个空框）。MUI 自己也会在开发态打印这条告警。 */}
              {groupedModelProviders().flatMap((group) => [
                <ListSubheader
                  key={`${group.group}-label`}
                  sx={{ fontSize: 12 }}
                >
                  {MODEL_PROVIDER_GROUP_LABELS[group.group]}
                </ListSubheader>,
                ...group.items.map((item) => (
                  <MenuItem key={item.name} value={item.name} sx={{ fontSize: 13.5 }}>
                    {item.label}
                  </MenuItem>
                )),
              ])}
              <ListSubheader sx={{ fontSize: 12 }}>其他</ListSubheader>
              <MenuItem value={AUTO_PROVIDER_VALUE} sx={{ fontSize: 13.5 }}>
                自动匹配（按模型名推断供应商）
              </MenuItem>
              <MenuItem value={CUSTOM_PROVIDER_VALUE} sx={{ fontSize: 13.5 }}>
                自定义 API（OpenAI 兼容）
              </MenuItem>
            </Select>
          </Box>

          {custom && (
            <TextField
              label="供应商名称"
              size="small"
              fullWidth
              placeholder="如 我的网关 / TokenHub"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              helperText={`将写入 providers.${slugifyProviderKey(customName || 'custom')}`}
            />
          )}

          <TextField
            label={custom ? 'API Base' : 'API Base（可选）'}
            size="small"
            fullWidth
            required={custom}
            placeholder={
              custom
                ? 'https://api.example.com/v1'
                : auto
                  ? '留空：由引擎按模型名推断'
                  : spec?.apiBase || '留空则使用供应商默认地址'
            }
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
          />

          <TextField
            label={
              auto
                ? 'API Key（可选）'
                : needsKey
                  ? 'API Key'
                  : 'API Key（本地部署可留空）'
            }
            size="small"
            fullWidth
            type="password"
            required={needsKey}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />

          <TextField
            label="模型名称"
            size="small"
            fullWidth
            required
            placeholder="如 deepseek-chat / gpt-4o"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            helperText="同时作为预设名出现对话页的模型选择器里"
          />

          <Box>
            <Button
              variant="outlined"
              size="small"
              disabled={!canProbe || probing}
              onClick={() => void runProbe()}
              startIcon={probing ? <CircularProgress size={14} /> : undefined}
            >
              测试连接
            </Button>
            {probe && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 1 }}>
                {probe.ok ? (
                  <CheckCircleOutlineIcon sx={{ fontSize: 16, color: 'success.main' }} />
                ) : (
                  <ErrorOutlineIcon sx={{ fontSize: 16, color: 'error.main' }} />
                )}
                <Typography
                  sx={{
                    fontSize: 12.5,
                    color: probe.ok ? 'success.main' : 'error.main',
                    wordBreak: 'break-all',
                  }}
                >
                  {probe.ok
                    ? `连接成功${probe.models?.length ? `，可用 ${probe.models.length} 个模型` : ''}（${probe.latencyMs}ms）`
                    : probe.error || PROBE_TIMEOUT_HINT}
                </Typography>
              </Box>
            )}
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Button
              size="small"
              variant={setDefault ? 'contained' : 'text'}
              onClick={() => setSetDefault((v) => !v)}
            >
              {setDefault ? '✓ 保存后设为默认' : '保存后设为默认'}
            </Button>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2.5, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>
          取消
        </Button>
        <Button
          variant="contained"
          disabled={!canSave || saving}
          onClick={() => void submit()}
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}
