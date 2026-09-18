import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import CheckIcon from '@mui/icons-material/Check';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import { SkillIcon } from './SkillIcon';
import {
  skillDetailPaperSx,
  skillInfoLabelSx,
  skillInfoPanelSx,
  skillInfoRowSx,
  skillInfoValueSx,
  skillMetaChipSx,
} from './skillCardSx';
import { skillInfoRows } from './skillMeta';
import { clampLines } from '@/lib/cardSx';
import type { Skill } from '@/types';

/** 描述超过这个长度才给「展开」——短描述展开没意义，只是多一个可点区域 */
const EXPAND_THRESHOLD = 120;

/**
 * 技能详情弹窗（参考样式：大图标 + 名称 + 安装 + 描述 + 基本信息）。
 *
 * 「基本信息」的字段列表**必须**走 `skillInfoRows`（与已安装的详情窗口共用），
 * 不能在这里再拼一份 —— 两个入口的字段一旦各写一遍，迟早会出现
 * 「市场弹窗有工具白名单、已安装窗口没有」这种没法解释的不一致。
 */
export function SkillDetailDialog({
  skill,
  open,
  installing,
  onClose,
  onInstall,
}: {
  skill: Skill | null;
  open: boolean;
  /** 安装请求进行中（由页面统一调度） */
  installing: boolean;
  onClose: () => void;
  onInstall: (skill: Skill) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // 换一个技能就收起描述：沿用上一条的展开态会让新技能一进来就是展开的
  useEffect(() => {
    setExpanded(false);
  }, [skill?.id]);

  const description = skill?.description ?? '';
  const expandable = description.length > EXPAND_THRESHOLD;

  const rows = skill ? skillInfoRows(skill) : [];

  const installed = !!skill?.enabled;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: skillDetailPaperSx }}
    >
      <IconButton
        aria-label="关闭详情"
        onClick={onClose}
        size="small"
        sx={{ position: 'absolute', top: 12, right: 12, color: 'text.secondary' }}
      >
        <CloseIcon sx={{ fontSize: 20 }} />
      </IconButton>

      <DialogContent sx={{ p: 0, '&:first-of-type': { pt: 0 } }}>
        {skill && (
          <>
            <Stack direction="row" alignItems="flex-start" spacing={2}>
              <SkillIcon name={skill.name} icon={skill.icon} size={64} />
              <Stack sx={{ pt: 0.5, minWidth: 0, gap: 1.25 }}>
                <Typography variant="h6" fontWeight={700} sx={{ lineHeight: 1.35 }}>
                  {skill.name}
                </Typography>
                <Box>
                  <Button
                    variant="outlined"
                    size="small"
                    disabled={installed || installing}
                    startIcon={
                      installed ? (
                        <CheckIcon sx={{ fontSize: 17 }} />
                      ) : (
                        <DownloadOutlinedIcon sx={{ fontSize: 17 }} />
                      )
                    }
                    onClick={() => onInstall(skill)}
                    sx={{ textTransform: 'none', px: 1.75, color: 'text.primary' }}
                  >
                    {installed ? '已安装' : installing ? '安装中…' : '安装'}
                  </Button>
                </Box>
              </Stack>
            </Stack>

            <Typography
              sx={{
                mt: 2.5,
                fontSize: 13.5,
                lineHeight: 1.75,
                color: 'text.primary',
                whiteSpace: 'pre-wrap',
                ...(expanded || !expandable ? {} : clampLines(3)),
              }}
            >
              {description}
            </Typography>
            {expandable && (
              <Button
                size="small"
                onClick={() => setExpanded((v) => !v)}
                sx={{
                  mt: 0.5,
                  ml: -0.75,
                  textTransform: 'none',
                  color: 'text.secondary',
                  minWidth: 0,
                }}
              >
                {expanded ? '收起' : '展开'}
              </Button>
            )}

            <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mt: 2.5, mb: 1.25 }}>
              <FormatListBulletedIcon sx={{ fontSize: 17, color: 'text.secondary' }} />
              <Typography fontWeight={600} sx={{ fontSize: 14 }}>
                基本信息
              </Typography>
            </Stack>

            <Box sx={skillInfoPanelSx} role="group" aria-label="基本信息">
              {rows.map((row) => (
                <Box key={row.label} sx={skillInfoRowSx}>
                  <Typography sx={skillInfoLabelSx}>{row.label}</Typography>
                  <Typography sx={skillInfoValueSx}>{row.value}</Typography>
                </Box>
              ))}
            </Box>

            {/*
             * 能力标签行：**只放限制类事实**（当前只有「不可手动调用」这一项）。
             *
             * 这里曾经还挂着一枚来源层级的标签（`skillSourceLabel(skill)`），
             * 但它与上方基本信息面板的「来源」行读的是**同一个函数**，
             * 于是同一个事实在同一个弹窗里出现两遍（用户级 / 项目级技能必中）。
             * 来源是身份字段，归面板；能力标签行只承担「这个技能被限制了哪一点」。
             *
             * 也刻意不把来源标签挪到别处补回：已安装的详情**窗口**里没有这枚标签
             * （它只有面板），补回来会让两个入口再次出现「一个显示两遍、
             * 一个显示一遍」的不一致。
             *
             * 「可手动调用」不渲染：那是绝大多数技能的常态，一个恒亮的标签
             * 只会稀释真正需要被看见的那一条。
             */}
            {skill.userInvocable === false && (
              <Stack direction="row" spacing={0.75} sx={{ mt: 1.5, flexWrap: 'wrap' }}>
                <Chip size="small" variant="outlined" label="不可手动调用" sx={skillMetaChipSx} />
              </Stack>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
