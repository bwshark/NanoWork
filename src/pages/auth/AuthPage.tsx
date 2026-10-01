import { useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  IconButton,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useNavigate } from 'react-router-dom';
import { LogoIcon } from '@/components/LogoIcon';
import { SettingsCard } from '@/components/settings/SettingsPrimitives';
import { APP_DISPLAY_NAME, APP_DISPLAY_SUB, ROUTES } from '@/lib/constants';
import { getSyncRuntime, initSyncRuntime, resolveSyncBaseUrl, SyncAuthError } from '@/sync';

/**
 * 登录 / 注册页（批次 4，FR-10；2026-10-01 改为**全屏独立页**）。
 *
 * ## 全屏 = 路由上**不在 `AppLayout` 之下**
 *
 * 这一页要独占整个窗口（没有侧栏 / 标题栏 / 设置弹窗）。做法不是在页面里藏掉侧栏，
 * 而是路由结构上让它与 `AppLayout` **平级**（见 `router/index.tsx`：`<App>` 之下挂
 * `AppLayout` 分组 + 独立的 `/auth`）。这样 `minHeight: '100vh'` 才是真的 100vh，
 * 也不会出现「弹窗挂在布局层、登录页盖不住它」这类次序问题。
 *
 * ⚠️ 但它**仍留在 `<App>` 之下**：`App` 的启动副作用（会话水合、设备号预热、模型 /
 * 技能目录刷新、同步运行时装配）必须照跑。若把 `/auth` 提到根级另起一棵树，用户直接
 * 在 `/auth` 冷启动（刷新 / 从书签进）就会跳过整条启动链——登录成功跳回聊天页时，
 * 会话列表还是空的。
 *
 * ## 为什么必须自带「返回」
 *
 * 全屏后没有侧栏可点，不给出口就成了死胡同（不改 URL 回不去）。所以左上角常驻一个
 * 返回箭头 → 聊天页；登录**成功**也走同一条路（`navigate(ROUTES.chat)`）。
 *
 * ## 取 runtime 的纪律
 *
 * 一律 `getSyncRuntime() ?? await initSyncRuntime()`：`initSyncRuntime` 是**幂等单例**，
 * 绝不会在「已有一份 runtime」时再造一份。若这里直接 `new`，就会得到两套 store 订阅 +
 * 两条 30s 定时同步（登录页一份、App 启动一份）。
 */

type AuthMode = 'login' | 'register';

/**
 * 注册密码下限，**必须与服务端 `RegisterRequest.password` 的 `min_length` 对齐**
 * （`cloud/app/auth/routes.py`）。写宽了会在服务端吃 422（用户看到「服务不可用」），
 * 写严了会挡住服务端其实接受的密码。
 */
const MIN_PASSWORD_LENGTH = 8;

/** 取同步运行时：优先复用已初始化的单例，没有则初始化一个（幂等）。 */
async function resolveRuntime() {
  return getSyncRuntime() ?? (await initSyncRuntime());
}

/**
 * 「连不上服务端」的判定。
 *
 * `fetch` 因连接被拒 / DNS 失败 / 证书错误抛出的**都是 `TypeError`**（且各浏览器文案
 * 不同：`Failed to fetch` / `NetworkError when attempting to fetch resource.`），
 * 所以不按文案匹配。它与 `SyncAuthError` 的分野是：**服务端到底有没有答复过**。
 */
function isConnectionError(err: unknown): boolean {
  return err instanceof TypeError;
}

/** 把登录 / 注册失败映射成可区分的中文文案（401 / 409 / 422 / 连不上 / 其它）。 */
export function authErrorMessage(err: unknown, mode: AuthMode): string {
  if (err instanceof SyncAuthError) {
    // 401：账号或密码错误（登录）；409：邮箱已注册（注册）
    if (err.status === 401) return '邮箱或密码错误，请检查后重试';
    if (err.status === 409) return '该邮箱已注册，请直接登录';
    // 422：服务端校验不通过（邮箱格式 / 密码长度）。FastAPI 的 422 响应体只给字段名，
    // 与其甩一个「错误码 422」，不如把规则直接说出来——用户据此能自己改对。
    if (err.status === 422) {
      return `注册信息不符合要求：请检查邮箱格式，密码至少 ${MIN_PASSWORD_LENGTH} 位`;
    }
    return `服务暂时不可用（错误码 ${err.status}），请稍后重试`;
  }
  if (isConnectionError(err)) {
    // 必须**带出地址**：只说「网络连接失败」区分不了「本机同步服务没起」和「真的断网」，
    // 而这两种情况用户要做的事完全不同（一个是去起服务，一个是查网络）。
    return `无法连接同步服务（${resolveSyncBaseUrl()}）：请确认同步服务已启动，或检查网络`;
  }
  if (err instanceof Error && err.message) return err.message;
  return mode === 'register' ? '注册失败，请稍后重试' : '登录失败，请稍后重试';
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

    // 本地先卡一道密码长度：服务端同一条规则的失败是 422，走到那一步只会得到一句
    // 「服务不可用」式的模糊提示，还白跑一次网络。
    if (mode === 'register' && password.length < MIN_PASSWORD_LENGTH) {
      setError(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
      return;
    }

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
        bgcolor: 'background.default',
      }}
    >
      {/* 顶栏：返回 + 品牌。全屏页没有侧栏可点，出口只能自己给。 */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1.5 }}>
        <Tooltip title="返回工作台">
          <IconButton
            size="small"
            aria-label="返回工作台"
            onClick={() => navigate(ROUTES.chat)}
          >
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.primary' }}>
          <LogoIcon size={20} />
          <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>
            {APP_DISPLAY_NAME}
            <Box component="span" sx={{ fontWeight: 400, color: 'text.secondary', ml: 0.5 }}>
              {APP_DISPLAY_SUB}
            </Box>
          </Typography>
        </Box>
      </Box>

      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          px: 3,
          pb: 6,
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
                // 注册时把规则写在输入框下方：等提交被拒才说，用户得白填一次
                helperText={mode === 'register' ? `至少 ${MIN_PASSWORD_LENGTH} 位` : undefined}
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
    </Box>
  );
}
