import { Box, Dialog, IconButton, ListItemButton, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { SETTINGS_NAV, SETTINGS_NAV_ITEMS } from '@/components/settings/settingsNav';
import { AboutSection } from '@/components/settings/sections/AboutSection';
import { AssistantSection } from '@/components/settings/sections/AssistantSection';
import { ConnectionSection } from '@/components/settings/sections/ConnectionSection';
import { DataSection } from '@/components/settings/sections/DataSection';
import { GeneralSection } from '@/components/settings/sections/GeneralSection';
import { MemorySection } from '@/components/settings/sections/MemorySection';
import { PersonaSection } from '@/components/settings/sections/PersonaSection';
import { PluginsSection } from '@/components/settings/sections/PluginsSection';
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

  const current = SETTINGS_NAV_ITEMS[section];

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
          borderRadius: 3,
          overflow: 'hidden',
          display: 'flex',
        },
      }}
      aria-label="设置"
    >
      {/* —— 左侧：配置项菜单 —— */}
      <Box
        component="nav"
        aria-label="配置项"
        sx={{
          width: 200,
          flexShrink: 0,
          height: '100%',
          overflowY: 'auto',
          bgcolor: 'action.hover',
          borderRight: '1px solid',
          borderColor: 'divider',
          px: 1,
          py: 1.5,
        }}
      >
        <Typography
          sx={{
            px: 1.5,
            pb: 1,
            fontSize: 13.5,
            fontWeight: 700,
            color: 'text.primary',
          }}
        >
          设置
        </Typography>

        {SETTINGS_NAV.map((group, gi) => (
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
                    py: 0.75,
                    mb: 0.25,
                    gap: 1.25,
                    color: active ? 'text.primary' : 'text.secondary',
                    '&.Mui-selected': {
                      bgcolor: 'background.paper',
                      boxShadow: '0 1px 2px rgba(15,23,42,0.08)',
                      '&:hover': { bgcolor: 'background.paper' },
                    },
                    '&:hover': { bgcolor: 'action.selected' },
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
                      fontSize: 13,
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
          flex: 1,
          minWidth: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.default',
        }}
      >
        <Box
          sx={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 2.5,
            py: 1.5,
            borderBottom: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Typography sx={{ fontSize: 15, fontWeight: 700 }}>
            {current?.label}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="关闭设置">
            <IconButton size="small" aria-label="关闭设置" onClick={closeSettings}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 2.5, py: 2.5 }}>
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
    case 'connection':
      return <ConnectionSection />;
    case 'memory':
      return <MemorySection />;
    case 'persona':
      return <PersonaSection />;
    case 'assistant':
      return <AssistantSection />;
    case 'plugins':
      return <PluginsSection />;
    case 'data':
      return <DataSection />;
    case 'about':
      return <AboutSection />;
    default:
      return null;
  }
}
