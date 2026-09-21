import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  FormControlLabel,
  IconButton,
  InputAdornment,
  ListSubheader,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import CloseIcon from '@mui/icons-material/Close';
import DiamondOutlinedIcon from '@mui/icons-material/DiamondOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { platform } from '@/platform';
import {
  AUTO_PROVIDER_VALUE,
  CUSTOM_PROVIDER_VALUE,
  MODEL_PROVIDER_GROUP_LABELS,
  findModelProvider,
  groupedModelProviders,
  providerDocsUrl,
  providerModelOptions,
  providerMonogram,
  providerNeedsApiKey,
  providerOptionLabel,
  slugifyProviderKey,
} from '@/lib/modelProviders';
import {
  CONTEXT_WINDOW_OPTIONS,
  DEFAULT_REASONING_EFFORT,
  MAX_TOKENS_OPTIONS,
  TOKEN_DEFAULT_LABEL,
  formatTokenLimit,
  parseTokenLimitInput,
} from '@/lib/modelOptions';
import {
  capabilityRowSx,
  checkLabelSx,
  checkRowSx,
  denseFieldSx,
  fieldActionSx,
  fieldAdornmentSx,
  fieldHintSx,
  fieldLabelRowSx,
  fieldLabelSx,
  modelDialogBodySx,
  modelDialogFootSx,
  modelDialogHeadSx,
  modelDialogPaperSx,
  providerBadgeSx,
  sectionLabelSx,
  tokenChipRowSx,
  tokenGridSx,
  tokenOptionSx,
} from '@/components/settings/modelDialogSx';
import type { ManagedModel, ModelFormValue } from '@/stores/modelsStore';
import type { ModelProbeResult } from '@/platform/types';

/** 连接测试超时提示（主进程 10s 中止，这里只负责文案） */
const PROBE_TIMEOUT_HINT = '连接超时（10s）';

/** 「供应商」标签行里的固定说明——这一页只支持 OpenAI 兼容协议（对齐参考图） */
const PROVIDER_HINT = '（仅支持 OpenAI 兼容协议 API）';

