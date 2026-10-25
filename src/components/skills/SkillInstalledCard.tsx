import { useState } from 'react';
import { Box, Card, CardContent, Checkbox, IconButton, Stack, Switch, Tooltip, Typography } from '@mui/material';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import { SkillIcon } from './SkillIcon';
import { SkillActionMenu } from './SkillActionMenu';
import {
  skillCardActionsSx,
  skillCardIconButtonSx,
  skillDescSx,
  skillHintTooltipSx,
  skillInstalledCardSx,
  skillMenuAttentionSx,
  skillPinnedActiveSx,
  skillSwitchSx,
} from './skillCardSx';
import {
  SKILL_OVERRIDE_OFF,
  SKILL_OVERRIDE_USER_INVOCABLE_ONLY,
  resolveSkillOverride,
} from '@/lib/agent/skillOverrides';
import {
  autoTriggerHint,
  isAutoTriggerOn,
  nextAutoTriggerOverride,
  overrideToast,
} from './skillMeta';
import { toast } from '@/components/Toast';
import type { Skill, SkillOverride } from '@/types';

/**
 * 「我安装的」技能卡（参考样式：图标 + 名称 + 右侧开关，描述两行）。
 *
 * ## 右上角是三个不同的东西，别把它们揉在一起
 *
 * - **开关**（常驻）：自动触发是否开启 ⇔ `override === 'on'`（模型可见）。
 *   关掉它落到**中间档**（模型看不到、你自己还能挂载），**不是** `off` ——
 *   开关自己的悬停文案就是这么承诺的（「关闭自动触发后…仅支持手动触发」）。
 *   判据是 `isAutoTriggerOn`，与 ⋯ 菜单里那一档的对勾**同源**，所以两边不会各说各话。
 * - **⋯ 菜单**（hover / 键盘聚焦才显形）：动作收纳，底部的三行是完整的档位单选 ——
 *   `off`（停用：模型和你都用不了）只有那里能选到，开关上没有这个位置。
 * - **置顶**：只改这份列表的顺序（纯本地偏好，不推引擎）。
 *
 * 三态里的中间档没有独立按钮，所以 `user-invocable-only` 时 ⋯ 会变色
 * （`skillMenuAttentionSx`）：卡片上必须留一处痕迹，否则「模型看不见」这件事
 * 只有事后（模型答不出某个技能）才会被发现。
 *
 * ## 为什么「置顶」排在第二位而不是最后
 *
 * 顺序照参考样式：⋯ 在最前（动作收纳的位置固定，用户肌肉记忆在右上角），
 * 置顶紧邻它，开关永远在最右（它是常驻控件，要和 hover 才出现的东西分开，
 * 否则鼠标划过时开关会被挤动）。
 *
 * ## 停用后卡片仍然留在列表里
 *
 * 停用只是「关掉自动触发」，技能本身还在磁盘上。直接从列表里抹掉会让用户
 * 无法原地重新启用，只剩「去市场再装一次」这条别扭的路径。因此停用态只是
 * 整体压暗，开关仍在原位置可点。
 *
 * 整卡可点 → 打开详情；开关与图标按钮是卡内独立操作，必须 `stopPropagation`，
 * 否则点一下开关会顺带弹出详情。
 */
