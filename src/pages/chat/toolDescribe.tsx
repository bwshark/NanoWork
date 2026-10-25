import type { ReactNode } from 'react';
import BuildIcon from '@mui/icons-material/Build';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditNoteIcon from '@mui/icons-material/EditNote';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import PublicIcon from '@mui/icons-material/Public';
import ScheduleIcon from '@mui/icons-material/Schedule';
import SearchIcon from '@mui/icons-material/Search';
import TerminalIcon from '@mui/icons-material/Terminal';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { DELETE_FILE_TOOLS } from '@/lib/artifact/fileArtifact';
import type { ProcessToolRow } from '@/types';

/**
 * 工具调用 → 一行「工作步骤」描述。
 *
 * ## 为什么单独成模块
 *
 * 同一个动作有两处要显示：过程时间线的工具行（`ProcessView`）与审批门控留下的
 * 工具调用卡片（`ToolCallCard`）。两处各写一套动词/图标映射，必然慢慢长歪——
 * 同一句 `已写入 D:/…` 在时间线里是「已写入」、在卡片里变成「write_file」。
 * 收口成一份，两处才说的是同一种语言。
 */

export const ICON_SX = { fontSize: 14, color: 'text.secondary' };

export interface RowDesc {
  icon: ReactNode;
  /** 动词标签：已读取 / 已搜索 / 网页搜索 … */
  verb: string;
  /** 主信息（路径 / 查询 / 命令），路径类着链接蓝 */
  primary?: string;
  primaryBlue?: boolean;
  /** 次信息（如搜索目录） */
  secondary?: string;
}

/** 按优先键顺序取第一个非空字符串参数，兜底取任意字符串值 */
function argStr(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

/**
 * 工具名 + 参数 → 行描述（动词映射对齐 nanobot utils/tool_hints.py）；
 * status 供少数工具（如 cron）区分「正在… / 已…」文案。
 *
 * `exec` 的 `shell` 别名与删除类工具都要显式列出：`shell` 走默认分支时会原样
 * 打印工具名（用户看到的是 `shell rm -rf /` 这种半成品），而删除类工具若落到
 * 默认分支，一行「已删除 xxx」会退化成「delete_file xxx」——过程行现在承担了
 * 原先卡片的全部展示职责，动词缺失就直接可见。
 */
export function describeTool(
  tool: string,
  args: Record<string, unknown>,
  status?: ProcessToolRow['status'],
): RowDesc {
  switch (tool) {
    case 'read_file':
      return {
        icon: <VisibilityIcon sx={ICON_SX} />,
        verb: '已读取',
        primary: argStr(args, ['path', 'file_path']),
        primaryBlue: true,
      };
    case 'write_file':
      return {
        icon: <EditNoteIcon sx={ICON_SX} />,
        verb: '已写入',
        primary: argStr(args, ['path', 'file_path']),
        primaryBlue: true,
      };
    case 'edit':
    case 'edit_file':
      return {
        icon: <EditNoteIcon sx={ICON_SX} />,
        verb: '已编辑',
        primary: argStr(args, ['path', 'file_path']),
        primaryBlue: true,
      };
    case 'list_dir':
      return {
        icon: <FolderOpenIcon sx={ICON_SX} />,
        verb: '已浏览',
        primary: argStr(args, ['path']),
        primaryBlue: true,
      };
    case 'find_files':
      return {
        icon: <TravelExploreIcon sx={ICON_SX} />,
        verb: '已查找',
        primary: argStr(args, ['query', 'glob']),
        secondary: argStr(args, ['path']),
      };
    case 'grep':
      return {
        icon: <SearchIcon sx={ICON_SX} />,
        verb: '已搜索',
        primary: argStr(args, ['pattern']),
        secondary: argStr(args, ['path']),
      };
    case 'exec':
    case 'shell': {
      const cmd = argStr(args, ['command', 'cmd']);
      return {
        icon: <TerminalIcon sx={ICON_SX} />,
        verb: '已执行',
        primary: cmd && cmd.length > 72 ? `${cmd.slice(0, 71)}…` : cmd,
      };
    }
    case 'web_search':
    case 'x_search':
      return {
        icon: <PublicIcon sx={ICON_SX} />,
        verb: '网页搜索',
        primary: argStr(args, ['query']),
      };
    case 'web_fetch':
      return {
        icon: <PublicIcon sx={ICON_SX} />,
        verb: '已抓取',
        primary: argStr(args, ['url']),
        primaryBlue: true,
      };
    case 'cron': {
      // 卡片之外的兜底描述：成功的 add 行在 AssistantMessage 已被卡片接管，
      // 此处主要覆盖 running / error / 非 add 操作的场景。
      const action = typeof args.action === 'string' ? args.action : '';
      if (action === 'add') {
        return {
          icon: <ScheduleIcon sx={ICON_SX} />,
          verb: status === 'running' ? '正在创建定时任务' : '已创建定时任务',
          primary: argStr(args, ['name', 'message']),
        };
      }
      return {
        icon: <ScheduleIcon sx={ICON_SX} />,
        verb: '定时任务',
        primary: action || argStr(args, []),
      };
    }
    default: {
      // 删除类工具必须显式成句：它们现在是「收回产物」的触发点，
      // 用户看到「已删除 xxx」才知道那张产物卡片为什么消失了。
      if ((DELETE_FILE_TOOLS as readonly string[]).includes(tool)) {
        return {
          icon: <DeleteOutlineIcon sx={ICON_SX} />,
          verb: '已删除',
          primary: argStr(args, ['path', 'file_path']),
          primaryBlue: true,
        };
      }
      if (tool.startsWith('mcp_')) {
        const rest = tool.slice(4);
        const [server, fn] = rest.includes('__') ? rest.split('__', 2) : [rest, ''];
        return {
          icon: <BuildIcon sx={ICON_SX} />,
          verb: fn ? `${server}::${fn}` : tool,
          primary: argStr(args, []),
        };
      }
      return { icon: <BuildIcon sx={ICON_SX} />, verb: tool, primary: argStr(args, []) };
    }
  }
}
