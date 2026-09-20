import { useState } from "react";
import {
  Box,
  Card,
  CardContent,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CheckIcon from "@mui/icons-material/Check";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import CircularProgress from "@mui/material/CircularProgress";
import { SkillIcon } from "./SkillIcon";
import { SkillActionMenu } from "./SkillActionMenu";
import {
  skillCardIconButtonSx,
  skillDescSx,
  skillInstallButtonSx,
  skillMarketCardSx,
} from "./skillCardSx";
import type { Skill, SkillOverride } from "@/types";

/**
 * 「全部技能」市场卡（参考样式：图标 + 名称 + 右上角安装按钮，描述两行）。
 *
 * 整卡可点 → 打开详情弹窗；右上角按钮是**卡内独立操作**，必须 stopPropagation，
 * 否则点「+」会顺带弹出详情（用户看到的是「点了安装却弹了个框」）。
 * 描述默认截断两行，hover 由 CSS 展开（见 `skillMarketCardSx`）。
 */
export function SkillMarketCard({
  skill,
  installing,
  onInstall,
  onOpenDetail,
  onSetOverride,
  onUninstall,
}: {
  skill: Skill;
  /** 安装反馈中（由页面统一调度，卡片本身不持有定时器） */
  installing: boolean;
  onInstall: (id: string) => void;
  onOpenDetail: (skill: Skill) => void;
  onSetOverride: (id: string, override: SkillOverride) => void;
  onUninstall: (skill: Skill) => void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  /** 本次会话刚安装：保留「已安装」外观，与「我安装的」视图里的状态一致 */
  const installed = skill.enabled;

  const renderAction = () => {
    if (installed) {
      return (
        <Stack direction="row" alignItems="center" spacing={0.25}>
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
          <CheckIcon
            sx={{ fontSize: 18, color: "text.secondary" }}
            aria-label="已安装"
          />
        </Stack>
      );
    }
    if (installing) {
      return (
        <Box
          sx={{
            width: 28,
            height: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CircularProgress size={16} aria-label="安装中" />
        </Box>
      );
    }
    return (
      <IconButton
        size="small"
        aria-label={`安装 ${skill.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onInstall(skill.id);
        }}
        sx={skillInstallButtonSx}
      >
        <AddIcon sx={{ fontSize: 18 }} />
      </IconButton>
    );
  };

  return (
    <Card
      sx={skillMarketCardSx}
      role="button"
      tabIndex={0}
      aria-label={`${skill.name} 详情`}
      onClick={() => onOpenDetail(skill)}
      onKeyDown={(e) => {
        // 整卡可点的代价是得自己补键盘通路：Enter / Space 都要能打开详情
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail(skill);
        }
      }}
    >
      <CardContent sx={{ p: 1.75, "&:last-child": { pb: 1.75 } }}>
        <Stack direction="row" alignItems="center" spacing={1.25}>
          <SkillIcon name={skill.name} icon={skill.icon} />
          <Typography
            noWrap
            sx={{
              flex: 1,
              minWidth: 0,
              fontSize: 15,
              fontWeight: 600,
              lineHeight: 1.4,
            }}
            title={skill.name}
          >
            {skill.name}
          </Typography>
          {renderAction()}
        </Stack>
        {/* 不加 title：hover 已经把描述展开成全文了，再叠一个原生 tooltip 是两套反馈打架 */}
        <Typography className="skill-desc" sx={skillDescSx}>
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