/**
 * 添加 / 编辑模型。
 *
 * 三段式外壳：头部（标题 + 关闭）钉住 / 正文唯一可滚 / 底部按钮钉住——见 `modelDialogSx`。
 * 字段**标签在控件上方**并占满整行，一个字段一个问题，不再靠输入框内的浮标签兼作占位符。
 *
 * 版式按参考图分「两种情况」，由「供应商」这一个下拉决定（它是本对话框唯一的顶层分支）：
 *
 * | | 内置供应商（官方 / 网关 / 本地） | 完全自定义 |
 * |---|---|---|
 * | 接口地址 | —（用注册表默认值） | **必填**，就是这条预设要打的端点 |
 * | 模型名称 | 下拉（内置常用清单 + 测试连接结果），可自由输入 | 手填，如 `gpt-4o` |
 * | 高级配置 | — | 能力声明 + 上下文窗口 / 单次输出 |
 *
 * 「自动匹配」是第三种边缘形态（不指向任何 provider，由引擎按模型名反查）：它只需要
 * 一个模型名与一个可选的接口地址，因此与自定义共用输入框、但不显示高级配置。
 *
 * **API Key 一律选填**：密钥还可能来自引擎侧已配置的值或环境变量
 * （`<PROVIDER>_API_KEY`），本地部署与内网网关则根本不需要。界面拦着不让保存，
 * 只会逼用户随手编一个假凭据写进 config.json，日后排查时误判成「key 填错了」。
 * 「测试连接」同样不要求填：留空时主进程会回退到引擎 config.json 里该供应商
 * 已配置的密钥，与「留空则沿用引擎侧密钥」这句说明保持一致。
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
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState('');
  /**
   * 两个 token 上限的**原始输入文本**（不是数字）。
   *
   * 空串 = 使用提供商默认值（占位符写着这句话），所以这一对字段必须是文本态：
   * 存成 `number | null` 就没法表达「用户正在敲 `128`，还没敲完」。数字在提交时才
   * 解析（`parseTokenLimitInput`），非法输入由 `canSave` 拦下——静默当成"使用默认"
   * 等于把用户写的东西吞掉。
   */
  const [contextText, setContextText] = useState('');
  const [maxText, setMaxText] = useState('');
  /** 思考强度；`null` = 关闭思考模式（提交时写 `null`，引擎不注入 reasoning_effort） */
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [supportsTools, setSupportsTools] = useState(true);
  const [supportsVision, setSupportsVision] = useState(false);
  const [customProtocol, setCustomProtocol] = useState(false);
  const [setDefault, setSetDefault] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ModelProbeResult | null>(null);
  const [saving, setSaving] = useState(false);

  const custom = provider === CUSTOM_PROVIDER_VALUE;
  const auto = provider === AUTO_PROVIDER_VALUE;
  const spec = useMemo(() => findModelProvider(provider), [provider]);
  const needsKey = providerNeedsApiKey(provider);
  const docsUrl = providerDocsUrl(provider);
  /** 内置供应商才有「模型名称」下拉；`auto` 与自定义都只能手填 */
  const pickModel = Boolean(spec);
  const title = editing ? '编辑模型' : '添加模型';

  /** 全部 token 数，与两个文本框同步（`null` = 使用提供商默认值） */
  const contextTokens = parseTokenLimitInput(contextText);
  const maxTokens = parseTokenLimitInput(maxText);

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
      // ⚠️ 回填走 `formatTokenLimit` 而不是 `String(数字)`：同一个值在**档位**与**输入框**
      // 里必须是同一段文字，否则「引擎侧存的 262144」对着档位上的 `256K`，用户认不出
      // 现在生效的就是那一个（以为自己的设置在别处）。1024 的整数倍写成 `256K`，
      // 其余的写成带千分位的原数——`parseTokenLimitInput` 会把逗号吃掉，往返无损。
      setContextText(
        editing.contextWindowTokens ? formatTokenLimit(editing.contextWindowTokens) : '',
      );
      setMaxText(editing.maxTokens ? formatTokenLimit(editing.maxTokens) : '');
      setReasoning(editing.reasoningEffort);
      setSupportsTools(editing.supportsTools);
      setSupportsVision(editing.supportsVision);
      setCustomProtocol(editing.customProtocol);
      setSetDefault(editing.isDefault);
    } else {
      setProvider('deepseek');
      setCustomName('');
      setApiBase('');
      setApiKey('');
      setModel('');
      setContextText('');
      setMaxText('');
      setReasoning(null);
      setSupportsTools(true);
      setSupportsVision(false);
      setCustomProtocol(false);
      setSetDefault(false);
    }
    setShowKey(false);
    setProbe(null);
    setProbing(false);
  }, [open, editing]);

  // 改供应商就作废上一次的测试结果：地址与 key 都换了，旧结论没有意义
  useEffect(() => {
    setProbe(null);
  }, [provider, apiBase, apiKey]);

  // 测试连接不要求填 key：本地部署 / 内网网关 / 走环境变量的场景本来就无 key 可填
  const canProbe = Boolean(apiBase.trim() || spec?.probe);

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

  /**
   * 「模型名称」下拉的候选。
   *
   * 探测结果排在**最前**：它是这个端点此刻真实提供的清单；内置常用清单只是起点
   * （上游发版很快，那份数据注定会过时）。编辑中还要带上当前值——不然打开一条用的是
   * 冷门模型的预设时，框里是个不在候选列表里的字符串，看着像"填错了"。
   */
  const modelOptions = useMemo(
    () =>
      providerModelOptions(provider, [
        ...(probe?.ok ? (probe.models ?? []) : []),
        ...(model ? [model] : []),
      ]),
    [provider, probe, model],
  );

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
        contextWindowTokens: contextTokens.value,
        maxTokens: maxTokens.value,
        reasoningEffort: reasoning,
        supportsTools,
        supportsVision,
        customProtocol,
        setDefault,
        original: editing,
      });
      if (ok) onClose();
    } finally {
      setSaving(false);
    }
  };

  // 必填只有三处：模型名（预设名就是它，空名会让这一行在下拉里彻底消失）、
  // 自定义供应商的接口地址（没有它就没有可打的端点）、以及两个 token 框的**格式**。
  // API Key 不在此列。
  const canSave =
    Boolean(model.trim()) &&
    (!custom || Boolean(apiBase.trim())) &&
    !contextTokens.invalid &&
    !maxTokens.invalid;

  const openDocs = () => {
    if (docsUrl) void platform.openUrl(docsUrl);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      PaperProps={{ sx: modelDialogPaperSx }}
      aria-label={title}
    >
      <Box sx={modelDialogHeadSx}>
        <Typography sx={{ fontSize: 15, fontWeight: 700 }}>{title}</Typography>
        <IconButton size="small" aria-label="关闭" disabled={saving} onClick={onClose}>
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>

      <Box sx={modelDialogBodySx}>
        <Stack spacing={1.25}>
          <Field
            label="供应商"
            hint={PROVIDER_HINT}
            action={
              docsUrl ? (
                <Button
                  size="small"
                  disableRipple
                  sx={fieldActionSx}
                  onClick={openDocs}
                  endIcon={<OpenInNewIcon sx={{ fontSize: 13 }} />}
                >
                  查看文档
                </Button>
              ) : undefined
            }
          >
            <Select
              fullWidth
              size="small"
              sx={denseFieldSx}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              inputProps={{ 'aria-label': '供应商' }}
              renderValue={(value) => (
                <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                  <ProviderBadge provider={value} />
                  {providerOptionLabel(value)}
                </Box>
              )}
              MenuProps={{ PaperProps: { sx: { maxHeight: 340 } } }}
            >
              {/* ⚠️ 分组只能展开成**扁平数组**（`flatMap`），不能包 `<Fragment>`：
                  MUI 的 SelectInput 用 `React.Children.toArray` 收子节点，而它**不展开
                  Fragment**——被 clone 上 `onClick` / `value` / `data-value` 的会是那个
                  Fragment 本身，包在里面的 MenuItem 一个都拿不到。现象是「点供应商没反应」，
                  且因为匹配不到选中项，`displaySingle` 为空，框里连当前值都只渲染一个零宽字符
                  （看起来就是个空框）。MUI 自己也会在开发态打印这条告警。 */}
              {groupedModelProviders().flatMap((group) => [
                <ListSubheader key={`${group.group}-label`} sx={{ fontSize: 12 }}>
                  {MODEL_PROVIDER_GROUP_LABELS[group.group]}
                </ListSubheader>,
                ...group.items.map((item) => (
                  <MenuItem key={item.name} value={item.name} sx={{ fontSize: 13.5 }}>
                    <ProviderBadge provider={item.name} />
                    {item.label}
                  </MenuItem>
                )),
              ])}
              <ListSubheader sx={{ fontSize: 12 }}>其他</ListSubheader>
              <MenuItem value={AUTO_PROVIDER_VALUE} sx={{ fontSize: 13.5 }}>
                <ProviderBadge provider={AUTO_PROVIDER_VALUE} />
                自动匹配（按模型名推断供应商）
              </MenuItem>
              <MenuItem value={CUSTOM_PROVIDER_VALUE} sx={{ fontSize: 13.5 }}>
                <ProviderBadge provider={CUSTOM_PROVIDER_VALUE} />
                {providerOptionLabel(CUSTOM_PROVIDER_VALUE)}
              </MenuItem>
            </Select>
          </Field>

          {custom && (
            <Field label="接口地址">
              <TextField
                sx={denseFieldSx}
                fullWidth
                size="small"
                placeholder="https://api.example.com/v1/chat/completions"
                inputProps={{ 'aria-label': '接口地址' }}
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
              />
            </Field>
          )}

          {custom && (
            <Field
              label="供应商名称"
              hint={`选填；用作 providers 里的键（${slugifyProviderKey(customName || 'custom')}）`}
            >
              <TextField
                sx={denseFieldSx}
                fullWidth
                size="small"
                placeholder="如 我的网关 / TokenHub"
                inputProps={{ 'aria-label': '供应商名称' }}
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
              />
            </Field>
          )}

          {auto && (
            <Field label="接口地址（可选）" hint="留空：由引擎按模型名推断供应商">
              <TextField
                sx={denseFieldSx}
                fullWidth
                size="small"
                placeholder="留空则使用供应商默认地址"
                inputProps={{ 'aria-label': '接口地址' }}
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
              />
            </Field>
          )}

          {/* API Key 与「测试连接」同排：测的就是这一对，分开摆会让人以为按钮测的是整个表单 */}
          <Field
            label="API Key"
            hint={
              needsKey
                ? '选填；留空则沿用引擎侧已配置的密钥'
                : '本地部署通常无需密钥，可留空'
            }
            status={probe ? <ProbeStatus result={probe} /> : undefined}
          >
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField
                sx={[denseFieldSx, { flex: 1, minWidth: 0 }]}
                size="small"
                fullWidth
                type={showKey ? 'text' : 'password'}
                placeholder="输入你的 API Key"
                inputProps={{ 'aria-label': 'API Key' }}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        size="small"
                        sx={fieldAdornmentSx}
                        aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                        onClick={() => setShowKey((prev) => !prev)}
                      >
                        {showKey ? (
                          <VisibilityOffIcon sx={{ fontSize: 16 }} />
                        ) : (
                          <VisibilityIcon sx={{ fontSize: 16 }} />
                        )}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <Button
                sx={{ flexShrink: 0 }}
                variant="outlined"
                size="small"
                disabled={!canProbe || probing}
                onClick={() => void runProbe()}
                startIcon={probing ? <CircularProgress size={14} /> : undefined}
              >
                测试连接
              </Button>
            </Box>
          </Field>

          <Field
            label="模型名称"
            hint={pickModel ? '即预设名，出现在对话页的模型选择器里' : undefined}
          >
            {pickModel ? (
              // freeSolo：候选来自探测结果与内置常用清单，但**必须能自由输入**——
              // 上游随时会出一个我们没收录的模型名，拦住它只会让用户建不出预设。
              //
              // ⚠️ `forcePopupIcon` 不能省：MUI 的默认值是 `'auto'`，而 `'auto'` 在
              // **freeSolo 下等于「不显示箭头」**（`hasPopupIcon = !freeSolo || …`）——
              // 于是这个框看着就是个普通输入框，没人知道它有候选可挑。给候选为空时
              // 也要显示：展开后的 `noOptionsText` 正是「怎么拿到候选」的说明。
              <Autocomplete
                freeSolo
                forcePopupIcon
                size="small"
                sx={denseFieldSx}
                options={modelOptions}
                value={model}
                inputValue={model}
                onInputChange={(_event, value, reason) => {
                  // `reset` 是 Autocomplete 自己在失焦/选中后回写输入框，不采纳它
                  if (reason !== 'reset') setModel(value);
                }}
                noOptionsText="没有候选模型：点「测试连接」获取，或直接输入模型名"
                renderInput={(params) => (
                  <TextField
                    {...params}
                    size="small"
                    placeholder="选择或输入模型名"
                    inputProps={{ ...params.inputProps, 'aria-label': '模型名称' }}
                  />
                )}
              />
            ) : (
              <TextField
                sx={denseFieldSx}
                fullWidth
                size="small"
                required
                placeholder="输入模型参数值，例如 gpt-4o 或 openai/gpt-4o"
                inputProps={{ 'aria-label': '模型名称' }}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            )}
          </Field>

          {custom && (
            <Box>
              <Typography sx={sectionLabelSx}>高级配置</Typography>
              <Box sx={capabilityRowSx}>
                <CapabilityCheck
                  label="工具调用"
                  checked={supportsTools}
                  onChange={setSupportsTools}
                />
                <CapabilityCheck
                  label="图片输入"
                  checked={supportsVision}
                  onChange={setSupportsVision}
                />
                <CapabilityCheck
                  label="思考模式"
                  checked={reasoning !== null}
                  // 开启时沿用原预设的档位（用户在引擎 WebUI 里设过 high 就别压成 medium），
                  // 没有才落到默认档；关闭即写 null（不注入，跟随供应商默认）
                  onChange={(next) =>
                    setReasoning(
                      next ? (editing?.reasoningEffort ?? DEFAULT_REASONING_EFFORT) : null,
                    )
                  }
                />
                <CapabilityCheck
                  label="自定义协议"
                  checked={customProtocol}
                  onChange={setCustomProtocol}
                />
              </Box>
              {/* 输入 / 输出各占一列：两者都是「token 上限」，并排才看得出窗口与输出的比例关系 */}
              <Box sx={[tokenGridSx, { mt: 1 }]}>
                <TokenLimitField
                  title="输入"
                  ariaLabel="上下文窗口"
                  text={contextText}
                  options={CONTEXT_WINDOW_OPTIONS}
                  invalid={contextTokens.invalid}
                  onChange={setContextText}
                />
                <TokenLimitField
                  title="输出"
                  ariaLabel="单次最大输出"
                  text={maxText}
                  options={MAX_TOKENS_OPTIONS}
                  invalid={maxTokens.invalid}
                  onChange={setMaxText}
                />
              </Box>
            </Box>
          )}
        </Stack>
      </Box>

      <Box sx={modelDialogFootSx}>
        <FormControlLabel
          sx={checkRowSx}
          control={
            <Checkbox
              size="small"
              sx={{ p: 0.5 }}
              checked={setDefault}
              onChange={(e) => setSetDefault(e.target.checked)}
              inputProps={{ 'aria-label': '保存后设为默认' }}
            />
          }
          label={<Typography sx={checkLabelSx}>保存后设为默认</Typography>}
        />
        <Box sx={{ display: 'flex', gap: 1 }}>
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
        </Box>
      </Box>
    </Dialog>
  );
}

