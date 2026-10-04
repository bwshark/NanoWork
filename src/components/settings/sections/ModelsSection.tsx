import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { ModelDialog } from '@/components/settings/ModelDialog';
import { FailoverCard } from '@/components/settings/FailoverCard';
import { chainedPresetNames } from '@/lib/modelFallbacks';
import { toast } from '@/components/Toast';
import {
  useModelsStore,
  type ManagedModel,
  type ModelFormValue,
} from '@/stores/modelsStore';

/**
 * 模型：可写的预设（引擎 config.json）。
 *
 * 只保留「自定义模型」一张卡片：它写的是 `modelPresets` / `providers`，保存后重启 serve
 * 才会出现在选择器里。
 *
 * 这里原先还挂着一张只读的「引擎模型目录」（网关 `/v1/models` 快照）。删掉的理由是它和
 * 本卡片**信息重复**：目录里的每一项都来自预设表，能在这里改的东西没必要再列一遍；而它唯一的
 * 独立价值（「我加了模型但下拉里没有」的自查）在保存链路已经会重启网关 + 强制重拉目录之后，
 * 基本不再出现。真要看网关快照，跑一次 `curl /v1/models` 更直接。
 */
export function ModelsSection() {
  const managed = useModelsStore((s) => s.managed);
  const managedLoading = useModelsStore((s) => s.managedLoading);
  const managedAvailable = useModelsStore((s) => s.managedAvailable);
  const loadManaged = useModelsStore((s) => s.loadManaged);
  const saveModel = useModelsStore((s) => s.saveModel);
  const removeModel = useModelsStore((s) => s.removeModel);
  const setDefaultModel = useModelsStore((s) => s.setDefaultModel);
  const managedFallbacks = useModelsStore((s) => s.managedFallbacks);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedModel | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<ManagedModel | null>(null);
  const [busy, setBusy] = useState(false);
  const chained = chainedPresetNames(managedFallbacks);

  useEffect(() => {
    // force：进分区就读磁盘现状（用户可能在引擎 WebUI 里改过 config.json），
    // 而不是复用某次还没返回的读取
    void loadManaged(true);
  }, [loadManaged]);

  const handleSubmit = async (value: ModelFormValue): Promise<boolean> => {
    setBusy(true);
    try {
      const ok = await saveModel(value);
      if (ok) toast.success(editing ? '模型已更新' : '模型已添加');
      return ok;
    } catch {
      toast.error('保存失败，请查看网关日志');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleSetDefault = async (item: ManagedModel) => {
    setBusy(true);
    try {
      const ok = await setDefaultModel(item.name);
      if (ok) toast.success(`已将「${item.name}」设为默认模型`);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    setBusy(true);
    try {
      const ok = await removeModel(target.name);
      if (ok) toast.success(`已删除「${target.name}」`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <SettingsCard
        title="自定义模型"
        description="添加的模型写入引擎配置的 modelPresets 与 providers，保存后自动重启网关；对话页顶部的模型选择器会立刻出现它们。设为默认后，新对话的「Auto」即指向它。"
        action={
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            disabled={!managedAvailable || busy}
            onClick={() => {
              setEditing(undefined);
              setDialogOpen(true);
            }}
          >
            添加模型
          </Button>
        }
      >
        {!managedAvailable && !managedLoading && (
          <Box sx={{ py: 2 }}>
            <Alert severity="info" sx={{ fontSize: 12.5 }}>
              当前环境读不到引擎配置（Web 端，或未找到 config.json），无法管理模型。
            </Alert>
          </Box>
        )}

        {managedLoading && managed.length === 0 && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={20} />
          </Box>
        )}

        {managedAvailable && !managedLoading && managed.length === 0 && (
          <Box sx={{ py: 3, textAlign: 'center' }}>
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
              还没有自定义模型
            </Typography>
          </Box>
        )}

        {managed.map((item) => (
          <SettingsRow
            key={item.name}
            label={item.name}
            hint={`${item.providerLabel} · ${item.model}${
              item.hasKey ? '' : ' · 未配置密钥'
            }`}
            control={
              <>
                {/* Tooltip 里垫一层 `<span>`：这三颗按钮**有 disabled 的时候**（默认模型
                    那颗星恒为 disabled，另两颗在 busy 时 disabled），而 MUI 的 Tooltip 靠
                    子元素的鼠标事件显形——disabled 的元素不触发事件，提示永远弹不出来，
                    控制台每次还刷一条警告。垫一层可接收事件的容器才真正修好。 */}
                <Tooltip title={item.isDefault ? '当前默认模型' : '设为默认模型'}>
                  <span>
                    <IconButton
                      size="small"
                      aria-label={item.isDefault ? '当前默认模型' : '设为默认模型'}
                      disabled={busy || item.isDefault}
                      onClick={() => void handleSetDefault(item)}
                    >
                      {item.isDefault ? (
                        <StarIcon sx={{ fontSize: 18, color: 'warning.main' }} />
                      ) : (
                        <StarBorderIcon sx={{ fontSize: 18 }} />
                      )}
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="编辑">
                  <span>
                    <IconButton
                      size="small"
                      aria-label="编辑"
                      disabled={busy}
                      onClick={() => {
                        setEditing(item);
                        setDialogOpen(true);
                      }}
                    >
                      <EditOutlinedIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="删除">
                  <span>
                    <IconButton
                      size="small"
                      aria-label="删除"
                      disabled={busy}
                      onClick={() => setPendingDelete(item)}
                    >
                      <DeleteOutlineIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </span>
                </Tooltip>
              </>
            }
          />
        ))}
      </SettingsCard>

      <ModelDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleSubmit}
      />

      {/* 故障转移（FR-9.4）紧挨着模型表：它引用的就是上面这些预设的名字，
          分到别的分区会让「链里那个名字指的是谁」需要来回翻。 */}
      <FailoverCard />

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        maxWidth="xs"
        PaperProps={{ sx: { borderRadius: 2.5 } }}
        aria-label="删除模型"
      >
        <DialogContent>
          <DialogContentText sx={{ fontSize: 13.5 }}>
            确定删除「{pendingDelete?.name}」？该预设会从引擎配置中移除，
            已选了它的会话需要重新选择模型。
          </DialogContentText>
          {pendingDelete && chained.includes(pendingDelete.name) && (
            // 用户该知道这件事：删除会**顺带**改掉「故障转移」那张卡片的内容。
            // 不说的话，他下次打开那张卡片会以为自己记错了。
            <DialogContentText sx={{ fontSize: 12.5, mt: 1.5, color: 'warning.main' }}>
              它还在「故障转移」的回退链里，删除时会一并把那一条摘掉——
              留着一条指向已删除预设的记录会让引擎直接拒绝加载配置（网关起不来）。
            </DialogContentText>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 2 }}>
          <Button onClick={() => setPendingDelete(null)}>取消</Button>
          <Button color="error" variant="contained" onClick={() => void confirmDelete()}>
            删除
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
