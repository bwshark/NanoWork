import { useMemo, useState } from 'react';
import {
  Box,
  Dialog,
  IconButton,
  InputAdornment,
  ListItemButton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import { SETTINGS_NAV } from '@/components/settings/settingsNav';
import { AboutSection } from '@/components/settings/sections/AboutSection';
import { AccountSection } from '@/components/settings/sections/AccountSection';
import { AssistantSection } from '@/components/settings/sections/AssistantSection';
import { ConnectionSection } from '@/components/settings/sections/ConnectionSection';
import { DataSection } from '@/components/settings/sections/DataSection';
import { DiagnosticsSection } from '@/components/settings/sections/DiagnosticsSection';
import { GeneralSection } from '@/components/settings/sections/GeneralSection';
import { MemorySection } from '@/components/settings/sections/MemorySection';
import { ModelsSection } from '@/components/settings/sections/ModelsSection';
import { PersonaSection } from '@/components/settings/sections/PersonaSection';
import { PluginsSection } from '@/components/settings/sections/PluginsSection';
import { SecuritySection } from '@/components/settings/sections/SecuritySection';
import { ShortcutsSection } from '@/components/settings/sections/ShortcutsSection';
import { UsageSection } from '@/components/settings/sections/UsageSection';
import { VoiceSection } from '@/components/settings/sections/VoiceSection';
import {
  useSettingsUiStore,
  type SettingsSectionId,
} from '@/stores/settingsUiStore';

/**
 * 设置弹窗：**左侧配置项菜单 + 右侧具体配置**（对齐 WorkBuddy 的设置窗口）。
 *
 * 为什么从「整页路由」改成「弹窗」：
 *
 * 1. 设置是**打断式**操作——用户改完某项就回到原处继续干活。做成路由页意味着
 *    离开会话、改完、再点回来，中间还得自己记得原来在哪；弹窗天然保留上下文。
 * 2. 分区之间是**同级并列**关系（都挂在「配置」之下），不是「一个页面里的 Tab」。
 *    路由页只有一个 URL，翻分区要么改 query 要么丢状态；弹窗内一个 `section`
 *    state 就够了，也不必把内部分区暴露给外部的路由表。
 * 3. 侧边栏因此能瘦下来：原先「记忆 / 人格 / 助理 / 插件」四个一级入口占的是
 *    **日常操作区**，而它们的使用频率是「配一次，很久不动」。
 *
 * 内容区按 `section` **只挂载当前分区**：四个分区里有三个会读盘加载（记忆正文、
 * 身份文件、插件目录），全挂载等于每次开设置都扫一遍磁盘。
 */
export function SettingsDialog() {
  const open = useSettingsUiStore((s) => s.open);
  const section = useSettingsUiStore((s) => s.section);
  const closeSettings = useSettingsUiStore((s) => s.closeSettings);
  const setSection = useSettingsUiStore((s) => s.setSection);

  const [query, setQuery] = useState('');

  /**
   * 按名字过滤左侧菜单（只过滤菜单，不改右侧内容）。
   *
   * 分区已经到 15 个，靠肉眼在一条竖排里找「用量」「诊断」开始变慢；
   * 过滤菜单是零风险的最小实现——搜索不会让任何分区消失，只是把不相关的收起来。
   */
  const filteredGroups = useMemo(() => {
    const keyword = query.trim();
    if (keyword === '') return SETTINGS_NAV;
    return SETTINGS_NAV.map((group) => ({
      ...group,
      items: group.items.filter((item) => item.label.includes(keyword)),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  return (
    <Dialog
      open={open}
      onClose={closeSettings}
      maxWidth={false}
      // 弹窗自身不做内边距：左右两栏要贴边，内边距由各自内部给
      PaperProps={{
        sx: {
          width: 920,
          height: 640,
          maxWidth: '94vw',
          maxHeight: '88vh',
          // 16px：参考图的弹窗是"大面板"而不是"对话框"，圆角太大（24px）会显得像个气泡
          borderRadius: 2,
          overflow: 'hidden',
          display: 'flex',
          // ⚠️ 必须显式声明方向。MUI 的 `MuiDialog-paper`（`scroll="paper"`，即默认值）
          // 自带 `display:flex; flex-direction:column`，而本组 sx 只覆盖 `display` ——
          // 剩下的 column 会留下来，于是左右两栏变成**上下堆叠**：左侧菜单 height:100%
          // 吃掉 640px 全部高度，右侧内容区被 flex:1 压成 0 高，再被 overflow:hidden 裁掉。
          // 现象就是「左边灰条通高、右边只剩一片背景色」。
          flexDirection: 'row',
        },
      }}
      aria-label="设置"
    >
      {/* —— 左侧：配置项菜单 —— */}
      <Box
        component="nav"
        aria-label="配置项"
        sx={{
          width: 216,
          flexShrink: 0,
          height: '100%',
          overflowY: 'auto',
          /*
           * 侧栏与内容区**同色**（`background.default`），只用一条发丝线分隔。
           *
           * 原来用 `action.hover`：那是一层白色叠加，深色主题下会把侧栏提亮成
           * 一整块浅灰面板，比弹窗主体还抢眼——参考图里侧栏是"退到背景里"的，
           * 只有选中项和 hover 才浮起来。
           */
          bgcolor: 'background.default',
          borderRight: '1px solid',
          borderColor: 'divider',
          px: 1.25,
          py: 1.5,
        }}
      >
        {/* 顶部是搜索框而不是「设置」大标题：弹窗自己就是设置，再写一遍只是占高度。
            参考图同款布局，且分区一多（现在 15 个）之后，按名字过滤是唯一快的找法。 */}
        <TextField
          size="small"
          fullWidth
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索设置项"
          aria-label="搜索设置项"
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
              </InputAdornment>
            ),
          }}
          sx={{
            px: 0.5,
            pb: 1.5,
            '& .MuiOutlinedInput-root': {
              fontSize: 13,
              borderRadius: 2,
              bgcolor: 'background.paper',
            },
            // 搜索框在左侧栏里是「工具」而不是表单字段：不画外框，靠面色区分
            '& .MuiOutlinedInput-notchedOutline': { borderColor: 'transparent' },
          }}
        />

        {filteredGroups.length === 0 && (
          <Typography sx={{ px: 1.5, pt: 1, fontSize: 12.5, color: 'text.disabled' }}>
            没有匹配的设置项
          </Typography>
        )}

        {filteredGroups.map((group, gi) => (
          <Box key={group.label ?? `group-${gi}`} sx={{ mb: 1 }}>
            {group.label && (
              <Typography
                sx={{
                  px: 1.5,
                  pt: 1,
                  pb: 0.5,
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: 'text.secondary',
                }}
              >
                {group.label}
              </Typography>
            )}
            {group.items.map((item) => {
              const active = item.id === section;
              return (
                <ListItemButton
                  key={item.id}
                  selected={active}
                  onClick={() => setSection(item.id)}
                  sx={{
                    borderRadius: 2,
                    // 参考图一项约 36~40px 高：太紧会让 15 个分区挤成一片，
                    // 扫读时找不到落点
                    py: 1,
                    mb: 0.25,
                    gap: 1.25,
                    color: active ? 'text.primary' : 'text.secondary',
                    // 选中项比侧栏底色**亮**一档（`action.selected`）。
                    // 原来用 `background.paper`：在 `action.hover` 的底上它反而是**暗**的，
                    // 看起来像被压下去而不是被选中。
                    '&.Mui-selected': {
                      bgcolor: 'action.selected',
                      '&:hover': { bgcolor: 'action.selected' },
                    },
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      color: 'inherit',
                      '& .MuiSvgIcon-root': { fontSize: 18 },
                    }}
                  >
                    {item.icon}
                  </Box>
                  <Typography
                    sx={{
                      fontSize: 13.5,
                      fontWeight: active ? 600 : 500,
                      color: 'inherit',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.label}
                  </Typography>
                </ListItemButton>
              );
            })}
          </Box>
        ))}
      </Box>

      {/* —— 右侧：当前分区的具体配置 —— */}
      <Box
        sx={{
          position: 'relative',
          flex: 1,
          minWidth: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.default',
        }}
      >
        {/*
         * 关闭按钮**浮在**内容区右上角，不再占一条标题栏。
         *
         * 参考图里右侧从第一个分组标题（「常规」）直接开始，没有「通用」那样一条
         * 带下边框的大标题——分区身份由左侧菜单的高亮承担，重复一遍只是占高度。
         * 内容区顶部留出的 padding（见下方 `pt`）就是给这颗按钮避让用的。
         */}
        <Tooltip title="关闭设置">
          <IconButton
            size="small"
            aria-label="关闭设置"
            onClick={closeSettings}
            sx={{ position: 'absolute', top: 6, right: 6, zIndex: 2 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        {/* key={section}：切分区时重挂载滚动容器，让每次进入新分区都从顶部开始。
            不这么做的话滚动位置会跨分区继承——在「连接」拉到一半再切到「关于」，
            会直接落在半空中。 */}
        <Box
          key={section}
          sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3.5, pt: 3, pb: 3 }}
        >
          <SectionBody section={section} />
        </Box>
      </Box>
    </Dialog>
  );
}

/** 分区 → 组件。集中在一处，避免在 JSX 里堆一串三元表达式 */
function SectionBody({ section }: { section: SettingsSectionId }) {
  switch (section) {
    case 'general':
      return <GeneralSection />;
    case 'shortcuts':
      return <ShortcutsSection />;
    case 'connection':
      return <ConnectionSection />;
    case 'memory':
      return <MemorySection />;
    case 'persona':
      return <PersonaSection />;
    case 'models':
      return <ModelsSection />;
    case 'voice':
      return <VoiceSection />;
    case 'assistant':
      return <AssistantSection />;
    case 'plugins':
      return <PluginsSection />;
    case 'security':
      return <SecuritySection />;
    case 'data':
      return <DataSection />;
    case 'usage':
      return <UsageSection />;
    case 'diagnostics':
      return <DiagnosticsSection />;
    case 'account':
      return <AccountSection />;
    case 'about':
      return <AboutSection />;
    default: {
      // 穷尽性检查：`section` 是联合类型，走到这里类型为 never。
      // 将来给 SettingsSectionId 加成员却忘了挂组件时，编译期就会报错，
      // 而不是运行期安静地渲染一片空白（这正是「左侧有菜单、右侧全空」最难查的形态）。
      const unhandled: never = section;
      void unhandled;
      return null;
    }
  }
}
