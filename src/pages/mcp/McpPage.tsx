import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
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
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import TuneIcon from '@mui/icons-material/Tune';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useMcpStore } from '@/stores/mcpStore';
import { platform } from '@/platform';
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

/** MCP 管理页（FR-004 / FR-3.2）：CRUD + 启停 + 真实连接测试 + 工具级授权 + 同步 */
export function McpPage() {
  const configs = useMcpStore((s) => s.configs);
  const vaultAvailable = useMcpStore((s) => s.vaultAvailable);
  const addConfig = useMcpStore((s) => s.addConfig);
  const updateConfig = useMcpStore((s) => s.updateConfig);
  const removeConfig = useMcpStore((s) => s.removeConfig);
  const testConfig = useMcpStore((s) => s.testConfig);
  const syncConfig = useMcpStore((s) => s.syncConfig);
  const syncEnabled = useMcpStore((s) => s.syncEnabled);
  const toggleMcp = useMcpStore((s) => s.toggleMcp);
  const setToolDisabled = useMcpStore((s) => s.setToolDisabled);
  const refreshSecrets = useMcpStore((s) => s.refreshSecrets);
  const saveSecrets = useMcpStore((s) => s.saveSecrets);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MCPConfig | null>(null);
  const [form, setForm] = useState<typeof EMPTY>(EMPTY);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  /** 工具授权对话框：目标条目 id */
  const [toolTarget, setToolTarget] = useState<string | null>(null);
  /** 工具授权的本地草稿（关闭时统一落库并同步一次，避免每次拨动都触发重启） */
  const [toolDraft, setToolDraft] = useState<Record<string, boolean>>({});
  const [toolSaving, setToolSaving] = useState(false);

  // 启动时读一次保险库状态：决定"凭据已设置/未加密"这类提示怎么写
  useEffect(() => {
    void refreshSecrets();
  }, [refreshSecrets]);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  };
  const openEdit = (c: MCPConfig) => {
    setEditing(c);
    // `auth` 留空：密钥不回传渲染层，填新值才是"替换"
    setForm({ ...c, auth: {} });
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
    if (editing) updateConfig(targetId, form);
    // 凭据：只有用户真的填了新值才写保险库（留空 = 保持原凭据不动）
    const token = form.auth?.token?.trim();
    if (token) {
      const written = await saveSecrets(targetId, { token });
      if (!written.ok) {
        setSaving(false);
        toast.error(written.error ?? '凭据保存失败');
        return;
      }
    }
    setOpen(false);
    const result = await syncConfig(targetId);
    setSaving(false);
    if (result.ok) {
      toast.success(result.message);
    } else {
      toast.error(result.message);
    }
  };
  /** 真实连接测试：走主进程探针，结果与发现的工具条数一起回显 */
  const runTest = async (c: MCPConfig) => {
    setBusy(c.id);
    const result = await testConfig(c.id);
    setBusy(null);
    if (result.ok) {
      toast.success(
        `${c.name} 连接成功：发现 ${result.tools.length} 个工具（${result.latencyMs}ms）`,
      );
    } else {
      toast.error(`${c.name} 连接失败：${result.error ?? '未知原因'}`);
    }
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
  /** 清除凭据（写空对象 = 删除保险库中的该条） */
  const clearSecret = async (c: MCPConfig) => {
    const result = await saveSecrets(c.id, {});
    if (!result.ok) {
      toast.error(result.error ?? '清除凭据失败');
      return;
    }
    const sync = await syncEnabled();
    if (sync.ok) toast.success('凭据已清除并同步');
    else toast.error(sync.message);
  };

  const toolCfg = configs.find((c) => c.id === toolTarget) ?? null;
  const openTools = (c: MCPConfig) => {
    setToolTarget(c.id);
    const draft: Record<string, boolean> = {};
    for (const tool of c.tools ?? []) draft[tool.name] = true;
    // 黑名单优先：命中即视为禁用
    for (const name of c.disabledTools ?? []) draft[name] = false;
    setToolDraft(draft);
  };
  /** 黑名单里存在、但当前探测清单里已经没有的名字（改名/下线的残留） */
  const staleDisabled = useMemo(() => {
    if (!toolCfg) return [];
    const known = new Set((toolCfg.tools ?? []).map((t) => t.name));
    return (toolCfg.disabledTools ?? []).filter((name) => !known.has(name));
  }, [toolCfg]);

  const runToolSave = async () => {
    if (!toolCfg || toolSaving) return;
    setToolSaving(true);
    const nextDisabled = Object.entries(toolDraft)
      .filter(([, allowed]) => !allowed)
      .map(([name]) => name);
    const current = new Set(toolCfg.disabledTools ?? []);
    const next = new Set(nextDisabled);
    // 只提交差异，避免把未拨动的工具也写一遍（也让 store 的 state 更新最小化）
    for (const name of (toolCfg.tools ?? []).map((t) => t.name)) {
      const wasDisabled = current.has(name);
      const willDisable = next.has(name);
      if (wasDisabled !== willDisable) setToolDisabled(toolCfg.id, name, willDisable);
    }
    setToolSaving(false);
    setToolTarget(null);
    const result = await syncEnabled();
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
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

      {vaultAvailable === false && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {platform.env === 'electron' ? (
            <>
              本机系统凭据库不可用，凭据<strong>不会被保存</strong>
              （不可用时我们拒绝降级为明文写入）。请先配置系统凭据库后重试。
            </>
          ) : (
            <>
              Web 端没有系统凭据库，凭据<strong>不会加密保存</strong>
              （以明文存在浏览器本地存储）。需要加密存储请使用桌面端。
            </>
          )}
        </Alert>
      )}

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
          const disabledCount = (c.disabledTools ?? []).length;
          const hasSecret = (c.authKeyNames ?? []).length > 0;
          const toolCount = (c.tools ?? []).length;
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

                {/* 运行时事实行：凭据 / 工具数 / 已禁工具数 */}
                <Box sx={{ display: 'flex', gap: 0.75, mt: 1.25, flexWrap: 'wrap' }}>
                  {hasSecret && (
                    <Chip
                      size="small"
                      variant="outlined"
                      sx={cardChipOutlinedSx}
                      icon={<KeyOutlinedIcon sx={{ fontSize: 14 }} />}
                      label={`凭据 ${(c.authKeyNames ?? []).join('/')}`}
                      aria-label={`${c.name} 凭据 ${(c.authKeyNames ?? []).join('/')}`}
                    />
                  )}
                  {toolCount > 0 && (
                    <Chip
                      size="small"
                      variant="outlined"
                      sx={cardChipOutlinedSx}
                      label={`工具 ${toolCount}`}
                      aria-label={`${c.name} 已发现工具 ${toolCount}`}
                    />
                  )}
                  {disabledCount > 0 && (
                    <Chip
                      size="small"
                      variant="outlined"
                      color="warning"
                      sx={cardChipOutlinedSx}
                      label={`已禁用 ${disabledCount}`}
                      aria-label={`${c.name} 已禁用工具 ${disabledCount}`}
                    />
                  )}
                </Box>

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
                  <Tooltip title={enabled ? '连接测试（真实握手）' : '已停用的 MCP 无法测试连接'}>
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`连接测试 ${c.name}`}
                        onClick={() => runTest(c)}
                        disabled={!enabled || busy === c.id}
                        sx={cardGhostActionSx}
                      >
                        <BoltIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip
                    title={
                      toolCount === 0
                        ? '工具授权：先做一次连接测试以获取工具清单'
                        : `工具授权（${toolCount} 个工具${disabledCount > 0 ? `，已禁用 ${disabledCount}` : ''}）`
                    }
                  >
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`工具授权 ${c.name}`}
                        onClick={() => openTools(c)}
                        disabled={toolCount === 0}
                        sx={cardGhostActionSx}
                      >
                        <TuneIcon sx={{ fontSize: 16 }} />
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

      {/* —————— 新增 / 编辑 —————— */}
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
            type="password"
            autoComplete="off"
            label="认证 Token（可选；留空 = 保持原凭据）"
            value={form.auth?.token ?? ''}
            onChange={(e) => setForm({ ...form, auth: { ...form.auth, token: e.target.value } })}
          />
          {editing && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                {(editing.authKeyNames ?? []).length > 0
                  ? `已设置凭据：${(editing.authKeyNames ?? []).join(' / ')}（值不在界面回显）`
                  : '当前未设置凭据'}
                {vaultAvailable === false ? ' · 本机凭据库不可用，将不会保存' : ''}
              </Typography>
              {(editing.authKeyNames ?? []).length > 0 && (
                <Button size="small" color="error" onClick={() => clearSecret(editing)}>
                  清除凭据
                </Button>
              )}
            </Box>
          )}
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

      {/* —————— 工具授权 —————— */}
      <Dialog
        open={!!toolCfg}
        onClose={() => setToolTarget(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>工具授权 · {toolCfg?.name}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            关掉的工具<strong>不会注册进引擎</strong>（模型看不到、也调不到）；其余工具照常可用。
          </Typography>
          {staleDisabled.length > 0 && (
            <Alert severity="warning" icon={<WarningAmberIcon />} sx={{ mb: 1.5 }}>
              以下已禁用的工具不在本次探测到的清单里（可能已改名或下线）：
              {staleDisabled.join('、')}
              。它们仍会随配置下发，但不会命中任何工具。
            </Alert>
          )}
          <Box sx={{ maxHeight: 360, overflow: 'auto', pr: 0.5 }}>
            {(toolCfg?.tools ?? []).map((tool) => (
              <Box
                key={tool.name}
                sx={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 1,
                  py: 0.75,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    sx={{ fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' }}
                  >
                    {tool.name}
                  </Typography>
                  {tool.description && (
                    <Typography variant="caption" color="text.secondary">
                      {tool.description}
                    </Typography>
                  )}
                </Box>
                <FormControlLabel
                  sx={{ m: 0, mr: 0 }}
                  control={
                    <Switch
                      size="small"
                      checked={toolDraft[tool.name] ?? true}
                      onChange={(e) =>
                        setToolDraft((d) => ({ ...d, [tool.name]: e.target.checked }))
                      }
                      inputProps={{ 'aria-label': `允许工具 ${tool.name}` }}
                    />
                  }
                  label={
                    <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                      {(toolDraft[tool.name] ?? true) ? '允许' : '禁用'}
                    </Typography>
                  }
                />
              </Box>
            ))}
            {(toolCfg?.tools ?? []).length === 0 && (
              <Typography color="text.secondary">尚未探测到工具清单。</Typography>
            )}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setToolTarget(null)} disabled={toolSaving}>
            取消
          </Button>
          <Button variant="contained" onClick={runToolSave} disabled={toolSaving}>
            {toolSaving ? '保存中…' : '保存并同步'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!toDelete}
        title="删除 MCP"
        message="确认删除该自定义 MCP 服务？内置条目不可删除。其已保存的凭据会一并清除。"
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
