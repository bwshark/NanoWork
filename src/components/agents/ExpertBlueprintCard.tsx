import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import GroupsIcon from "@mui/icons-material/Groups";
import PersonIcon from "@mui/icons-material/Person";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import CheckIcon from "@mui/icons-material/Check";
import {
  applyExpertBlueprint,
  type ExpertBlueprint,
} from "@/lib/agent/expertBlueprint";
import { useAgentsStore } from "@/stores/agentsStore";
import { useExpertGroupsStore } from "@/stores/expertGroupsStore";
import { useSkillsStore } from "@/stores/skillsStore";
import { toast } from "@/components/Toast";
import { ROUTES } from "@/lib/core/constants";
import { avatarGlyph, clampLines } from "@/lib/ui/cardSx";

/**
 * 专家蓝图卡片：把 AI 生成的蓝图变成「点一下就能存」的东西。
 *
 * ## 为什么不直接把 JSON 渲染成代码块
 *
 * 一张几十行的高亮 JSON 对用户没有任何价值 —— 他要判断的是「这位专家是干什么的、
 * 团里都有谁、定位对不对」。所以正文里的代码块由 `extractExpertBlueprints` 剥掉，
 * 换成这张按人读的结构卡片。原始 JSON 仍然留在消息历史里（会话记录不剥），
 * 需要排查时可以回看。
 *
 * ## 为什么保存后不再允许重复点
 *
 * `applyExpertBlueprint` 每次都会新建实体（新 id）。允许连点等于允许造出三份同名
 * 专家，而用户以为自己在「重试」。落库后按钮换成「已保存」是唯一的正确反馈。
 */
export function ExpertBlueprintCard({ blueprint }: { blueprint: ExpertBlueprint }) {
  const navigate = useNavigate();
  const importAgent = useAgentsStore((s) => s.importAgent);
  const createGroup = useExpertGroupsStore((s) => s.createGroup);
  const skills = useSkillsStore((s) => s.skills);

  const [saved, setSaved] = useState<{ agentIds: string[]; groupId?: string } | null>(
    null,
  );
  const [expanded, setExpanded] = useState(false);

  const isTeam = blueprint.kind === "team";
  const members = blueprint.members ?? [];

  /** 技能白名单：只放行本地真装了的（否则就是一条永远不生效的空引用） */
  const knownSkillIds = useMemo(() => skills.map((s) => s.id), [skills]);

  const handleSave = () => {
    const result = applyExpertBlueprint(blueprint, { importAgent, createGroup }, {
      knownSkillIds,
    });
    setSaved({ agentIds: result.agentIds, groupId: result.groupId });
    if (result.warnings.length > 0) {
      toast.warning(result.warnings[0]);
    } else {
      toast.success(
        isTeam
          ? `已创建专家团「${blueprint.name}」（${result.agentIds.length} 位成员）`
          : `已创建专家「${blueprint.name}」`,
      );
    }
  };

  return (
    <Box
      sx={{
        mt: 1.5,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 2,
        bgcolor: "background.default",
        overflow: "hidden",
      }}
    >
      {/* 头部：类型 + 名称 */}
      <Box
        sx={{
          px: 2,
          py: 1.5,
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          bgcolor: "action.hover",
        }}
      >
        <Box
          sx={{
            width: 32,
            height: 32,
            borderRadius: "8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: "background.paper",
            color: "text.primary",
            flexShrink: 0,
          }}
        >
          {isTeam ? (
            <GroupsIcon sx={{ fontSize: 18 }} />
          ) : (
            <PersonIcon sx={{ fontSize: 18 }} />
          )}
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap>
            {blueprint.name}
          </Typography>
          <Typography
            sx={{ fontSize: 12, color: "text.secondary", mt: 0.125 }}
            noWrap
          >
            {blueprint.role || (isTeam ? "专家团" : "专家")}
            {isTeam ? ` · ${members.length} 位成员` : ""}
          </Typography>
        </Box>
        <Chip
          size="small"
          variant="outlined"
          label={isTeam ? "专家团" : "专家"}
          sx={{ height: 22, fontSize: 11.5 }}
        />
      </Box>

      <Box sx={{ px: 2, py: 1.5 }}>
        {blueprint.description && (
          <Typography
            sx={{ fontSize: 12.5, color: "text.secondary", lineHeight: 1.7 }}
          >
            {blueprint.description}
          </Typography>
        )}

        {isTeam && (
          <Stack spacing={0.75} sx={{ mt: blueprint.description ? 1.25 : 0 }}>
            {members.map((m, index) => {
              const { glyph, isEmoji } = avatarGlyph(m.avatar, m.name);
              return (
                <Box
                  key={`${m.name}-${index}`}
                  sx={{ display: "flex", alignItems: "center", gap: 1 }}
                >
                  <Avatar
                    sx={{
                      width: 22,
                      height: 22,
                      fontSize: isEmoji ? 12 : 10,
                      bgcolor: "action.selected",
                      color: "text.primary",
                    }}
                  >
                    {glyph}
                  </Avatar>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 500 }}>
                    {m.name}
                  </Typography>
                  <Typography sx={{ fontSize: 12, color: "text.secondary" }} noWrap>
                    {m.role ?? ""}
                  </Typography>
                </Box>
              );
            })}
          </Stack>
        )}

        {/* 提示词预览：单人专家最关键的信息就是这段身份定义，默认收起前 3 行 */}
        {!isTeam && blueprint.systemPrompt && (
          <>
            <Divider sx={{ my: 1.25 }} />
            <Typography
              sx={{
                fontSize: 12,
                color: "text.secondary",
                lineHeight: 1.75,
                whiteSpace: "pre-wrap",
                ...(expanded ? {} : clampLines(3)),
              }}
            >
              {blueprint.systemPrompt}
            </Typography>
            {blueprint.systemPrompt.length > 90 && (
              <Button
                size="small"
                onClick={() => setExpanded((v) => !v)}
                sx={{ mt: 0.5, px: 0, minWidth: 0, fontSize: 12 }}
              >
                {expanded ? "收起" : "展开完整提示词"}
              </Button>
            )}
          </>
        )}

        {blueprint.warnings.length > 0 && (
          <Alert
            severity="warning"
            sx={{ mt: 1.25, py: 0.25, "& .MuiAlert-message": { fontSize: 12 } }}
          >
            {blueprint.warnings.map((w) => (
              <Box key={w}>{w}</Box>
            ))}
          </Alert>
        )}
      </Box>

      <Box
        sx={{
          px: 2,
          py: 1.25,
          borderTop: "1px solid",
          borderColor: "divider",
          display: "flex",
          alignItems: "center",
          gap: 1,
        }}
      >
        {saved ? (
          <>
            <CheckIcon sx={{ fontSize: 16, color: "success.main" }} />
            <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
              已保存到「我的专家」
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button
              size="small"
              onClick={() => navigate(ROUTES.myAgents)}
              sx={{ textTransform: "none", fontSize: 12.5 }}
            >
              去查看
            </Button>
          </>
        ) : (
          <>
            <Typography sx={{ fontSize: 12, color: "text.disabled" }}>
              确认无误后保存，可继续在专家页编辑
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button
              size="small"
              variant="contained"
              startIcon={<SaveOutlinedIcon sx={{ fontSize: 16 }} />}
              onClick={handleSave}
              sx={{ textTransform: "none", fontSize: 12.5 }}
            >
              {isTeam ? "保存为专家团" : "保存为专家"}
            </Button>
          </>
        )}
      </Box>
    </Box>
  );
}
