import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Divider,
  ListItemIcon,
  Menu,
  MenuItem,
  Typography,
} from '@mui/material';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import SettingsIcon from '@mui/icons-material/Settings';
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import { toast } from '@/components/Toast';
import { FEEDBACK_URL, ROUTES } from '@/lib/constants';
import { formatShortcutHint, resolveBinding } from '@/lib/shortcuts';
import { platform } from '@/platform';
import { useSyncRuntime } from '@/sync';
import type { AccountSession } from '@/sync';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSettingsUiStore } from '@/stores/settingsUiStore';

/**
 * 侧边栏底部的**账户入口**：未登录是「登录」，已登录是「头像 + 账号菜单」。
 *
 * ## 两态各是什么
 *
 * - **未登录**：一行「头像 + 登录」，点它去 `/auth`（登录 / 注册页）。这一行取代了
 *   原来那枚「未同步」徽章——未登录时「未同步」是句废话（没登录当然不同步），而它
 *   想表达的「去登录」才是有用的动作，于是直接把动作摆出来。
 * - **已登录**：头像 + 掩码账号名，点开菜单：**设置** / 意见反馈 / 退出登录。
 *   「设置」原本是侧栏里独立的一行，移进这里是因为它是「低频、与当前任务无关」的
 *   个人设置；放菜单里，日常视线区就只剩任务本身。
 *
 * ## 不把账号明文铺在侧边栏
 *
 * 侧边栏常驻可见（截图、投屏、路过的人都会看到），故账号名走 `maskAccountLabel`。
 *
 * ## 登录成功后的切换是**自动**的
 *
 * 本组件不接收「登录成功」回调：`account.subscribe` 是账户态的唯一广播源，登录 / 登出
 * 都会经它通知（`runtime.ts` 的 `onSession` 也挂在这条线上）。若这里自己记一个
 * 「刚登录了」的标记，就会出现两个事实源——登出的时候必然只更新其中一个。
 */

/** 头像底板：两态共用，登录态与未登录态视觉一致（都是「未指名的人」） */
function AccountAvatar() {
  return (
    <Box
      sx={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        bgcolor: 'action.hover',
        color: 'text.secondary',
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
      }}
    >
      <PersonOutlineIcon sx={{ fontSize: 18 }} />
    </Box>
  );
}

/**
 * 整行按钮的样式：与侧栏其它行同一套观感（圆角、hover 底色）。
 *
 * 用原生 `button` 而不是 MUI `ListItemButton`：这里只有「头像 + 一行文字」，没有
 * 列表项该有的选中态与缩进，套 `ListItemButton` 反而要逐条覆写它的内边距。
 */
const ROW_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 1.25,
  width: '100%',
  px: 1.5,
  py: 0.75,
  border: 'none',
  borderRadius: 2,
  bgcolor: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  '&:hover': { bgcolor: 'action.hover' },
} as const;

/**
 * 账号标识 → 侧边栏里显示的掩码（保留可辨识度，不完整泄露）。
 *
 * 两种形态都处理：本项目登录用的是邮箱（`AccountSession.email`），但同一套规则对
 * 手机号同样成立（`13200000000` → `132******00`），日后加手机号登录不必再改这里。
 *
 * 短标识（`a@x.com`）不做「保留首尾」的算术：那会得到长度不足的星号串，反而更难认；
 * 一律至少三个星号，长度随标识增长。
 */
export function maskAccountLabel(account: string): string {
  const at = account.indexOf('@');
  if (at > 0) {
    const local = account.slice(0, at);
    const domain = account.slice(at);
    const head = local.slice(0, 2);
    return `${head}${'*'.repeat(Math.max(local.length - head.length, 3))}${domain}`;
  }
  if (account.length <= 4) return account;
  const head = account.slice(0, 3);
  const tail = account.slice(-2);
  return `${head}${'*'.repeat(account.length - head.length - tail.length)}${tail}`;
}