/**
 * 供应商字标：目录里查得到的取展示名首字（`K` / `阿`），自定义走菱形图标
 * （对齐参考图里那个「◇ 自定义」）。
 *
 * `data-provider-badge` 是给测试用的锚点：字标与标签同在一个节点里，断言回显文案时
 * 得能把它摘掉，否则「OpenAI」的读数是「OOpenAI」（每个用例都要自己拼一遍前缀）。
 */
function ProviderBadge({ provider }: { provider: string }) {
  const custom = provider === CUSTOM_PROVIDER_VALUE;
  return (
    <Box sx={providerBadgeSx} data-provider-badge="" aria-hidden>
      {custom ? (
        <DiamondOutlinedIcon sx={{ fontSize: 12 }} />
      ) : (
        providerMonogram(providerOptionLabel(provider))
      )}
    </Box>
  );
}

/**
 * 字段外壳：标签在控件**上方**，说明接在标签后面、与标签同一行。
 *
 * 说明放控件下方也能读（「这个值会写到哪 / 从哪来」贴着控件更像注解），但那样
 * 每个字段要占两行——六项字段就是六行，足以把弹窗压出滚动条。放到标签行里
 * 「标签 · 说明」同样成立，且一行装不下时 `flexWrap` 会自己折回去。
 *
 * `action` 是这一行的行尾动作（如「查看文档」），顶到最右：它不属于任何字段，
 * 但和这个字段的说明是同一层信息（「这个供应商怎么接」），所以共用一个标签行。
 *
 * `status` 是「控件本身的临时反馈」（如测试连接结果），插在控件与说明之间：
 * 它是这一刻的结果、要贴着控件读，但**不占说明的位置**——说明讲的是这个字段
 * 长期的含义，不该因为一次探测就消失。
 */
