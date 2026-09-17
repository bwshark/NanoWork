import { useState } from 'react';
import { Box, Card, CardContent, Checkbox, IconButton, Stack, Switch, Tooltip, Typography } from '@mui/material';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import { SkillIcon } from './SkillIcon';
import { SkillActionMenu } from './SkillActionMenu';
import {
  skillCardActionsSx,
  skillCardIconButtonSx,
  skillDescSx,
  skillInstalledCardSx,
  skillManualOnlyActiveSx,
  skillSwitchSx,
} from './skillCardSx';
import {
  SKILL_OVERRIDE_OFF,
  SKILL_OVERRIDE_ON,
  SKILL_OVERRIDE_USER_INVOCABLE_ONLY,
  resolveSkillOverride,
} from '@/lib/skillOverrides';
import { toast } from '@/components/Toast';
import type { Skill, SkillOverride } from '@/types';

/**
 * 「我安装的」技能卡（参考样式：图标 + 名称 + 右侧开关，描述两行）。
 *
 * ## 三态怎么塞进「一个开关 + 一个图标按钮」
 *
 * 开关表达「能不能用」（`off` ↔ 非 `off`），图标按钮表达「模型看不看得见」
 * （`on` ↔ `user-invocable-only`）。两者组合能覆盖全部三档，且每一档都有
 * 且只有一个显式入口 —— 比一个下拉框更贴近参考样式，也不会因为
 * 「下拉框藏起来的两项」而让人以为状态只有一种。
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
  selectable = false,
  selected = false,
  onSelect,
  onSetOverride,
  onUninstall,
  onOpenDetail,
}: {
  skill: Skill;
  /** 批量管理模式：整卡改为「勾选」而不是「打开详情」 */
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: string) => void;
  onSetOverride: (id: string, override: SkillOverride) => void;
  onUninstall: (skill: Skill) => void;
  onOpenDetail: (skill: Skill) => void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const override = resolveSkillOverride(skill);
  const enabled = override !== SKILL_OVERRIDE_OFF;
  const manualOnly = override === SKILL_OVERRIDE_USER_INVOCABLE_ONLY;

  const handleSwitch = () => {
    const next: SkillOverride = enabled ? SKILL_OVERRIDE_OFF : SKILL_OVERRIDE_ON;
    onSetOverride(skill.id, next);
    // 开关是二元的，反馈必须点名「关掉的是什么」：同样一个开关，
    // 「已停用」和「已关闭自动触发」对用户的理解完全不同，后者才是真实语义。
    toast.success(
      enabled ? `${skill.name} 已关闭自动触发` : `${skill.name} 已开启自动触发`,
    );
  };

  const handleManualOnly = () => {
    const next: SkillOverride = manualOnly ? SKILL_OVERRIDE_ON : SKILL_OVERRIDE_USER_INVOCABLE_ONLY;
    onSetOverride(skill.id, next);
    toast.info(
      manualOnly
        ? `${skill.name} 已恢复模型可见`
        : `${skill.name} 已设为仅手动调用（模型不可见）`,
    );
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
              <IconButton
                size="small"
                aria-label={`${skill.name} 操作菜单`}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuAnchor(e.currentTarget);
                }}
                sx={skillCardIconButtonSx}
              >
                <MoreHorizIcon sx={{ fontSize: 18 }} />
              </IconButton>
              <Tooltip
                title={
                  manualOnly
                    ? '仅手动调用：模型看不到它，点击恢复模型可见'
                    : '设为仅手动调用：模型看不到它，只有你显式 $调用才生效'
                }
              >
                <IconButton
                  size="small"
                  aria-label={`${skill.name} 仅手动调用`}
                  aria-pressed={manualOnly}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleManualOnly();
                  }}
                  sx={[skillCardIconButtonSx, manualOnly ? skillManualOnlyActiveSx : {}]}
                >
                  <VisibilityOffOutlinedIcon sx={{ fontSize: 17 }} />
                </IconButton>
              </Tooltip>
            </Box>
            <Tooltip title={enabled ? '点击停用自动触发' : '点击启用自动触发'}>
              <Switch
                size="small"
                color="success"
                checked={enabled}
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
