import { useState, type ReactNode } from 'react';
import {
  Box,
  Button,
  Divider,
  Menu,
  MenuItem,
  Popover,
  Switch,
  Typography,
} from '@mui/material';
import WorkspacesIcon from '@mui/icons-material/Workspaces';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import GppMaybeIcon from '@mui/icons-material/GppMaybe';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ClearIcon from '@mui/icons-material/Clear';
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswer';
import ChecklistIcon from '@mui/icons-material/Checklist';
import BuildIcon from '@mui/icons-material/Build';
import { platform } from '@/platform';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  DEFAULT_WORKSPACE_LABEL,
  isSameWorkspacePath,
  resolveWorkspaceLabel,
} from '@/lib/workspace/workspaceLabel';
import { hasConversation } from '@/lib/session/conversation';
import { useDefaultWorkspacePath } from '@/stores/storageInfoStore';
import { getRuntime } from '@/ai/runtime';
import { useActiveModelCapabilities } from '@/hooks/useActiveModelCapabilities';
import { degradedNotice } from '@/lib/model/modelCapability';
import type { ExecutionMode } from '@/types/event';

/**
 * 执行模式三选项（FR-1.4）。
 *
 * 文案刻意**先说能不能改文件**——用户对这三个词最可能的误解是「这只是回答
 * 风格」，而它实际约束的是工具网关：Ask / Plan 下写类工具被引擎 deny，
 * 不是「提示词自律」，是调用根本做不成。
 */
const MODE_OPTIONS: ReadonlyArray<{
  value: ExecutionMode;
  label: string;
  caption: string;
  icon: ReactNode;
}> = [
  {
    value: 'ask',
    label: 'Ask · 只问不改',
    caption: '只读探索，写类工具被引擎直接拒绝',
    icon: <QuestionAnswerIcon fontSize="small" />,
  },
  {
    value: 'plan',
    label: 'Plan · 先出计划',
    caption: '产出可勾选的计划，批准后才进入执行',
    icon: <ChecklistIcon fontSize="small" />,
  },
  {
    value: 'craft',
    label: 'Craft · 直接执行',
    caption: '允许改动文件与执行命令（受权限开关约束）',
    icon: <BuildIcon fontSize="small" />,
  },
];

/**
 * 输入框工具条的「会话级上下文」控件：工作空间选择 + 权限设定。
 * - 工作空间：Electron 弹原生目录选择；Web 降级 File System Access API。
 *   未选择目录的会话归入「默认工作空间」。**只在会话还没有对话记录时出现**
 *   （有记录 = 任务已经开工，工作空间是建时决定，见 `showWorkspacePicker`）。
 * - 权限：两个正交开关——「逐条批准」（细：改动环境的操作执行前先问）与
 *   「允许完全访问」（粗：直接放开，等于不再逐条询问）。
 * - 执行模式（FR-1.4）：Ask / Plan / Craft，决定「能不能改东西」这一层。
 * 三者均作用于当前会话（无活跃会话时先创建会话再应用）。
 *
 * 执行模式选择器受 `capabilities.executionModes` 门控：引擎不支持时必须隐藏，
 * 不能留一个点了不生效的开关——那会让用户以为自己在 Plan 里，实际句句能写。
 */
