import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Divider, Stack, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import { toast } from '@/components/Toast';
import { ensureLocalMemoryScope, platformMemoryIo, userMemoryRef } from '@/lib/memory/memoryPlatformIo';
import { createUserMemoryStore, type UserMemoryStore } from '@/lib/memory/memoryUserStore';
import { PROFILE_FIELDS, type PreferenceRecord, type ProfileField, type UserProfile } from '@/types';

/**
 * 用户级画像与偏好的编辑入口（FR-M20 / FR-M21 / FR-M23）。
 *
 * ## 为什么必须在 UI 上有入口
 *
 * `updateProfile` 与 `setPreference` 是**显式工具**：设计里刻意不让模型自动写用户画像
 * （`save_user_preference` 那类「模型可调用的工具」在本项目根本不存在——没有客户端工具
 * 注册通道，见 FR-M13a）。因此**用户自己就是唯一入口**：如果界面上没有，这两条需求
 * 就只存在于代码里，永远不会被触发。
 *
 * ## 两条与「模型自动写」不同的规则
 *
 * 1. **画像只列白名单字段**：模型每轮都会发明新字段（`nickname` / `gender`），
 *    让它们进 profile 会把画像变成垃圾桶，所以这里是固定九个字段的表单；
 * 2. **偏好带有效期**：临时的偏好（「这个月用简写」）到期后**不再注入**但记录保留，
 *    用户能看到「它曾经生效过」。
 */

/** 偏好键的形态提示（与 `PREFERENCE_KEY_RE` 一致） */
const KEY_HINT = '小写字母、数字与 . _ -（例：response.language）';

function storeOf(
  setStore: (s: UserMemoryStore | null) => void,
  setScope: (s: string) => void,
): void {
  void (async () => {
    const scope = await ensureLocalMemoryScope();
    setScope(scope);
    setStore(
      createUserMemoryStore({
        io: platformMemoryIo(userMemoryRef(scope)),
        userScope: scope,
      }),
    );
  })();
}

