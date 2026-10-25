import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import { SkillIcon } from './SkillIcon';
import { SkillActionMenu } from './SkillActionMenu';
import { OverviewSearch } from './OverviewSearch';
import { MarkdownView } from '@/components/MarkdownView';
import { toast } from '@/components/Toast';
import { clampLines } from '@/lib/ui/cardSx';
import {
  skillHintTooltipSx,
  skillInfoGridRowSx,
  skillInfoGridSx,
  skillInfoGridValueSx,
  skillInfoLabelSx,
  skillInfoPanelSx,
  skillOverviewBoxSx,
  skillOverviewSx,
  skillSectionTitleSx,
  skillSwitchSx,
  skillTryButtonSx,
  skillWindowBodySx,
  skillWindowDescSx,
  skillWindowHeadSx,
  skillWindowIconButtonSx,
  skillWindowPaperSx,
  skillWindowPlainIconButtonSx,
} from './skillCardSx';
import {
  autoTriggerHint,
  isAutoTriggerOn,
  nextAutoTriggerOverride,
  overrideToast,
  skillInfoRows,
} from './skillMeta';
import { SKILL_OVERRIDE_OFF, resolveSkillOverride } from '@/lib/agent/skillOverrides';
import type { Skill, SkillOverride } from '@/types';

/** 描述超过这个长度才给「展开」：短描述展开没意义，只是多一个可点区域 */
const EXPAND_THRESHOLD = 120;

/**
 * 已安装技能的详情**窗口**（参考样式：居中浮层，遮罩压暗列表）。
 *
 * ## 为什么是窗口，而不是接管整页
 *
 * 从「我安装的」点开一张卡时，用户是在**列表里做取舍**：开一个技能、看一眼它的
 * 正文、再回去关掉另一个。接管整页会把这份上下文（旁边还有哪些技能）抹掉，
 * 回来还得重新找到刚才那张卡；浮层则让列表始终在背后可见。
 *
 * 窗口内部是**固定头部 + 只让概述区滚**三道结构（见 `skillWindowPaperSx` 的注释）：
 * 图标 / 去试试 / 开关 / 基本信息都要在读全文时一直看得见。
 *
 * ## 只读
 *
 * 本窗口不提供编辑：技能的正文是磁盘上的 SKILL.md，真正的编辑器与文件系统
 * 在菜单里的「编辑 / 打开文件夹」。在界面里再实现一套编辑会制造第二个真实来源，
 * 用户改完还得决定「以谁为准」。
 */