export function SkillInstalledCard({
  skill,
  pinned = false,
  selectable = false,
  selected = false,
  onSelect,
  onSetOverride,
  onTogglePin,
  onUninstall,
  onOpenDetail,
}: {
  skill: Skill;
  /** 是否已置顶（排序状态由页面持有，卡片只负责显示与触发） */
  pinned?: boolean;
  /** 批量管理模式：整卡改为「勾选」而不是「打开详情」 */
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: string) => void;
  onSetOverride: (id: string, override: SkillOverride) => void;
  onTogglePin: (id: string) => void;
  onUninstall: (skill: Skill) => void;
  onOpenDetail: (skill: Skill) => void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const override = resolveSkillOverride(skill);
  const enabled = override !== SKILL_OVERRIDE_OFF;
  const manualOnly = override === SKILL_OVERRIDE_USER_INVOCABLE_ONLY;
  /** 开关位置：与 ⋯ 菜单里那一档的对勾同源（`override === 'on'`），不允许各算一套 */
  const autoTrigger = isAutoTriggerOn(skill);

  const handleSwitch = () => {
    // 下一个档位与反馈文案都取自 skillMeta：详情窗口有同一个开关的另一个入口，
    // 两处各写一遍必然漂移。文案按**落点**说话 —— 关掉开关落到的是中间档
    // （仍可手动调用），不是停用，这两件事说混了用户就不敢关
    const next = nextAutoTriggerOverride(skill);
    onSetOverride(skill.id, next);
    toast.success(overrideToast(skill.name, next));
  };

  const handleCardClick = () => {
    if (selectable) onSelect?.(skill.id);
    else onOpenDetail(skill);
  };

  return (
    <Card
      sx={[
        skillInstalledCardSx,
        {
          // 停用态压暗但不隐藏：用户要能原地重新打开它
          opacity: enabled ? 1 : 0.55,
          // 选中态给一层描边，批量操作时能一眼看出选了哪些
          borderColor: selected ? 'var(--hover-border)' : 'transparent',
        },
      ]}
      role="button"
      tabIndex={0}
      aria-label={`${skill.name} 详情`}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCardClick();
        }
      }}
    >
      <CardContent sx={{ p: 1.75, '&:last-child': { pb: 1.75 } }}>
        <Stack direction="row" alignItems="center" spacing={1.25}>
          {selectable && (
            <Checkbox
              size="small"
              checked={selected}
              tabIndex={-1}
              inputProps={{ 'aria-label': `选择 ${skill.name}` }}
              onClick={(e) => e.stopPropagation()}
              onChange={() => onSelect?.(skill.id)}
              sx={{ p: 0.25, ml: -0.5 }}
            />
          )}
          <SkillIcon name={skill.name} icon={skill.icon} />
          <Typography
            fontWeight={600}
            noWrap
            sx={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.5 }}
            title={skill.name}
          >
            {skill.name}
          </Typography>
          <Stack direction="row" alignItems="center" spacing={0.25}>
            {/* hover / 键盘聚焦才显形，见 skillInstalledCardSx */}
            <Box className="skill-card-actions" sx={skillCardActionsSx}>
              <Tooltip title={manualOnly ? '模型看不到它，菜单里可改回' : '更多操作'}>
                <IconButton
                  size="small"
                  aria-label={`${skill.name} 操作菜单`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuAnchor(e.currentTarget);
                  }}
                  sx={[skillCardIconButtonSx, manualOnly ? skillMenuAttentionSx : {}]}
                >
                  <MoreHorizIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
              {/*
               * 置顶只改列表顺序，因此刻意**不给 toast**：卡片会立刻挪到最前
               * （或回到原位），这个位移本身就是最清楚的反馈。再加一个右上角的
               * 浮层提示，反而要在「卡片动了」和「提示弹了」之间对一次账。
               */}
              <Tooltip title={pinned ? '取消置顶' : '置顶到最前'}>
                <IconButton
                  size="small"
                  aria-label={`${skill.name} 置顶`}
                  aria-pressed={pinned}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(skill.id);
                  }}
                  sx={[skillCardIconButtonSx, pinned ? skillPinnedActiveSx : {}]}
                >
                  {pinned ? (
                    <PushPinIcon sx={{ fontSize: 17 }} />
                  ) : (
                    <PushPinOutlinedIcon sx={{ fontSize: 17 }} />
                  )}
                </IconButton>
              </Tooltip>
            </Box>
            <Tooltip
              placement="bottom"
              title={autoTriggerHint(skill)}
              slotProps={{ tooltip: { sx: skillHintTooltipSx } }}
            >
              <Switch
                size="small"
                color="success"
                checked={autoTrigger}
                inputProps={{ 'aria-label': `${skill.name} 自动触发` }}
                onClick={(e) => e.stopPropagation()}
                onChange={handleSwitch}
                sx={skillSwitchSx}
              />
            </Tooltip>
          </Stack>
        </Stack>
        {/* 参考样式里已安装卡的描述给原生 tooltip 补全（市场卡则是 hover 展开），两者反馈方式不同是有意的 */}
        <Typography className="skill-desc" title={skill.description} sx={skillDescSx}>
          {skill.description}
        </Typography>
      </CardContent>
      <SkillActionMenu
        skill={skill}
        anchorEl={menuAnchor}
        onClose={() => setMenuAnchor(null)}
        onSetOverride={onSetOverride}
        onUninstall={onUninstall}
      />
    </Card>
  );
}