export function UserMemoryEditor() {
  const [store, setStore] = useState<UserMemoryStore | null>(null);
  const [scope, setScope] = useState('');
  const [profile, setProfile] = useState<UserProfile>({});
  /** 表单里的草稿（可能是未保存的改动） */
  const [draft, setDraft] = useState<Partial<Record<ProfileField, string>>>({});
  const [prefs, setPrefs] = useState<PreferenceRecord[]>([]);
  const [expired, setExpired] = useState<PreferenceRecord[]>([]);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newExpiry, setNewExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    storeOf(setStore, setScope);
  }, []);

  const refresh = useCallback(async () => {
    if (!store) return;
    setError(null);
    try {
      const [p, active, gone] = await Promise.all([
        store.loadProfile(),
        store.activePreferences(new Date()),
        store.expiredPreferences(new Date()),
      ]);
      setProfile(p);
      // 草稿以磁盘为准：刷新后未保存的改动会丢，这是刻意的（避免「界面上有值、
      // 磁盘上没有」这种无法判断该信谁的状态）
      setDraft({});
      setPrefs(active);
      setExpired(gone);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<void>, ok: string, fail: string) => {
      setBusy(true);
      try {
        await action();
        toast.success(ok);
        await refresh();
      } catch (e) {
        toast.error(`${fail}：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const saveProfile = () =>
    run(
      async () => {
        if (!store) return;
        // 只提交**非空**的草稿字段：空串在协议里是非法值（删除要用 null），
        // 而「用户清空了输入框」的意图是「不改这一项」，不是「删掉它」。
        const patch: Record<string, string> = {};
        for (const [field, value] of Object.entries(draft)) {
          if (typeof value === 'string' && value.trim() !== '') patch[field] = value.trim();
        }
        if (Object.keys(patch).length === 0) throw new Error('没有要保存的改动');
        await store.updateProfile(patch, new Date());
      },
      '画像已保存',
      '保存画像失败',
    );

  const clearField = (field: ProfileField) =>
    run(
      async () => {
        if (!store) return;
        await store.updateProfile({ [field]: null }, new Date());
      },
      '已删除该字段',
      '删除失败',
    );

  const addPreference = () =>
    run(
      async () => {
        if (!store) return;
        const key = newKey.trim();
        const value = newValue.trim();
        if (key === '' || value === '') throw new Error('键与值都要填');
        // 有效期是可选输入（`<input type="date">` 给的是 `YYYY-MM-DD`，补成当天结束的
        // 本地时刻再转 ISO——不带时区的字符串会被 `setPreference` 拒绝，那是对的：
        // 「2026-11-01」在不同时区是不同时刻）
        let expiresAt: string | undefined;
        if (newExpiry.trim() !== '') {
          const local = new Date(`${newExpiry.trim()}T23:59:59`);
          if (Number.isNaN(local.getTime())) throw new Error('有效期不是合法日期');
          expiresAt = local.toISOString();
        }
        await store.setPreference(
          key,
          value,
          { source: 'user', ...(expiresAt ? { expiresAt } : {}) },
          new Date(),
        );
        setNewKey('');
        setNewValue('');
        setNewExpiry('');
      },
      '偏好已保存',
      '保存偏好失败',
    );

  const removePreference = (key: string) =>
    run(
      async () => {
        if (!store) return;
        await store.deletePreference(key, new Date());
      },
      '偏好已删除',
      '删除失败',
    );

  if (error) {
    return (
      <Alert severity="error" sx={{ mb: 1 }}>
        读取用户级记忆失败：{error}
      </Alert>
    );
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        用户作用域：{scope || '…'}
        {' · '}
        这里的内容**跨项目**生效；只有你明确填写的才进这一层（模型不能自己写画像）。
      </Typography>

      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        画像
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
          gap: 1,
        }}
      >
        {PROFILE_FIELDS.map((field) => {
          const saved = profile[field];
          return (
            <Stack key={field} direction="row" spacing={0.5} alignItems="center">
              <TextField
                size="small"
                label={PROFILE_LABELS[field]}
                value={draft[field] ?? saved ?? ''}
                placeholder={saved === undefined ? '未设置' : ''}
                onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
                inputProps={{ 'data-field': field }}
                sx={{ flex: 1 }}
              />
              {saved !== undefined && (
                <Button
                  size="small"
                  color="error"
                  disabled={busy}
                  onClick={() => void clearField(field)}
                  aria-label={`删除 ${PROFILE_LABELS[field]}`}
                >
                  清
                </Button>
              )}
            </Stack>
          );
        })}
      </Box>
      <Button
        size="small"
        variant="contained"
        sx={{ mt: 1 }}
        startIcon={<SaveOutlinedIcon />}
        disabled={busy || Object.keys(draft).length === 0}
        onClick={() => void saveProfile()}
      >
        保存画像
      </Button>

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        跨项目偏好（{prefs.length}）
      </Typography>
      {prefs.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          还没有偏好。比如「以后都用中文回复」可以记成键 <code>response.language</code>、值 <code>Chinese</code>。
        </Typography>
      )}
      <Stack spacing={0.75} sx={{ mb: 1.5 }}>
        {prefs.map((record) => (
          <Stack key={record.key} direction="row" spacing={1} alignItems="center">
            <Chip size="small" variant="outlined" label={record.key} />
            <Typography variant="body2" sx={{ flex: 1, wordBreak: 'break-all' }}>
              {record.value}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {record.expiresAt ? `至 ${record.expiresAt.slice(0, 10)}` : '长期'}
            </Typography>
            <Button
              size="small"
              color="error"
              disabled={busy}
              onClick={() => void removePreference(record.key)}
              startIcon={<DeleteOutlineIcon />}
            >
              删除
            </Button>
          </Stack>
        ))}
      </Stack>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
        <TextField
          size="small"
          label="键"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          helperText={KEY_HINT}
          sx={{ minWidth: 200 }}
        />
        <TextField
          size="small"
          label="值"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          sx={{ minWidth: 200 }}
        />
        <TextField
          size="small"
          label="到某天失效（可空）"
          type="date"
          value={newExpiry}
          onChange={(e) => setNewExpiry(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          disabled={busy}
          onClick={() => void addPreference()}
        >
          添加
        </Button>
      </Stack>

      {expired.length > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            已过期（{expired.length}）
          </Typography>
          <Typography variant="caption" color="text.secondary">
            过期只是**不再注入**，记录留着以便解释它曾经为何生效。
          </Typography>
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {expired.map((record) => (
              <Stack key={record.key} direction="row" spacing={1} alignItems="center">
                <Chip size="small" label={record.key} />
                <Typography variant="body2" sx={{ flex: 1 }}>
                  {record.value}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  至 {record.expiresAt?.slice(0, 10)}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </>
      )}
    </Box>
  );
}

/** 字段 → 中文标签（与 `renderProfileProjection` 的措辞保持一致） */
const PROFILE_LABELS: Record<ProfileField, string> = {
  name: '姓名',
  callThem: '称呼',
  timezone: '时区',
  language: '默认语言',
  occupation: '职业',
  organization: '所在组织',
  role: '角色',
  city: '常驻城市',
  responseStyle: '表达偏好',
};
