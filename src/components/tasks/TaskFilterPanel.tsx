/**
 * 任务筛选面板（窗口标题栏「筛选任务」漏斗图标的下拉）。
 *
 * 只做两件事：写 `taskQueryStore.filters`、在需要时重置它。筛选**结果**不在这里算——
 * 侧边栏列表与居中搜索窗各自订阅同一份 `filters` 后调 `filterTasks`，
 * 面板只负责「改条件」，避免三个组件各持一份派生结果而互相漂移。
 *
 * 面板锚在漏斗图标上（`anchorEl` 由标题栏传入并控制 `open`）：
 * 不用 Menu 是因为它自带键盘导航与关闭副作用，而这里希望「点选项后面板不关」，
 * 便于连续调整状态 + 时间两个维度。
 */
import { useMemo, type ReactNode } from 'react';
import { Box, Divider, MenuItem, Popover, Typography } from '@mui/material';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import CheckIcon from '@mui/icons-material/Check';
import { TASK_STATUS_OPTIONS, TASK_TIME_OPTIONS } from '@/lib/task/taskQuery';
import {
  DEFAULT_WORKSPACE_LABEL,
  isSameWorkspacePath,
  resolveWorkspaceLabel,
} from '@/lib/workspace/workspaceLabel';
import { UNBOUND_AGENT_LABEL } from '@/lib/core/constants';
import { useTaskQueryStore } from '@/stores/taskQueryStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useDefaultWorkspacePath } from '@/stores/storageInfoStore';

interface TaskFilterPanelProps {
  /** 锚点元素（漏斗图标按钮）；null 时面板不显示 */
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
}

export function TaskFilterPanel({ anchorEl, open, onClose }: TaskFilterPanelProps) {
  const filters = useTaskQueryStore((s) => s.filters);
  const setStatusFilter = useTaskQueryStore((s) => s.setStatusFilter);
  const setTimeFilter = useTaskQueryStore((s) => s.setTimeFilter);
  const setAgentFilter = useTaskQueryStore((s) => s.setAgentFilter);
  const setWorkspaceFilter = useTaskQueryStore((s) => s.setWorkspaceFilter);
  const resetFilters = useTaskQueryStore((s) => s.resetFilters);

  // 工作空间 / Agent 选项是**动态**的：前者从现有会话推导（与侧边栏分组键同源），
  // 后者来自 Agent 目录；两者都带一个「全部」项。
  const sessions = useSessionsStore((s) => s.sessions);
  const agents = useAgentsStore((s) => s.agents);
  const aliases = useSettingsStore((s) => s.settings.workspaceAliases);
  const defaultWorkspacePath = useDefaultWorkspacePath();

  const workspaceOptions = useMemo(() => {
    const labels = new Map<string, string>();
    for (const s of sessions) {
      const key = isSameWorkspacePath(s.workdir, defaultWorkspacePath) ? '' : (s.workdir ?? '');
      if (!labels.has(key)) {
        const label =
          key === '' ? DEFAULT_WORKSPACE_LABEL : resolveWorkspaceLabel(key, aliases);
        labels.set(key, label);
      }
    }
    const items = Array.from(labels.entries()).map(([value, label]) => ({ value, label }));
    // 默认工作空间排在最前（与侧边栏置底相反：这里是筛选清单，置顶更易点选）
    items.sort((a, b) => {
      if (a.value === '' && b.value !== '') return -1;
      if (a.value !== '' && b.value === '') return 1;
      return a.label.localeCompare(b.label, 'zh-Hans-CN');
    });
    return [{ value: 'all', label: '全部工作空间' }, ...items];
  }, [sessions, aliases, defaultWorkspacePath]);

  const agentOptions = useMemo(() => {
    const items = agents.map((a) => ({ value: a.id, label: a.name }));
    items.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
    return [
      { value: 'all', label: '全部 Agent' },
      { value: '', label: UNBOUND_AGENT_LABEL },
      ...items,
    ];
  }, [agents]);

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{
        paper: {
          sx: {
            mt: 0.5,
            width: 216,
            borderRadius: 1.5,
            bgcolor: 'background.paper',
            backgroundImage: 'none',
            border: '1px solid',
            borderColor: 'divider',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
            overflow: 'hidden',
          },
        },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1.5,
          pt: 1.25,
          pb: 0.75,
        }}
      >
        <FilterAltOutlinedIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>筛选</Typography>
      </Box>

      <FilterGroupLabel>筛选状态</FilterGroupLabel>
      {TASK_STATUS_OPTIONS.map((option) => (
        <FilterOptionRow
          key={option.value}
          label={option.label}
          selected={filters.status === option.value}
          onSelect={() => setStatusFilter(option.value)}
        />
      ))}

      <Divider sx={{ my: 0.75, borderColor: 'divider' }} />

      <FilterGroupLabel>筛选时间</FilterGroupLabel>
      {TASK_TIME_OPTIONS.map((option) => (
        <FilterOptionRow
          key={option.value}
          label={option.label}
          selected={filters.time === option.value}
          onSelect={() => setTimeFilter(option.value)}
        />
      ))}

      <Divider sx={{ my: 0.75, borderColor: 'divider' }} />

      <FilterGroupLabel>筛选工作空间</FilterGroupLabel>
      {workspaceOptions.map((option) => (
        <FilterOptionRow
          key={`ws:${option.value}`}
          label={option.label}
          selected={filters.workspace === option.value}
          onSelect={() => setWorkspaceFilter(option.value)}
        />
      ))}

      <Divider sx={{ my: 0.75, borderColor: 'divider' }} />

      <FilterGroupLabel>筛选 Agent</FilterGroupLabel>
      {agentOptions.map((option) => (
        <FilterOptionRow
          key={`agent:${option.value}`}
          label={option.label}
          selected={filters.agentId === option.value}
          onSelect={() => setAgentFilter(option.value)}
        />
      ))}

      <Divider sx={{ my: 0.75, borderColor: 'divider' }} />

      {/* 重置只清状态与时间（关键词由关闭搜索窗清），所以文案是「重置筛选条件」而非「清除全部」 */}
      <MenuItem
        onClick={resetFilters}
        sx={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          px: 1.75,
          py: 1.1,
          color: 'text.secondary',
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
        }}
      >
        <Typography sx={{ fontSize: 13 }}>重置筛选条件</Typography>
      </MenuItem>
    </Popover>
  );
}

/** 分组小标题（筛选状态 / 筛选时间） */
function FilterGroupLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      sx={{ px: 1.75, pt: 0.75, pb: 0.25, fontSize: 11.5, color: 'text.secondary' }}
    >
      {children}
    </Typography>
  );
}

/** 单个可选项：选中时加粗并在右侧显示对勾 */
function FilterOptionRow({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <MenuItem
      onClick={onSelect}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        px: 1.75,
        py: 0.8,
        textAlign: 'left',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <Typography
        noWrap
        sx={{
          flex: 1,
          minWidth: 0,
          fontSize: 13.5,
          fontWeight: selected ? 600 : 400,
          color: 'text.primary',
        }}
      >
        {label}
      </Typography>
      {selected && <CheckIcon sx={{ fontSize: 16, color: 'primary.main' }} />}
    </MenuItem>
  );
}
