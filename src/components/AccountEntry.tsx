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
import LoginOutlinedIcon from '@mui/icons-material/LoginOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { toast } from '@/components/Toast';
import { FEEDBACK_URL, ROUTES } from '@/lib/core/constants';
import { formatShortcutHint, resolveBinding } from '@/lib/editor/shortcuts';
import { platform } from '@/platform';
import { useSyncRuntime } from '@/sync';
import type { AccountSession } from '@/sync';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSettingsUiStore } from '@/stores/settingsUiStore';

/**
 * 侧边栏底部的**账户入口**：未登录是「登录」，已登录是「头像 + 账号菜单」，
 * 凭据被服务端拒绝时是「登录已过期」。
 *
 * ## 三态各是什么
 *
 * - **未登录**：一行「头像 + 登录」，点它去 `/auth`（登录 / 注册页）。这一行取代了
 *   原来那枚「未同步」徽章——未登录时「未同步」是句废话（没登录当然不同步），而它
 *   想表达的「去登录」才是有用的动作，于是直接把动作摆出来。
 * - **已登录**：头像 + 掩码账号名，点开菜单：**设置** / 意见反馈 / 退出登录。
 *   「设置」原本是侧栏里独立的一行，移进这里是因为它是「低频、与当前任务无关」的
 *   个人设置；放菜单里，日常视线区就只剩任务本身。
 * - **已过期**（`account.isSessionExpired()`）：换票被服务端拒绝，本地会话还在、云端
 *   已经不能用。**这一态必须显式画出来**：否则侧栏顶着登录邮箱，知识库 / 项目页的
 *   横幅写着「登录状态已过期」，用户看到的是同一时刻的两句反话。菜单首项改成
 *   「重新登录」，其余（设置 / 反馈）照旧可用——过期时更不该把人关在门外。
 *   菜单最后一项也随之改叫**「清除本机登录信息」**：过期后已经没有会话可「退出」，
 *   那个动作实际只是清掉本机残留的账号与废票。一个菜单里同时出现「重新登录」和
 *   「退出登录」是自相矛盾的（用户第一眼就指出来了）。
 *
 * ## 不把账号明文铺在侧边栏
 *
 * 侧边栏常驻可见（截图、投屏、路过的人都会看到），故账号名走 `maskAccountLabel`。
 *
 * ## 登录成功后的切换是**自动**的
 *
 * 本组件不接收「登录成功」回调：`account.subscribe` 是账户态的唯一广播源，登录 / 登出 /
 * 换票成功 / 换票被拒都会经它通知（`runtime.ts` 的 `onSession` 也挂在这条线上）。若这里
 * 自己记一个「刚登录了」的标记，就会出现两个事实源——登出的时候必然只更新其中一个。
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
  /**
   * 「凭据已被服务端拒绝」。
   *
   * ⛔ 单独放进 state，靠 `getSession()` 的新对象顺带触发重渲染是不行的：订阅回调里
   * 若拿到同一个 session 引用，React 会 bail out，于是「过期 → 恢复」这一跳不重绘，
   * 侧栏就永远停在「登录已过期」。
   */
  const [expired, setExpired] = useState<boolean>(
    () => runtime?.account.isSessionExpired?.() ?? false,
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
      setExpired(false);
      return;
    }
    const read = (): void => {
      setSession(runtime.account.getSession());
      setExpired(runtime.account.isSessionExpired?.() ?? false);
    };
    read();
    return runtime.account.subscribe(read);
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
      // 同一件事在两种状态下要两个说法：过期后已经没有会话可「退出」，动作实际只是
      // 清掉本机残留的账号与废票（服务端那次 logout 大概率也是 401，不影响本地收口）
      toast.success(expired ? '已清除本机登录信息' : '已退出登录');
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

  /**
   * 过期态的「重新登录」。
   *
   * 只跳登录页、**不先登出**：本地会话是「账号 + 两张废票」，登出会连邮箱一起清掉，
   * 用户还得重新回忆用哪个账号；而登录成功本来就会覆盖整份会话。
   */
  const relogin = (): void => {
    setAnchorEl(null);
    navigate(ROUTES.auth);
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
        aria-label={expired ? '登录已过期' : '账户菜单'}
        aria-haspopup="menu"
        aria-expanded={anchorEl !== null}
        onClick={(e) => setAnchorEl(e.currentTarget)}
        sx={ROW_SX}
      >
        {expired ? (
          // 头像位换成警示图标：这一行的语义已经不是「我是谁」，而是「你去重新登录」
          <WarningAmberOutlinedIcon
            sx={{ fontSize: 20, color: 'warning.main', flexShrink: 0 }}
          />
        ) : (
          <AccountAvatar />
        )}
        <Box sx={{ minWidth: 0 }}>
          <Typography
            noWrap
            sx={{
              fontSize: 12.5,
              fontWeight: 500,
              color: expired ? 'warning.main' : 'text.secondary',
            }}
          >
            {expired ? '登录已过期' : maskAccountLabel(session.email)}
          </Typography>
          {expired && (
            // 仍然显示是哪个账号：过期后用户第一反应是「这是谁的账号来着」
            <Typography noWrap sx={{ fontSize: 11, color: 'text.secondary' }}>
              {maskAccountLabel(session.email)}
            </Typography>
          )}
        </Box>
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
        {/* 过期时恢复动作排第一：这是此刻唯一能让云端资源重新可用的操作 */}
        {expired && (
          <MenuItem onClick={relogin}>
            <ListItemIcon>
              <LoginOutlinedIcon fontSize="small" sx={{ color: 'warning.main' }} />
            </ListItemIcon>
            <Typography sx={{ fontSize: 13, color: 'warning.main' }}>重新登录</Typography>
          </MenuItem>
        )}
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
        {/* 这一项与上面两项语义不同（动的是本机的登录信息），用分隔线拉开距离防误点 */}
        <Divider sx={{ my: 0.5 }} />
        <MenuItem onClick={() => void logout()} disabled={busy}>
          <ListItemIcon>
            <LogoutOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <Typography sx={{ fontSize: 13 }}>
            {expired ? '清除本机登录信息' : '退出登录'}
          </Typography>
        </MenuItem>
      </Menu>
    </>
  );
}