export function AccountEntry() {
  const navigate = useNavigate();
  const runtime = useSyncRuntime();
  const openSettings = useSettingsUiStore((s) => s.openSettings);
  const shortcuts = useSettingsStore((s) => s.settings.shortcuts);

  const [session, setSession] = useState<AccountSession | null>(
    () => runtime?.account.getSession() ?? null,
  );
  /** 账户菜单锚点；`null` = 菜单关闭 */
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // runtime 是**启动后异步**出现的（App 启动块要等设备号与会话列表就位），而本组件
    // 在首屏就挂上了。所以：一到就补读一次当前会话，之后才交给订阅——只订阅不补读会
    // 漏掉「订阅建立之前就已登录」的那一次（冷启动的已登录用户会一直看到「登录」）。
    if (!runtime) {
      setSession(null);
      return;
    }
    setSession(runtime.account.getSession());
    return runtime.account.subscribe(() => {
      setSession(runtime.account.getSession());
    });
  }, [runtime]);

  /** 菜单里「设置」右侧的键位提示：取自快捷键注册表，用户改过键位也跟着变 */
  const settingsHint = formatShortcutHint(resolveBinding('settings.open', shortcuts));

  const logout = async (): Promise<void> => {
    setAnchorEl(null);
    if (!runtime || busy) return;
    setBusy(true);
    try {
      // 只调 logout：`engine.stop()` 与 `resetSyncStatus()` 由 `account.subscribe` 触发
      // （唯一入口，见 runtime.ts）——这里手调会漏 reset 或重复。
      await runtime.account.logout();
      toast.success('已退出登录');
    } finally {
      setBusy(false);
    }
  };

  const feedback = (): void => {
    setAnchorEl(null);
    void platform.openUrl(FEEDBACK_URL).then((result) => {
      if (!result.ok) toast.error(result.error ?? '打开反馈页面失败');
    });
  };

  const openSettingsFromMenu = (): void => {
    setAnchorEl(null);
    openSettings();
  };

  if (!session) {
    return (
      <Box
        component="button"
        type="button"
        aria-label="登录"
        onClick={() => navigate(ROUTES.auth)}
        sx={ROW_SX}
      >
        <AccountAvatar />
        <Typography sx={{ fontSize: 12.5, fontWeight: 500, color: 'text.secondary' }}>
          登录
        </Typography>
      </Box>
    );
  }

  return (
    <>
      <Box
        component="button"
        type="button"
        aria-label="账户菜单"
        aria-haspopup="menu"
        aria-expanded={anchorEl !== null}
        onClick={(e) => setAnchorEl(e.currentTarget)}
        sx={ROW_SX}
      >
        <AccountAvatar />
        <Typography
          noWrap
          sx={{
            fontSize: 12.5,
            fontWeight: 500,
            color: 'text.secondary',
            minWidth: 0,
          }}
        >
          {maskAccountLabel(session.email)}
        </Typography>
      </Box>

      <Menu
        anchorEl={anchorEl}
        open={anchorEl !== null}
        onClose={() => setAnchorEl(null)}
        // 入口贴在侧栏最底部：菜单必须**向上**展开（锚点顶部 = 菜单底部），
        // 否则会捅出窗口下沿被裁掉
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        PaperProps={{ sx: { minWidth: 200, mb: 0.5 } }}
      >
        <MenuItem onClick={openSettingsFromMenu}>
          <ListItemIcon>
            <SettingsIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13, flex: 1 }}>设置</Typography>
          {settingsHint && (
            <Typography
              sx={{ fontSize: 11.5, color: 'text.secondary', ml: 2, whiteSpace: 'nowrap' }}
            >
              {settingsHint}
            </Typography>
          )}
        </MenuItem>
        <MenuItem onClick={feedback}>
          <ListItemIcon>
            <SendOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>意见反馈</Typography>
        </MenuItem>
        {/* 退出登录与上面两项语义不同（断开本机与云端的会话），用分隔线拉开距离防误点 */}
        <Divider sx={{ my: 0.5 }} />
        <MenuItem onClick={() => void logout()} disabled={busy}>
          <ListItemIcon>
            <LogoutOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>退出登录</Typography>
        </MenuItem>
      </Menu>
    </>
  );
}
