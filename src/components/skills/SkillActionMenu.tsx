import { Box, Divider, Menu, MenuItem, Typography } from '@mui/material';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CheckIcon from '@mui/icons-material/Check';
import { useNavigate } from 'react-router-dom';
import { platform } from '@/platform';
import { toast } from '@/components/Toast';
import { ROUTES } from '@/lib/constants';
import {
  SKILL_OVERRIDE_ON,
  SKILL_OVERRIDE_USER_INVOCABLE_ONLY,
  resolveSkillOverride,
} from '@/lib/skillOverrides';
import { skillFileTargets, skillMenuOrigin, skillUninstallBlockReason } from './skillMeta';
import type { Skill, SkillOverride } from '@/types';

/**
 * 技能「⋯」菜单：卡片上放不下的动作收在这里。
 *
 * ## 不可用的条目**显示但禁用**，并写出原因
 *
 * 「卸载」对内置技能没有意义（删了下次启动就回来）、「编辑 / 打开文件夹」
 * 在 Web 端做不到 —— 直接隐藏这些条目会让用户以为功能不存在，
 * 而 WorkBuddy 的菜单里它们是常驻的。所以保留条目、置灰，
 * 并在右侧给一句**具体**的原因（「内置不可卸载」而不是「不可用」）。
 *
 * ## 对齐方向按 context 分两套
 *
 * 「⋯」在两个入口离容器右缘的距离完全不同，同一套对齐必然有一边是错的，
 * 所以对齐参数走 `skillMenuOrigin(context)`（判据、实测数字与理由都在那边，
 * 并有单测守住「卡片右对齐 / 窗口左对齐」）。这里只负责把结果交给 Menu。
 *
 * 竖向都是 `bottom` → `top`（贴着按钮下沿往下展开），窗口里另加 4px 间距，
 * 避免纸张与按钮贴死。
 */
export function SkillActionMenu({
  skill,
  context = 'card',
  anchorEl,
  onClose,
  onSetOverride,
  onUninstall,
}: {
  skill: Skill;
  /**
   * 菜单出现在哪里：卡片上 / 详情窗口里。
   *
   * 差别有两条 —— 少一个「去对话」（窗口头部已有「去试试」，挂载 + 跳转，
   * 再留一个不挂载的「去对话」会让两个入口看起来是同一件事却结果不同），
   * 以及水平对齐方向（见上方注释）。
   */
  context?: 'card' | 'window';
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onSetOverride: (id: string, override: SkillOverride) => void;
  onUninstall: (skill: Skill) => void;
}) {
  const navigate = useNavigate();
  const override = resolveSkillOverride(skill);
  const inMiddleState = override === SKILL_OVERRIDE_USER_INVOCABLE_ONLY;
  const uninstallBlock = skillUninstallBlockReason(skill);
  const { dir, md } = skillFileTargets(skill);
  const localDisabled = platform.env !== 'electron' || !skill.path;

  const close = () => onClose();

  const openPath = async (target: string | undefined, label: string) => {
    if (!target) return;
    const result = await platform.openPath(target);
    if (!result.ok) toast.error(`${label}失败：${result.error ?? '未知原因'}`);
  };

  const inWindow = context === 'window';
  // 对齐方向由几何决定（卡片右对齐 / 窗口左对齐），判据与理由见 skillMenuOrigin
  const { anchorOrigin, transformOrigin } = skillMenuOrigin(context);

  return (
    <Menu
      anchorEl={anchorEl}
      open={!!anchorEl}
      onClose={close}
      transformOrigin={transformOrigin}
      anchorOrigin={anchorOrigin}
      // Paper 是 Popover 的根元素，给它 margin 就是给整张纸留出与按钮的间距
      PaperProps={inWindow ? { sx: { mt: 0.5 } } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      {context === 'card' && (
        <MenuRow
          icon={<ChatBubbleOutlineIcon sx={{ fontSize: 16 }} />}
          label="去对话"
          onClick={() => {
            close();
            void navigate(ROUTES.chat);
          }}
        />
      )}
      <MenuRow
        icon={<EditOutlinedIcon sx={{ fontSize: 16 }} />}
        label="编辑"
        disabled={localDisabled}
        hint={localDisabled ? (platform.env !== 'electron' ? '仅桌面端' : '无本地文件') : undefined}
        onClick={() => {
          close();
          void openPath(md, '打开技能文件');
        }}
      />
      <MenuRow
        icon={<FolderOpenIcon sx={{ fontSize: 16 }} />}
        label="打开文件夹"
        disabled={localDisabled}
        hint={localDisabled ? (platform.env !== 'electron' ? '仅桌面端' : '无本地文件') : undefined}
        onClick={() => {
          close();
          void openPath(dir, '打开技能目录');
        }}
      />
      <MenuRow
        icon={<DeleteOutlineIcon sx={{ fontSize: 16 }} />}
        label="卸载"
        disabled={!!uninstallBlock}
        hint={uninstallBlock ?? undefined}
        onClick={() => {
          close();
          onUninstall(skill);
        }}
      />
      <Divider sx={{ my: 0.5 }} />
      {/*
       * 三态覆盖的中间档（FR-3.1）在这里落脚。
       * 卡片上的开关只能表达「能不能用」，而 `user-invocable-only`
       * （用户能唤起、模型看不见）用开关表达不出来 —— 塞进开关会让用户
       * 以为只有两种状态，所以它必须有一个能写文案的入口。
       */}
      <MenuRow
        icon={
          inMiddleState ? (
            <CheckIcon sx={{ fontSize: 16 }} />
          ) : (
            <Box sx={{ width: 16, height: 16 }} />
          )
        }
        label={inMiddleState ? '完全启用（模型可见）' : '仅手动调用（模型不可见）'}
        onClick={() => {
          close();
          onSetOverride(skill.id, inMiddleState ? SKILL_OVERRIDE_ON : SKILL_OVERRIDE_USER_INVOCABLE_ONLY);
        }}
      />
    </Menu>
  );
}

/** 菜单行：16px 图标槽 + 文案 + 右侧原因说明（对齐由固定图标槽保证） */
function MenuRow({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <MenuItem
      disabled={disabled}
      onClick={onClick}
      sx={{ fontSize: 13, minWidth: 220, display: 'flex', alignItems: 'center', gap: 1 }}
    >
      <Box
        component="span"
        sx={{
          width: 16,
          flexShrink: 0,
          display: 'flex',
          color: disabled ? 'text.disabled' : 'text.secondary',
        }}
      >
        {icon}
      </Box>
      <Box component="span" sx={{ flex: 1 }}>
        {label}
      </Box>
      {hint && (
        <Typography component="span" sx={{ fontSize: 11.5, color: 'text.disabled' }}>
          {hint}
        </Typography>
      )}
    </MenuItem>
  );
}
