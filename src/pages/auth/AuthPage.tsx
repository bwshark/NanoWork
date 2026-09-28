import { useState, type FormEvent } from 'react';
import { Alert, Box, Button, Tab, Tabs, TextField, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { SettingsCard } from '@/components/settings/SettingsPrimitives';
import { ROUTES } from '@/lib/constants';
import { getSyncRuntime, initSyncRuntime, SyncAuthError } from '@/sync';

/**
 * 登录 / 注册页（批次 4，FR-10）。
 *
 * ## 为什么是路由页而不是弹窗
 *
 * 设计 §3.3 指名 `src/pages/auth/`；且登录成功后要回到主界面，路由页天然衔接
 * （`navigate(ROUTES.chat)`）。它**不是受保护页**——local-first：未登录也能用全部
 * 本地功能，登录只是开启跨设备同步，入口收在设置「账户」分区或状态徽章里。
 *
 * ## 取 runtime 的纪律
 *
 * 一律 `getSyncRuntime() ?? await initSyncRuntime()`：`initSyncRuntime` 是**幂等单例**，
 * 绝不会在「已有一份 runtime」时再造一份。若这里直接 `new`，就会得到两套 store 订阅 +
 * 两条 30s 定时同步（登录页一份、App 启动一份）。
 */

type AuthMode = 'login' | 'register';

/** 取同步运行时：优先复用已初始化的单例，没有则初始化一个（幂等）。 */
async function resolveRuntime() {
  return getSyncRuntime() ?? (await initSyncRuntime());
}

/** 把登录 / 注册失败映射成可区分的中文文案（401 / 409 / 其它）。 */
export function authErrorMessage(err: unknown, mode: AuthMode): string {
  if (err instanceof SyncAuthError) {
    // 401：账号或密码错误（登录）；409：邮箱已注册（注册）
    if (err.status === 401) return '邮箱或密码错误，请检查后重试';
    if (err.status === 409) return '该邮箱已注册，请直接登录';
    return `服务暂时不可用（错误码 ${err.status}），请稍后重试`;
  }
  if (err instanceof Error && mode === 'register' && err.message) {
    return err.message;
  }
  return '网络连接失败，请检查网络后重试';
}

export function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const runtime = await resolveRuntime();
      const normalizedEmail = email.trim();
      if (mode === 'login') {
        await runtime.account.login(normalizedEmail, password);
      } else {
        await runtime.account.register(normalizedEmail, password);
      }
      // 登录成功：account.subscribe 已在 runtime 内触发 engine.start()，
      // 这里只负责把用户送回主界面。
      navigate(ROUTES.chat);
    } catch (err) {
      setError(authErrorMessage(err, mode));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: AuthMode): void => {
    setMode(next);
    setError(null);
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 3,
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 420 }}>
        <SettingsCard
          title={mode === 'login' ? '登录' : '注册'}
          description="登录后可跨设备同步你的 Agent、会话与设置；不登录也能使用全部本地功能。"
        >
          <Box
            component="form"
            onSubmit={submit}
            sx={{ py: 2.5, display: 'flex', flexDirection: 'column', gap: 2 }}
          >
            <Tabs
              value={mode}
              onChange={(_e, value: AuthMode) => switchMode(value)}
              variant="fullWidth"
              aria-label="登录或注册"
              sx={{
                minHeight: 36,
                '& .MuiTab-root': {
                  minHeight: 36,
                  textTransform: 'none',
                  fontSize: 14,
                  fontWeight: 600,
                },
              }}
            >
              <Tab value="login" label="登录" />
              <Tab value="register" label="注册" />
            </Tabs>

            <TextField
              label="邮箱"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              fullWidth
              size="small"
              required
            />
            <TextField
              label="密码"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              fullWidth
              size="small"
              required
            />

            {error && <Alert severity="error">{error}</Alert>}

            <Button
              type="submit"
              variant="contained"
              disabled={busy}
              sx={{ textTransform: 'none', fontSize: 14 }}
            >
              {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
            </Button>
          </Box>
        </SettingsCard>

        <Typography
          sx={{ fontSize: 12, color: 'text.secondary', textAlign: 'center', px: 0.5 }}
        >
          本地优先：不登录也可以使用全部本地功能，登录只是开启跨设备同步。
        </Typography>
      </Box>
    </Box>
  );
}
