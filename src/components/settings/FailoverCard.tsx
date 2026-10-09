import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { toast } from '@/components/Toast';
import {
  addFallbackPreset,
  chainedPresetNames,
  describeFallbacks,
  fallbackIssues,
  hasBlockingIssues,
  moveFallback,
  PROVIDER_RETRY_MODE_OPTIONS,
  providerRetryModeOption,
  removeFallbackAt,
} from '@/lib/modelFallbacks';
import { useModelsStore } from '@/stores/modelsStore';
import type { NanobotFallbackCandidate, ProviderRetryMode } from '@/platform/types';

/** 编辑中的草稿：`null` = 跟随 store（没有任何未保存的改动） */
interface FailoverDraft {
  fallbacks: NanobotFallbackCandidate[];
  providerRetryMode: ProviderRetryMode;
}

/** 行的定位锚点（真机脚本按它找行，不靠 DOM 序号——序号会被上移 / 下移改掉） */
const rowAnchor = (index: number) => ({ 'data-fallback-index': String(index) });

/**
 * 「故障转移」：主模型失败后按什么顺序、试哪些模型（FR-9.4）。
 *
 * ## 为什么是「草稿 + 保存」而不是逐次改动立即落盘
 *
 * 写回 `fallbackModels` 会走 `syncNanobotModels`，而那条链路在**每次写入之后都会
 * 重启网关**（`/v1/models` 的预设目录在 serve 启动时构建）。顺序编辑是典型的多步操作
 * ——「把第 3 环挪到最前」中间要动好几次——逐次落盘就是好几次网关重启，用户每点一下
 * 界面就闪一下。所以链的编辑先在本地攒着，一次保存一次写盘。
 *
 * 另一个好处是**能整体放弃**：改到一半发现不对，点「放弃修改」回到磁盘上的样子，
 * 而不是把中间态一个个撤回（撤回本身又是一串写盘）。
 *
 * ## 这里只描述「配置」，不承诺「实际回退过」
 *
 * 引擎确实会在回退发生时广播一条 `turn_model_updated`（带 `fallback: true`），
 * 但它只在 **websocket 通道**上发；本客户端走 HTTP `/v1/chat/completions`
 * （引擎侧 `channel="api"`），拿不到那条事件，而 HTTP 响应里的 `model` 只是
 * **请求解析出的预设模型**，不含回退信息。所以这张卡片展示的是**配置事实**
 * （主模型是谁、失败后按什么顺序试），而不是「本轮实际由谁服务」。
 * 要后者得先让引擎在 HTTP 契约里补一个字段——见 PRD §20.5 的「明确未做」。
 */