export function ComposerControls() {
  const activeSessionId = useSessionsStore((s) => s.activeId);
  const activeSession = useSessionsStore((s) =>
    activeSessionId ? s.sessions.find((x) => x.id === activeSessionId) : undefined,
  );
  const createSession = useSessionsStore((s) => s.createSession);
  const setSessionWorkdir = useSessionsStore((s) => s.setSessionWorkdir);
  const setSessionFullAccess = useSessionsStore((s) => s.setSessionFullAccess);
  const setSessionToolApproval = useSessionsStore((s) => s.setSessionToolApproval);
  const setSessionMode = useSessionsStore((s) => s.setSessionMode);
  const workspaceAliases = useSettingsStore((s) => s.settings.workspaceAliases);
  // 「默认工作空间」当前的真实落点（设置 → 通用 → 存储）：落在它上面的会话显示
  // 「默认工作空间」这个语义名，而不是默认目录的末级目录名。
  const defaultWorkspacePath = useDefaultWorkspacePath();

  const [wsMenuAnchor, setWsMenuAnchor] = useState<null | HTMLElement>(null);
  const [permAnchor, setPermAnchor] = useState<null | HTMLElement>(null);
  const [modeAnchor, setModeAnchor] = useState<null | HTMLElement>(null);

  /** 无活跃会话时先创建（继承当前全局活跃专家团 / 专家），返回会话 id */
  const ensureSession = (): string => {
    if (activeSessionId) return activeSessionId;
    return createSession(undefined, '新会话').id;
  };

  /** 打开系统目录选择器并应用到当前会话 */
  const handlePickWorkdir = async () => {
    setWsMenuAnchor(null);
    const dir = await platform.pickDirectory();
    if (!dir) return; // 用户取消
    setSessionWorkdir(ensureSession(), dir);
  };

  const handleClearWorkdir = () => {
    setWsMenuAnchor(null);
    if (activeSessionId) setSessionWorkdir(activeSessionId, undefined);
  };

  const fullAccess = activeSession?.fullAccess ?? false;
  const toolApproval = activeSession?.toolApproval ?? false;
  const mode: ExecutionMode = activeSession?.mode ?? 'craft';
  const currentMode = MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[2];
  // 能力门控：同步取当前实现即可（单例惰性构造，不含 IO）
  const modesSupported = getRuntime().capabilities.executionModes === true;
  /**
   * 模型级能力门控（FR-9.3）。
   *
   * 与上面的 `modesSupported`（**运行时**能力）是两层：那一层问「这个引擎支不支持
   * 执行模式」，这一层问「当前这个模型能不能调工具」。工具都调不动时，权限设定
   * （沙箱 / 逐条批准）没有任何对象可言——`toolCall` 为假才置灰「逐条批准」。
   */
  const modelCaps = useActiveModelCapabilities();
  const plainChatNotice = degradedNotice(modelCaps.capabilities);
  /**
   * 是否显示工作空间选择（对齐 WorkBuddy：有对话的会话里没有这个入口）。
   *
   * 工作空间是「这条任务在哪儿干活、记录落在哪儿」的**建时决定**：一旦有了对话
   * 记录，再改它就只可能半生效——已落盘的记录不会跟着换目录（搬迁是「读旧 → 删旧
   * → 写新」，中途挂掉就是整段对话消失，代价与「点一下」完全不成比例），而它又
   * 直接决定这条任务归到哪个工作空间分组。留一个改了不生效（或只生效一半）的入口，
   * 比没有入口更糟：用户会以为自己换了地方，实际记录还在原处。
   *
   * 判据用 `hasConversation`（缺消息时兜底到索引里的持久条数）而不是
   * `messages.length`：重启后未点开的任务消息是留白的，只看消息会让这个按钮在
   * 「明明有对话记录的任务」上闪现一下。入口只在「还没开工的新任务」上出现，
   * 那正是需要选工作空间的时刻。
   */
  const showWorkspacePicker = !activeSession || !hasConversation(activeSession);

  return (
    <>
      {/* 工作空间按钮 + 菜单：只在**还没产生对话记录**的任务上出现（见
          `showWorkspacePicker`）。未选目录（以及就落在默认工作空间上）一律显示
          「默认工作空间」，其余显示目录名（别名优先）——名字跟着设置里的默认路径走，
          不写死目录名 */}
      {showWorkspacePicker && (
        <>
          <Button
            size="small"
            startIcon={<WorkspacesIcon fontSize="small" />}
            onClick={(e) => setWsMenuAnchor(e.currentTarget)}
            sx={{
              textTransform: 'none',
              color: 'text.secondary',
              fontSize: 12,
              '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
            }}
          >
            {activeSession?.workdir
              ? resolveWorkspaceLabel(
                  activeSession.workdir,
                  workspaceAliases,
                  defaultWorkspacePath,
                )
              : DEFAULT_WORKSPACE_LABEL}
          </Button>

          <Menu
            anchorEl={wsMenuAnchor}
            open={!!wsMenuAnchor}
            onClose={() => setWsMenuAnchor(null)}
            slotProps={{ paper: { sx: { minWidth: 180 } } }}
          >
            <MenuItem onClick={() => void handlePickWorkdir()}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <FolderOpenIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                <Typography variant="body2">选择工作空间…</Typography>
              </Box>
            </MenuItem>
            {/* 「清除」只在**确实离开了默认工作空间**时才出现：会话本来就在默认路径上时
                点它不会改变任何东西（store 会把 undefined 落回默认路径），留一个点了没反应
                的菜单项只会让人怀疑是不是没生效。注意判等是对**当前**默认路径，所以用户
                改了设置之后，留在旧默认路径上的会话仍然可以一键迁过去。 */}
            {activeSession?.workdir &&
              !isSameWorkspacePath(activeSession.workdir, defaultWorkspacePath) && (
                <MenuItem onClick={handleClearWorkdir}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <ClearIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                    <Typography variant="body2">清除（回到默认工作空间）</Typography>
                  </Box>
                </MenuItem>
              )}
          </Menu>
        </>
      )}

      {/* 权限按钮：图标颜色随策略变化（绿=默认沙箱，橙=完全访问） */}
      <Button
        size="small"
        startIcon={
          fullAccess ? (
            <GppMaybeIcon fontSize="small" sx={{ color: 'warning.main' }} />
          ) : (
            <VerifiedUserIcon fontSize="small" sx={{ color: 'success.main' }} />
          )
        }
        onClick={(e) => setPermAnchor(e.currentTarget)}
        sx={{
          textTransform: 'none',
          color: 'text.secondary',
          fontSize: 12,
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
        }}
      >
        {fullAccess ? '完全访问' : toolApproval ? '逐条批准' : '默认权限'}
      </Button>

      {/* 执行模式按钮（FR-1.4）：不支持能力时整块隐藏，不留无效入口 */}
      {modesSupported && (
        <Button
          size="small"
          aria-label="切换执行模式"
          startIcon={currentMode.icon}
          onClick={(e) => setModeAnchor(e.currentTarget)}
          sx={{
            textTransform: 'none',
            color: 'text.secondary',
            fontSize: 12,
            '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
          }}
        >
          {currentMode.label}
        </Button>
      )}

      {/* 执行模式菜单 */}
      <Menu
        anchorEl={modeAnchor}
        open={!!modeAnchor}
        onClose={() => setModeAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 280 } } }}
      >
        {MODE_OPTIONS.map((opt) => (
          <MenuItem
            key={opt.value}
            selected={opt.value === mode}
            onClick={() => {
              setModeAnchor(null);
              setSessionMode(ensureSession(), opt.value);
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
              <Box sx={{ color: opt.value === mode ? 'primary.main' : 'text.secondary', mt: 0.1 }}>
                {opt.icon}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2">{opt.label}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {opt.caption}
                </Typography>
              </Box>
            </Box>
          </MenuItem>
        ))}
      </Menu>

      {/* 工作空间选择菜单随按钮一起条件渲染，见上方的 `showWorkspacePicker` */}

      {/* 权限设定弹层 */}
      <Popover
        open={!!permAnchor}
        anchorEl={permAnchor}
        onClose={() => setPermAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { p: 2, width: 320 } } }}
      >
        {/* 纯对话提示放在最前：它解释的是「下面两个开关为什么点不动」，
            排在后面会让人先看到置灰的控件再去找原因 */}
        {plainChatNotice && (
          <>
            <Typography variant="body2" sx={{ color: 'warning.main', lineHeight: 1.7 }}>
              {plainChatNotice}
            </Typography>
            <Divider sx={{ my: 1.5 }} />
          </>
        )}
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {fullAccess
            ? '当前为完全访问，AI 将在工作空间外直接执行操作，不再逐一请求你的允许。'
            : toolApproval
              ? '当前为逐条批准：写文件 / 执行命令等改动环境的操作，会在执行前暂停并请你确认。'
              : '当前为默认权限，操作在安全沙箱约束内进行，超出范围会被引擎拒绝。'}
        </Typography>
        <Divider sx={{ my: 1.5 }} />
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 1,
          }}
        >
          <Box>
            <Typography variant="body2" fontWeight={600}>
              逐条批准工具调用
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              只读操作自动放行；超时未响应按拒绝处理。
            </Typography>
          </Box>
          <Switch
            size="small"
            checked={toolApproval && !fullAccess}
            // 模型不能调工具时这个开关没有对象（`fullAccess` 时同理，但那是另一个原因）
            disabled={fullAccess || plainChatNotice !== null}
            onChange={(e) => {
              setSessionToolApproval(ensureSession(), e.target.checked);
            }}
          />
        </Box>
        <Divider sx={{ my: 1.5 }} />
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 1,
          }}
        >
          <Box>
            <Typography variant="body2" fontWeight={600}>
              允许完全访问
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              更粗的开关：开启后不再逐条询问。
            </Typography>
          </Box>
          <Switch
            size="small"
            checked={fullAccess}
            onChange={(e) => {
              setSessionFullAccess(ensureSession(), e.target.checked);
            }}
          />
        </Box>
      </Popover>
    </>
  );
}