function Field({
  label,
  hint,
  action,
  status,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** 标签行尾的动作（右对齐）；未提供时不占位 */
  action?: ReactNode;
  /** 控件下方的即时反馈（成功 / 失败）；未提供时不占位 */
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box>
      <Box sx={fieldLabelRowSx}>
        <Typography sx={fieldLabelSx}>{label}</Typography>
        {hint && <Typography sx={fieldHintSx}>{hint}</Typography>}
        {action}
      </Box>
      <Box sx={{ mt: 0.5 }}>{children}</Box>
      {status}
    </Box>
  );
}

/** 能力声明的单个勾选项 */
function CapabilityCheck({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <FormControlLabel
      sx={checkRowSx}
      control={
        <Checkbox
          size="small"
          sx={{ p: 0.5 }}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          inputProps={{ 'aria-label': label }}
        />
      }
      label={<Typography sx={checkLabelSx}>{label}</Typography>}
    />
  );
}

/** 「测试连接」的结果行（图标 + 文案，成功绿 / 失败红） */
function ProbeStatus({ result }: { result: ModelProbeResult }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, mt: 0.75 }}>
      {result.ok ? (
        <CheckCircleOutlineIcon sx={{ fontSize: 16, color: 'success.main', mt: '1px' }} />
      ) : (
        <ErrorOutlineIcon sx={{ fontSize: 16, color: 'error.main', mt: '1px' }} />
      )}
      <Typography
        sx={{
          fontSize: 12.5,
          lineHeight: 1.6,
          color: result.ok ? 'success.main' : 'error.main',
          // 错误里常带一段上游返回的 URL / JSON，不换行会把弹窗撑宽
          wordBreak: 'break-all',
        }}
      >
        {result.ok
          ? `连接成功${
              result.models?.length ? `，可用 ${result.models.length} 个模型` : ''
            }（${result.latencyMs}ms）${
              // 没填 key 却连上了，说清是谁的密钥——否则用户会以为「这个框填不填都一样」
              result.keySource === 'config' ? ' · 用的是引擎侧已配置的密钥' : ''
            }`
          : result.error || PROBE_TIMEOUT_HINT}
      </Typography>
    </Box>
  );
}