export function FailoverCard() {
  const managed = useModelsStore((s) => s.managed);
  const managedAvailable = useModelsStore((s) => s.managedAvailable);
  const managedLoading = useModelsStore((s) => s.managedLoading);
  const managedFallbacks = useModelsStore((s) => s.managedFallbacks);
  const providerRetryMode = useModelsStore((s) => s.providerRetryMode);
  const setFailover = useModelsStore((s) => s.setFailover);

  const [draft, setDraft] = useState<FailoverDraft | null>(null);
  const [busy, setBusy] = useState(false);

  // 草稿为 null 时读的就是 store 里的值：切分区 / 保存后回读都会自动跟上，
  // 不会出现「半截草稿把新读到的配置盖住」
  const chain = draft?.fallbacks ?? managedFallbacks;
  const retryMode = draft?.providerRetryMode ?? providerRetryMode;

  const dirty =
    draft !== null &&
    (JSON.stringify(chain) !== JSON.stringify(managedFallbacks) || retryMode !== providerRetryMode);

  const primaryPreset = managed.find((m) => m.isDefault)?.name ?? null;
  const views = describeFallbacks(chain, managed);
  const issues = fallbackIssues({
    list: chain,
    presetNames: managed.map((m) => m.name),
    primaryPreset,
  });
  const blocked = hasBlockingIssues(issues);
  const warnings = issues.filter((issue) => !issue.blocking);

  const chained = chainedPresetNames(chain);
  const addable = managed.filter((m) => !chained.includes(m.name));

  /** 所有编辑都只动草稿；`draft` 从 null 变成具体值的那一刻就是「开始有未保存改动」 */
  const edit = (next: Partial<FailoverDraft>): void => {
    setDraft({ fallbacks: chain, providerRetryMode: retryMode, ...next });
  };

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await setFailover(chain, retryMode);
      if (!result.ok) {
        // 不把草稿清掉：写盘失败时把用户的编辑丢掉是最坏的结果
        toast.error(result.message || '保存失败，请查看网关日志');
        return;
      }
      setDraft(null);
      // needsRestart = serve 由外部进程托管，写盘了但没重启 → 引擎行为纹丝不动。
      // 必须把主进程的原话警告出来，不能报「已保存」装作生效（2026-10-07 教训）。
      if (result.needsRestart) toast.warning(result.message);
      else toast.success('故障转移设置已保存');
    } finally {
      setBusy(false);
    }
  };

  const primaryHint = primaryPreset
    ? `当前主模型：「${primaryPreset}」${
        managed.find((m) => m.name === primaryPreset)?.model
          ? ` · ${managed.find((m) => m.name === primaryPreset)!.model}`
          : ''
      }`
    : '未指定默认预设 → 主模型是引擎隐式 default 预设（agents.defaults 里的 model / provider）';

  return (
    <SettingsCard
      title="故障转移"
      description="主模型不可用时按下面的顺序依次尝试。改完点「保存」才写入引擎配置——每一次写入都会重启网关，所以编辑先在本地攒着。"
      action={
        <Stack direction="row" spacing={1} alignItems="center">
          {dirty && (
            <Chip
              size="small"
              color="warning"
              variant="outlined"
              label="有未保存的改动"
              sx={{ fontSize: 11.5 }}
            />
          )}
          {dirty && (
            <Button size="small" disabled={busy} onClick={() => setDraft(null)}>
              放弃修改
            </Button>
          )}
          <Button
            size="small"
            variant="contained"
            disabled={!dirty || busy || blocked || !managedAvailable}
            onClick={() => void handleSave()}
          >
            保存
          </Button>
        </Stack>
      }
    >
      {!managedAvailable && !managedLoading && (
        <Box sx={{ py: 2 }}>
          <Alert severity="info" sx={{ fontSize: 12.5 }}>
            当前环境读不到引擎配置（Web 端，或未找到 config.json），无法管理故障转移。
          </Alert>
        </Box>
      )}

      {managedLoading && managed.length === 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={20} />
        </Box>
      )}

      {managedAvailable && (
        <>
          <SettingsRow
            label="主模型"
            hint={`${primaryHint}。它会先被尝试；连续 3 次失败后短路 60 秒，期间直接走下面的回退链。`}
          />

          <SettingsRow
            label="重试模式"
            hint={providerRetryModeOption(retryMode).description}
            control={
              <Select
                size="small"
                value={retryMode}
                disabled={busy}
                inputProps={{ 'aria-label': '供应商重试模式' }}
                sx={{ minWidth: 110, fontSize: 13 }}
                onChange={(e) => edit({ providerRetryMode: e.target.value as ProviderRetryMode })}
              >
                {PROVIDER_RETRY_MODE_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value} sx={{ fontSize: 13 }}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            }
          />

          <SettingsRow
            label="回退链"
            hint={
              chain.length === 0
                ? '还没有配回退。主模型失败时会直接报错给用户。'
                : '按顺序尝试，第一个成功即停止。'
            }
            layout="stack"
          >
            <Stack spacing={1} sx={{ mt: 1 }}>
              {views.map((view, index) => (
                <Box
                  // key 按**内容**取而不是 position：上移 / 下移会改 position，
                  // 用它当 key 等于每次重排都重建整行；末尾补下标是为了容许重复项
                  key={`${view.candidate.kind === 'preset' ? view.candidate.preset : `${view.candidate.model}@${view.candidate.provider}`}#${index}`}
                  {...rowAnchor(index)}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1.25,
                    py: 0.75,
                    borderRadius: 1.5,
                    bgcolor: 'action.hover',
                    // 未解析的项用错误色底：它是「引擎起不来」的唯一可视信号，
                    // 与普通行长得一样就等于没有这个信号
                    ...(view.resolved
                      ? {}
                      : { bgcolor: 'error.main', color: 'error.contrastText' }),
                  }}
                >
                  <Typography sx={{ fontSize: 12, opacity: 0.7, minWidth: 18 }}>
                    {view.position}
                  </Typography>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ fontSize: 13.5, fontWeight: 500 }} noWrap>
                      {view.label}
                    </Typography>
                    <Typography sx={{ fontSize: 11.5, opacity: 0.75 }} noWrap>
                      {view.hint}
                    </Typography>
                  </Box>
                  <Tooltip title="上移（更早被尝试）">
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`上移第${view.position}环`}
                        disabled={busy || index === 0}
                        onClick={() => edit({ fallbacks: moveFallback(chain, index, -1) })}
                      >
                        <ArrowUpwardIcon sx={{ fontSize: 17 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title="下移">
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`下移第${view.position}环`}
                        disabled={busy || index === chain.length - 1}
                        onClick={() => edit({ fallbacks: moveFallback(chain, index, 1) })}
                      >
                        <ArrowDownwardIcon sx={{ fontSize: 17 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title="移出回退链">
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`移除第${view.position}环`}
                        disabled={busy}
                        onClick={() => edit({ fallbacks: removeFallbackAt(chain, index) })}
                      >
                        <DeleteOutlineIcon sx={{ fontSize: 17 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Box>
              ))}

              {addable.length > 0 ? (
                <Select
                  size="small"
                  displayEmpty
                  value=""
                  disabled={busy}
                  inputProps={{ 'aria-label': '添加到回退链' }}
                  sx={{ fontSize: 13 }}
                  onChange={(e) => edit({ fallbacks: addFallbackPreset(chain, e.target.value) })}
                >
                  <MenuItem value="" sx={{ fontSize: 13 }}>
                    添加一个预设到回退链…
                  </MenuItem>
                  {addable.map((item) => (
                    <MenuItem key={item.name} value={item.name} sx={{ fontSize: 13 }}>
                      {item.name} · {item.model}
                    </MenuItem>
                  ))}
                </Select>
              ) : (
                <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                  {managed.length === 0
                    ? '还没有可选的预设——先在「自定义模型」里添加模型。'
                    : '所有预设都已经在回退链里了。'}
                </Typography>
              )}
            </Stack>
          </SettingsRow>

          {blocked && (
            <Box sx={{ py: 1.5 }}>
              <Alert severity="error" sx={{ fontSize: 12.5 }}>
                {issues
                  .filter((issue) => issue.blocking)
                  .map((issue) => issue.message)
                  .join(' ')}
              </Alert>
            </Box>
          )}

          {!blocked && warnings.length > 0 && (
            <Box sx={{ py: 1.5 }}>
              <Alert severity="warning" sx={{ fontSize: 12.5 }}>
                {warnings.map((issue) => issue.message).join(' ')}
              </Alert>
            </Box>
          )}

          <SettingsRow
            label="哪些失败会触发回退"
            hint="连接失败 / 超时 / 服务端 5xx / 限流 / 过载 会回退；内容被拦截、上下文超长、请求非法不会回退——换一个模型也一样会失败，重试只是白等一轮。"
          />
        </>
      )}
    </SettingsCard>
  );
}
