import { useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import BoltIcon from '@mui/icons-material/Bolt';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useMcpStore } from '@/stores/mcpStore';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { toast } from '@/components/Toast';
import {
  cardGhostActionSx,
  cardGhostDangerSx,
  cardChipOutlinedSx,
  cardChipSx,
  cardStatusChipSx,
  clampLines,
  hoverCardSx,
  iconTileSx,
} from '@/lib/cardSx';
import { isBuiltinMcpId, type MCPConfig, type MCPStatus, type MCPTransport } from '@/types';

type McpForm = Partial<MCPConfig>;

const EMPTY: McpForm = {
  name: '',
  transport: 'url',
  endpoint: '',
  command: '',
  auth: {},
};

const STATUS_LABEL: Record<MCPStatus, string> = {
  idle: '未连接',
  syncing: '同步中',
  connected: '已连接',
  error: '错误',
};
const STATUS_COLOR: Record<MCPStatus, 'default' | 'warning' | 'success' | 'error'> = {
  idle: 'default',
  syncing: 'warning',
  connected: 'success',
  error: 'error',
};

/** MCP 管理页（FR-004）：CRUD + 启停切换（builtin/自定义一致）+ 同步到 nanobot 运行时 */
export function McpPage() {
  const configs = useMcpStore((s) => s.configs);
  const addConfig = useMcpStore((s) => s.addConfig);
  const updateConfig = useMcpStore((s) => s.updateConfig);
  const removeConfig = useMcpStore((s) => s.removeConfig);
  const testConfig = useMcpStore((s) => s.testConfig);
  const syncConfig = useMcpStore((s) => s.syncConfig);
  const syncEnabled = useMcpStore((s) => s.syncEnabled);
  const toggleMcp = useMcpStore((s) => s.toggleMcp);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MCPConfig | null>(null);
  const [form, setForm] = useState<typeof EMPTY>(EMPTY);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  };
  const openEdit = (c: MCPConfig) => {
    setEditing(c);
    setForm({ ...c, auth: c.auth ?? {} });
    setOpen(true);
  };
  /**
   * 保存新增/编辑并自动同步到 nanobot 运行时。
   * 同步结果以 toast 透传；列表上对应卡片的状态芯片会随 store 实时更新
   *（idle → syncing → connected/error）。
   */
  const save = async () => {
    if (!form.name?.trim() || saving) return;
    setSaving(true);
    const targetId = editing ? editing.id : addConfig(form).id;
    setOpen(false);
    const result = await syncConfig(targetId);
    setSaving(false);
    if (result.ok) {
      toast.success(result.message);
    } else {
      toast.error(result.message);
    }
  };
  const runTest = async (id: string) => {
    setBusy(id);
    await testConfig(id);
    setBusy(null);
  };
  /** 切换启用/停用后立即全量同步到 nanobot 运行时（全量提交语义） */
  const handleToggle = async (c: MCPConfig) => {
    toggleMcp(c.id);
    const result = await syncEnabled();
    if (result.ok) {
      toast.success(result.message);
    } else {
      toast.error(result.message);
    }
  };
  /** 同步全部已启用 MCP（builtin + user） */
  const runSyncAll = async () => {
    setSyncingAll(true);
    const result = await syncEnabled();
    setSyncingAll(false);
    if (result.ok) {
      toast.success(result.message);
    } else {
      toast.error(result.message);
    }
  };

  const builtinCount = configs.filter((c) => isBuiltinMcpId(c.id)).length;
  const userCount = configs.length - builtinCount;
  const enabledCount = configs.filter((c) => c.enabled !== false).length;

  return (
    <Box sx={{ p: 3, maxWidth: 1000, margin: '0 auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h5" fontWeight={700}>
          MCP 服务
        </Typography>
        <Typography variant="body2" color="text.secondary">
          内置 {builtinCount} · 自定义 {userCount} · 已启用 {enabledCount}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="把当前启用的 MCP 整体合并进 nanobot config.json 的 tools.mcpServers，并按需重启 serve；全部停用时点击可清空运行时 MCP">
          <span>
            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={runSyncAll}
              disabled={syncingAll || configs.length === 0}
            >
              {syncingAll ? '同步中…' : '同步全部已启用'}
            </Button>
          </span>
        </Tooltip>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openNew}>
          新增 MCP
        </Button>
      </Box>

      {configs.length === 0 && (
        <Typography color="text.secondary">暂无 MCP 服务，点击右上角新增。</Typography>
      )}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: 2,
          alignItems: 'stretch',
        }}
      >
        {configs.map((c) => {
          const isBuiltin = isBuiltinMcpId(c.id);
          const enabled = c.enabled !== false;
          const isCommand = c.transport !== 'url';
          const target = isCommand ? c.command ?? '—' : c.endpoint ?? '—';
          return (
            <Card
              key={c.id}
              variant="outlined"
              sx={[
                hoverCardSx,
                {
                  // 停用态整体降透明度；hover 浮起仍保留（与技能卡一致）
                  opacity: enabled ? 1 : 0.55,
                  display: 'flex',
                  flexDirection: 'column',
                  height: '100%',
                  // 覆盖 hoverCardSx 的 transition，补上 opacity（数组后项同名 key 生效）
                  transition:
                    'opacity .2s ease, background-color .18s ease, border-color .18s ease, box-shadow .18s ease',
                },
              ]}
            >
              <CardContent
                sx={{
                  p: 2.5,
                  display: 'flex',
                  flexDirection: 'column',
                  flexGrow: 1,
                  '&:last-child': { pb: 2 },
                }}
              >
                {/* 标题行：图标底托 / 名称 / 内置·自定义 / 状态 */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <Box sx={iconTileSx(c.name)} aria-hidden>
                    {c.icon ?? (isBuiltin ? '🧩' : '🔌')}
                  </Box>
                  <Typography
                    fontWeight={600}
                    noWrap
                    title={c.name}
                    sx={{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 1.4 }}
                  >
                    {c.name}
                  </Typography>
                  <Chip
                    size="small"
                    label={isBuiltin ? '内置' : '自定义'}
                    variant="outlined"
                    sx={isBuiltin ? cardChipSx : cardChipOutlinedSx}
                  />
                  <Chip
                    size="small"
                    label={STATUS_LABEL[c.status]}
                    color={STATUS_COLOR[c.status]}
                    sx={cardStatusChipSx}
                  />
                </Box>

                {/* URL / 命令行：单行截断，Tooltip 看全文 */}
                <Tooltip title={target} placement="top-start">
                  {isCommand ? (
                    <Box
                      sx={{
                        mt: 1.25,
                        px: 1,
                        py: 0.625,
                        borderRadius: '8px',
                        bgcolor: 'action.hover',
                        border: '1px solid',
                        borderColor: 'divider',
                        overflow: 'hidden',
                      }}
                    >
                      <Typography
                        noWrap
                        sx={{ fontFamily: 'monospace', fontSize: 12, color: 'text.secondary' }}
                      >
                        {target}
                      </Typography>
                    </Box>
                  ) : (
                    <Typography noWrap sx={{ mt: 1.25, fontSize: 12.5, color: 'text.secondary' }}>
                      <Box component="span" sx={{ color: 'text.disabled', mr: 0.5 }}>
                        URL
                      </Box>
                      {target}
                    </Typography>
                  )}
                </Tooltip>

                {c.description && (
                  <Typography
                    sx={{
                      fontSize: 12.5,
                      color: 'text.secondary',
                      mt: 1.25,
                      lineHeight: 1.6,
                      minHeight: 40,
                      ...clampLines(2),
                    }}
                  >
                    {c.description}
                  </Typography>
                )}

                {/* 操作行：开关在左、幽灵图标按钮组在右 */}
                <Box
                  sx={{
                    mt: 'auto',
                    pt: 1.5,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    flexWrap: 'nowrap',
                  }}
                >
                  <FormControlLabel
                    control={
                      <Switch size="small" checked={enabled} onChange={() => handleToggle(c)} />
                    }
                    label={
                      <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                        {enabled ? '启用' : '停用'}
                      </Typography>
                    }
                    sx={{ m: 0 }}
                  />
                  <Box sx={{ flex: 1 }} />
                  <Tooltip title={enabled ? '连接测试' : '已停用的 MCP 无法测试连接'}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`连接测试 ${c.name}`}
                        onClick={() => runTest(c.id)}
                        disabled={!enabled || busy === c.id}
                        sx={cardGhostActionSx}
                      >
                        <BoltIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title={isBuiltin ? '内置预设不可编辑' : '编辑'}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`编辑 ${c.name}`}
                        onClick={() => openEdit(c)}
                        disabled={isBuiltin}
                        sx={cardGhostActionSx}
                      >
                        <EditOutlinedIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title={isBuiltin ? '内置预设不可删除，可通过开关启停' : '删除'}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`删除 ${c.name}`}
                        onClick={() => setToDelete(c.id)}
                        disabled={isBuiltin}
                        sx={cardGhostDangerSx}
                      >
                        <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Box>
              </CardContent>
            </Card>
          );
        })}
      </Box>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editing ? '编辑 MCP' : '新增 MCP'}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            margin="dense"
            label="名称"
            value={form.name ?? ''}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextField
            select
            fullWidth
            margin="dense"
            label="传输类型"
            value={form.transport ?? 'url'}
            onChange={(e) => setForm({ ...form, transport: e.target.value as MCPTransport })}
            SelectProps={{ native: true }}
          >
            <option value="url">URL</option>
            <option value="command">Command</option>
          </TextField>
          {form.transport === 'url' ? (
            <TextField
              fullWidth
              margin="dense"
              label="地址 (URL)"
              value={form.endpoint ?? ''}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
            />
          ) : (
            <TextField
              fullWidth
              margin="dense"
              label="启动命令"
              value={form.command ?? ''}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
            />
          )}
          <TextField
            fullWidth
            margin="dense"
            label="认证 Token（可选，写入 auth.token；URL 模式会自动注入 Bearer）"
            value={form.auth?.token ?? ''}
            onChange={(e) => setForm({ ...form, auth: { ...form.auth, token: e.target.value } })}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setOpen(false)} disabled={saving}>
            取消
          </Button>
          <Button
            variant="contained"
            onClick={save}
            disabled={!form.name?.trim() || saving}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!toDelete}
        title="删除 MCP"
        message="确认删除该自定义 MCP 服务？内置条目不可删除。"
        danger
        confirmText="删除"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) removeConfig(toDelete);
          setToDelete(null);
        }}
      />
    </Box>
  );
}
