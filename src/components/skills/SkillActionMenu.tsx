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
  SKILL_OVERRIDES,
  resolveSkillOverride,
} from '@/lib/skillOverrides';
import {
  SKILL_OVERRIDE_MENU_LABEL,
  overrideToast,
  skillFileTargets,
  skillMenuOrigin,
  skillUninstallBlockReason,
} from './skillMeta';
import type { Skill, SkillOverride } from '@/types';

/**
 * 技能「⋯」菜单：卡片上放不下的动作收在这里。
 *
 * ## 底部三行是**同一个字段的单选**（不是三行各管一档的动作）
 *
 * `override` 有三档，而界面上那个开关只有两个位置 —— 它管「自动触发」（`on` ⇄
 * `user-invocable-only`）。所以菜单是唯一能选到 `off`（停用：模型和你都用不了）的
 * 入口，三档必须**成组出现**：文案固定写档位名，对勾只落在当前那一档上。
 *
 * 这三行与开关、以及卡片上的开关，读的都是同一个 `override`，判据分别来自
 * `skillMeta.isAutoTriggerOn`（开关位置）与 `resolveSkillOverride`（对勾位置），
 * 不允许任何一处另写一套判断 —— 一旦分叉，用户就会看到「开关开着、菜单说仅手动调用」。
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
       * 三档覆盖（FR-3.1）成组出现 —— 这是唯一能选到全部三档的地方（见文件头注释）。
       * 每行固定写**档位名**、对勾只落在当前档上：文案与对勾必须说同一件事。
       * 旧实现是一行兼两用（文案＝「点了会变成什么」、对勾＝「现在在哪一档」），
       * 于是中间档下会渲染成 `✓ 完全启用（模型可见）`，而模型其实看不见这个技能。
       */}
      {SKILL_OVERRIDES.map((value) => {
        const current = value === override;
        return (
          <MenuRow
            key={value}
            radio
            checked={current}
            icon={
              current ? (
                <CheckIcon sx={{ fontSize: 16 }} />
              ) : (
                <Box sx={{ width: 16, height: 16 }} />
              )
            }
            label={SKILL_OVERRIDE_MENU_LABEL[value]}
            onClick={() => {
              close();
              // 点当前档是空操作：不改状态，也不该弹一条「已停用」的假提示
              if (current) return;
              onSetOverride(skill.id, value);
              toast.success(overrideToast(skill.name, value));
            }}
          />
        );
      })}
    </Menu>
  );
}

/** 菜单行：16px 图标槽 + 文案 + 右侧原因说明（对齐由固定图标槽保证） */
function MenuRow({
  icon,
  label,
  hint,
  disabled,
  radio,
  checked,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  /**
   * 三档那种「单选行」用 `menuitemradio` + `aria-checked`。
   *
   * 不用普通 `menuitem` + 视觉对勾：屏幕阅读器只能念出「完全启用」，念不出
   * 「这一档是当前档」，而「当前在哪一档」正是这组行唯一要表达的信息。
   */
  radio?: boolean;
  checked?: boolean;
  onClick: () => void;
}) {
  return (
    <MenuItem
      disabled={disabled}
      role={radio ? 'menuitemradio' : undefined}
      aria-checked={radio ? !!checked : undefined}
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