export function SkillDetailWindow({
  skill,
  open,
  onClose,
  onSetOverride,
  onUninstall,
  onTryIt,
}: {
  skill: Skill | null;
  open: boolean;
  onClose: () => void;
  onSetOverride: (id: string, override: SkillOverride) => void;
  onUninstall: (skill: Skill) => void;
  onTryIt: (skill: Skill) => void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const overviewRef = useRef<HTMLDivElement>(null);

  /*
   * 关闭动画（约 200ms）期间保留最后一份内容：父组件一关就把 `skill` 置空的话，
   * 纸面会先变成一块空白再淡出 —— 窗口越大这个「空窗」越显眼。
   */
  const [shown, setShown] = useState<Skill | null>(skill);
  useEffect(() => {
    if (skill) setShown(skill);
  }, [skill]);
  const s = skill ?? shown;

  // 换一个技能就收起描述与菜单：沿用上一条的展开态会让新技能一进来就是展开的
  useEffect(() => {
    setExpanded(false);
    setMenuAnchor(null);
  }, [s?.id]);

  const enabled = s ? resolveSkillOverride(s) !== SKILL_OVERRIDE_OFF : false;
  /**
   * 开关的「开」位置：模型可见（`override === 'on'`）。
   *
   * 与卡片上那个开关、以及 ⋯ 菜单里的对勾**读同一个字段、用同一份判据**
   * （`isAutoTriggerOn`）—— 三个入口不同步时，用户会以为它们是三个设置。
   */
  const autoTrigger = s ? isAutoTriggerOn(s) : false;
  const overview = s?.prompt?.trim() ?? '';
  const description = s?.description ?? '';
  const expandable = description.length > EXPAND_THRESHOLD;

  const handleSwitch = () => {
    if (!s) return;
    // 反馈按**落点**说话：关掉开关落到中间档（仍可手动调用），不是停用 ——
    // 说得含糊用户就不敢关（以为等于把这个技能扔掉）
    const next = nextAutoTriggerOverride(s);
    onSetOverride(s.id, next);
    toast.success(overrideToast(s.name, next));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      /*
       * 宽度不写 `maxWidth="sm"`（600）：实际值由 `skillWindowPaperSx` 里的
       * `&.MuiDialog-paperFullWidth` 封到 760，这里只保留 `fullWidth`
       * 提供的 `width: calc(100% - 64px)` 让窄屏能自动收窄。
       */
      maxWidth={false}
      fullWidth
      PaperProps={{ sx: skillWindowPaperSx, 'aria-label': '技能详情' }}
    >
      {s && (
        <>
          <Box sx={skillWindowHeadSx}>
            <Stack direction="row" alignItems="flex-start" spacing={2}>
              <SkillIcon variant="solid" size={64} name={s.name} icon={s.icon} />

              <Box sx={{ flex: 1, minWidth: 0, pt: 0.25 }}>
                <Typography variant="h6" fontWeight={700} sx={{ lineHeight: 1.35 }}>
                  {s.name}
                </Typography>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1.25 }}>
                  {/*
                   * 「去试试」= 把这个技能挂到当前会话并跳到对话页。
                   * 停用时禁用而不是悄悄启用：挂载只在技能 enabled 时才会被注入
                   * （见 sessionsStore 的技能注入过滤），所以停用态下点它等于什么都没发生 ——
                   * 与其给一个无反应的按钮，不如写明要先打开开关。
                   */}
                  <Tooltip title={enabled ? '' : '技能已停用：先打开右侧开关再试'}>
                    <Box component="span">
                      <Button
                        disabled={!enabled}
                        startIcon={<ForumOutlinedIcon sx={{ fontSize: 16 }} />}
                        onClick={() => onTryIt(s)}
                        sx={skillTryButtonSx}
                      >
                        去试试
                      </Button>
                    </Box>
                  </Tooltip>
                  <IconButton
                    size="small"
                    aria-label={`${s.name} 操作菜单`}
                    onClick={(e) => setMenuAnchor(e.currentTarget)}
                    sx={skillWindowIconButtonSx}
                  >
                    <MoreHorizIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Stack>
              </Box>

              <Stack direction="row" alignItems="center" spacing={0.5}>
                {/*
                 * 开关的悬停说明来自 `autoTriggerHint`（与卡片上是同一份文案）：
                 * 它回答的是「按下去之后这个技能会变成什么样」，而不是重复按钮名。
                 * 气泡样式走 `slotProps.tooltip`（写 `<Tooltip sx>` 无效，见令牌注释）。
                 *
                 * `placement="bottom-end"`：气泡的右缘与开关右缘对齐、向左展开。
                 * 不能用默认的 `bottom`（居中）—— 开关右边就是「关闭 ×」，
                 * 居中的 300px 气泡会盖住 ×，还会伸出纸面右缘（实测超出 76px：
                 * 纸面 x=260..1020、气泡 x=796..1096），看起来像一块飘出窗口的补丁。
                 * 右对齐后气泡整块落在纸面内，且正好停在 × 左边。
                 */}
                <Tooltip
                  placement="bottom-end"
                  title={autoTriggerHint(s)}
                  slotProps={{ tooltip: { sx: skillHintTooltipSx } }}
                >
                  <Switch
                    size="small"
                    color="success"
                    checked={autoTrigger}
                    inputProps={{ 'aria-label': `${s.name} 自动触发` }}
                    onChange={handleSwitch}
                    sx={skillSwitchSx}
                  />
                </Tooltip>
                <IconButton
                  size="small"
                  aria-label="关闭技能详情"
                  onClick={onClose}
                  sx={skillWindowPlainIconButtonSx}
                >
                  <CloseIcon sx={{ fontSize: 20 }} />
                </IconButton>
              </Stack>
            </Stack>

            <Typography sx={{ ...skillWindowDescSx, ...(expanded || !expandable ? {} : clampLines(2)) }}>
              {description}
            </Typography>
            {expandable && (
              <Button
                size="small"
                onClick={() => setExpanded((v) => !v)}
                sx={{
                  mt: 0.25,
                  ml: -0.75,
                  textTransform: 'none',
                  color: 'text.secondary',
                  minWidth: 0,
                }}
              >
                {expanded ? '收起' : '展开'}
              </Button>
            )}
          </Box>

          <Box sx={skillWindowBodySx}>
            <SectionTitle icon={<FormatListBulletedIcon sx={{ fontSize: 17 }} />} text="基本信息" />
            {/* `role=group` + aria-label：让这块面板可以被独立断言（测试要证明的
                是「面板里没有某几个字段」，而不是「整个窗口里没有这几个字」） */}
            <Box sx={skillInfoPanelSx} role="group" aria-label="基本信息">
              <Box sx={skillInfoGridSx}>
                {skillInfoRows(s).map((row) => (
                  <Box key={row.label} sx={skillInfoGridRowSx}>
                    <Typography sx={skillInfoLabelSx}>{row.label}</Typography>
                    <Typography sx={skillInfoGridValueSx}>{row.value}</Typography>
                  </Box>
                ))}
              </Box>
            </Box>

            {/* 概述就是 SKILL.md 的正文（prompt 字段），没有正文时整段不渲染而不是留个空壳 */}
            {overview && (
              <Stack direction="row" alignItems="center" sx={skillSectionTitleSx}>
                <Box sx={{ display: 'flex', color: 'text.secondary' }}>
                  <ArticleOutlinedIcon sx={{ fontSize: 17 }} />
                </Box>
                <Typography fontWeight={600} sx={{ fontSize: 14 }}>
                  概述
                </Typography>
                <Box sx={{ flex: 1 }} />
                <OverviewSearch containerRef={overviewRef} resetKey={s.id} />
              </Stack>
            )}
          </Box>

          {/*
           * 概述区是窗口里唯一会滚的地方。`resetKey` 走技能 id：
           * 换技能时命中要重算（旧 Range 指向的节点已经不在文档里了）。
           */}
          {overview && (
            <Box ref={overviewRef} sx={skillOverviewBoxSx}>
              <MarkdownView content={overview} sx={skillOverviewSx} />
            </Box>
          )}

          <SkillActionMenu
            skill={s}
            context="window"
            anchorEl={menuAnchor}
            onClose={() => setMenuAnchor(null)}
            onSetOverride={onSetOverride}
            onUninstall={onUninstall}
          />
        </>
      )}
    </Dialog>
  );
}

/** 区块标题：图标 + 文字，「基本信息」与市场弹窗共用同一套间距 */
function SectionTitle({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <Stack direction="row" sx={skillSectionTitleSx}>
      <Box sx={{ display: 'flex', color: 'text.secondary' }}>{icon}</Box>
      <Typography fontWeight={600} sx={{ fontSize: 14 }}>
        {text}
      </Typography>
    </Stack>
  );
}
