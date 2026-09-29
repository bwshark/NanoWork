import { Children } from 'react';
import { Box, CircularProgress, Tooltip } from '@mui/material';
import BuildIcon from '@mui/icons-material/Build';
import EditNoteIcon from '@mui/icons-material/EditNote';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import PublicIcon from '@mui/icons-material/Public';
import ScheduleIcon from '@mui/icons-material/Schedule';
import SearchIcon from '@mui/icons-material/Search';
import TerminalIcon from '@mui/icons-material/Terminal';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { ReasoningBlock } from './ReasoningBlock';
import type { ProcessEvent, ProcessToolRow } from '@/types';

const ICON_SX = { fontSize: 14, color: 'text.secondary' };

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

interface RowDesc {
  icon: React.ReactNode;
  /** 动词标签：已读取 / 已搜索 / 网页搜索 … */
  verb: string;
  /** 主信息（路径 / 查询 / 命令），路径类着链接蓝 */
  primary?: string;
  primaryBlue?: boolean;
  /** 次信息（如搜索目录） */
  secondary?: string;
}

/** 工具名 + 参数 → 行描述（动词映射对齐 nanobot utils/tool_hints.py）；
 * status 供少数工具（如 cron）区分「正在… / 已…」文案 */
function describeTool(
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
    case 'exec': {
      const cmd = argStr(args, ['command']);
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

/** 工具执行行：图标 + 动词 + 主信息（路径蓝）+ 次信息 + 状态 */
function ToolRow({ row }: { row: ProcessToolRow }) {
  const d = describeTool(row.tool, row.args, row.status);
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        py: 0.4,
        fontSize: 13,
        color: 'text.secondary',
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{d.icon}</Box>
      <Box component="span" sx={{ flexShrink: 0 }}>
        {d.verb}
      </Box>
      {d.primary && (
        <Tooltip title={d.primary} enterDelay={600}>
          <Box
            component="span"
            sx={{
              // 文件路径 / URL 的链接蓝：用语义 token（浅/深色均有足够对比度）
              color: d.primaryBlue ? 'info.main' : 'text.secondary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {d.primary}
          </Box>
        </Tooltip>
      )}
      {d.secondary && (
        <Box
          component="span"
          sx={{
            color: 'text.disabled',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {d.secondary}
        </Box>
      )}
      {row.status === 'running' && (
        <CircularProgress size={9} sx={{ color: 'text.secondary', flexShrink: 0 }} />
      )}
      {row.status === 'error' && (
        <Box component="span" sx={{ color: 'error.main', flexShrink: 0 }}>
          失败
        </Box>
      )}
    </Box>
  );
}

/**
 * 过程时间线：把**深度思考段与工具执行行按到达顺序交错**渲染成一条流。
 *
 * 顺序由数据保证（store 按 SSE 事件到达顺序 push），这里只做「按序铺开」，
 * 于是渲染结果就是模型真实的动作序列：想过一轮 → 查了两个文件 → 又想了一轮 → 再读一个文件。
 *
 * **自己不做折叠、不设整体限高**——可见性由调用方决定（`AssistantMessage` 用
 * `Collapse unmountOnExit` 在「流式中铺开 / 结束后收起」之间切换）。
 * 之所以不在这一层折叠：折叠会连带把「深度思考」标记一起卸掉，
 * 思考在列表里就凭空消失了；整体限高又会让思考正文（自带 200px 上限与滚动）
 * 落进「滚动条套滚动条」的窘境。过程本身已经很轻：思考正文写完即卸载，
 * 工具行一行一条，不需要再靠折叠压长度。
 *
 * `children` 用于挂载同类别的次要信息（如工具调用卡片），让它们跟随时间线排列，
 * 而不是各自占据消息尾部。
 */
export function ProcessView({
  events,
  live,
  children,
}: {
  /** 已按到达顺序排好的过程事件（思考段与工具行交错） */
  events: ProcessEvent[];
  /** 所属消息是否仍在流式输出（只有流式中的最后一段思考会展开正文） */
  live: boolean;
  children?: React.ReactNode;
}) {
  // 末尾那段未闭合的思考才是「此刻仍在写」：只有它展开正文、转圈、自动贴底
  let liveReasoningId: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === 'reasoning' && !ev.closed) {
      liveReasoningId = ev.id;
      break;
    }
  }

  // 用 Children.count 而不是 `!children`：调用方传 `{arr.map(...)}` 时，
  // 空数组在 JS 里是**真值**，直接判 falsy 会渲染出一个空的过程容器。
  if (events.length === 0 && Children.count(children) === 0) return null;

  return (
    <Box sx={{ width: '100%', px: 0.5, pb: 0.5, minWidth: 0 }}>
      {events.map((ev) =>
        ev.kind === 'reasoning' ? (
          <ReasoningBlock
            key={ev.id}
            content={ev.content}
            live={live && ev.id === liveReasoningId}
          />
        ) : (
          <ToolRow key={ev.id} row={ev} />
        ),
      )}
      {children}
    </Box>
  );
}