/**
 * 一个 token 上限字段：`输入` 标签 + 文本框（占位符「使用提供商默认值」）+ 档位按钮行。
 *
 * **「使用提供商默认值」就是空框**，不再是一个档位按钮：它意味着"不覆盖"，而空是
 * 这件事最直白的表达；档位按钮退化成**填入框里的一段文本**（`128K`），于是
 * 「当前是什么」永远只有一处读数（框里的字），不会出现「按钮选着 A、框里写着 B」。
 *
 * 档位按钮**刻意不含等于引擎默认值的数**（输出档位里没有 8K）：那种档位点下去
 * 落盘 8192、回读又被 `normalizeTokenLimit` 归一成空框，用户看到的是"我的选择被吞了"。
 * 「要 8K」= 留空（今日两者同值）。这条不变量由 `tests/modelOptions.test.ts` 守着。
 */
function TokenLimitField({
  title,
  ariaLabel,
  text,
  options,
  invalid,
  onChange,
}: {
  title: string;
  /** 输入框的无障碍名；档位组是 `"<ariaLabel> 档位"` */
  ariaLabel: string;
  /** 原始输入文本；空串 = 使用提供商默认值 */
  text: string;
  options: readonly number[];
  invalid: boolean;
  onChange: (next: string) => void;
}) {
  const selected = parseTokenLimitInput(text).value;
  return (
    <Box>
      <Typography sx={fieldLabelSx}>{title}</Typography>
      <TextField
        sx={[denseFieldSx, { mt: 0.5 }]}
        size="small"
        fullWidth
        error={invalid}
        placeholder={TOKEN_DEFAULT_LABEL}
        inputProps={{ 'aria-label': ariaLabel, inputMode: 'numeric' }}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
      <Box role="group" aria-label={`${ariaLabel} 档位`} sx={tokenChipRowSx}>
        {options.map((option) => (
          <Button
            key={option}
            size="small"
            aria-pressed={selected === option}
            sx={tokenOptionSx}
            onClick={() => onChange(formatTokenLimit(option))}
          >
            {formatTokenLimit(option)}
          </Button>
        ))}
      </Box>
    </Box>
  );
}
