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

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedModel | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<ManagedModel | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadManaged();
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
                <Tooltip title={item.isDefault ? '当前默认模型' : '设为默认模型'}>
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
                </Tooltip>
                <Tooltip title="编辑">
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
                </Tooltip>
                <Tooltip title="删除">
                  <IconButton
                    size="small"
                    aria-label="删除"
                    disabled={busy}
                    onClick={() => setPendingDelete(item)}
                  >
                    <DeleteOutlineIcon sx={{ fontSize: 18 }} />
                  </IconButton>
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
