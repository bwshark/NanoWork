import { Box, Button, Dialog, DialogContent, Typography } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import EditNoteIcon from "@mui/icons-material/EditNote";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import GroupsIcon from "@mui/icons-material/Groups";
import PersonIcon from "@mui/icons-material/Person";
import type { AutoCreateKind } from "@/components/agents/useExpertAutoCreate";

/**
 * 「创建专家 / 创建专家团」的模式选择弹层。
 *
 * ## 为什么要有这一步，而不是把两个按钮并排放在页头
 *
 * 页头已经挤着「检索 / 导入专家包 / 我的专家 / 创建」四个控件，再拆成两个按钮
 * 会让主操作失焦。更重要的原因：**两种模式的心智模型完全不同** ——
 * 手动是把已知配置填进表单，自动是先聊清楚再生成。用户需要看到「还有自动这条路」，
 * 而不是在表单里填到一半才想起来。
 *
 * ## 为什么手动在前
 *
 * 自动创建依赖模型与「专家创建」技能，是**更重**的一条路。把轻的、随时可用的
 * 放在第一位，重的那条标注「推荐 AI」引导但不必阻塞 —— 技能被停用 / 模型不可用时，
 * 用户仍然能一眼看到自己该走哪条。
 */
export function CreateExpertDialog({
  open,
  kind,
  onClose,
  onManual,
  onAuto,
}: {
  open: boolean;
  kind: AutoCreateKind;
  onClose: () => void;
  onManual: () => void;
  onAuto: () => void;
}) {
  const isTeam = kind === "team";
  const label = isTeam ? "专家团" : "专家";

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogContent sx={{ p: 2.5 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
          {isTeam ? (
            <GroupsIcon sx={{ fontSize: 20, color: "text.secondary" }} />
          ) : (
            <PersonIcon sx={{ fontSize: 20, color: "text.secondary" }} />
          )}
          <Typography sx={{ fontSize: 16, fontWeight: 600 }}>
            创建{label}
          </Typography>
        </Box>
        <Typography sx={{ fontSize: 12.5, color: "text.secondary", mb: 2 }}>
          选一种方式开始
        </Typography>

        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
          <ModeOption
            icon={<EditNoteIcon sx={{ fontSize: 20 }} />}
            title="手动创建"
            description={`逐项填写${label}名称、提示词、技能与权限，全程可控。`}
            onClick={onManual}
          />
          <ModeOption
            icon={<AutoAwesomeIcon sx={{ fontSize: 20 }} />}
            title="AI 自动创建"
            badge="推荐"
            description={
              isTeam
                ? "和专家创建助手聊几句，梳理成员分工与协作流程，自动生成可保存的专家团配置。"
                : "和专家创建助手聊几句，梳理角色定位与工作流，自动生成可保存的专家配置。"
            }
            onClick={onAuto}
          />
        </Box>

        <Typography
          sx={{ fontSize: 11.5, color: "text.disabled", mt: 2, lineHeight: 1.7 }}
        >
          自动创建会新开一条会话，并挂载内置技能「专家创建」；聊清楚后点卡片上的「保存」
          即可出现在「我的专家」。
        </Typography>

        <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 1.5 }}>
          <Button
            size="small"
            onClick={onClose}
            sx={{ textTransform: "none", color: "text.secondary" }}
          >
            取消
          </Button>
        </Box>
      </DialogContent>
    </Dialog>
  );
}

/** 一个可点的模式选项卡片：整块可点，hover 时描边变实 */
function ModeOption({
  icon,
  title,
  badge,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        p: 1.5,
        borderRadius: 2,
        border: "1px solid",
        borderColor: "divider",
        cursor: "pointer",
        transition: "border-color .15s, background-color .15s",
        "&:hover": {
          borderColor: "text.primary",
          bgcolor: "action.hover",
        },
        "&:focus-visible": {
          outline: "2px solid",
          outlineColor: "primary.main",
          outlineOffset: 1,
        },
      }}
    >
      <Box
        sx={{
          width: 36,
          height: 36,
          borderRadius: "10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          bgcolor: "action.selected",
          color: "text.primary",
          flexShrink: 0,
        }}
      >
        {icon}
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{title}</Typography>
          {badge && (
            <Box
              sx={{
                fontSize: 10.5,
                px: 0.75,
                py: "1px",
                borderRadius: 999,
                bgcolor: "text.primary",
                color: "background.default",
                lineHeight: 1.5,
              }}
            >
              {badge}
            </Box>
          )}
        </Box>
        <Typography
          sx={{ fontSize: 12, color: "text.secondary", mt: 0.25, lineHeight: 1.6 }}
        >
          {description}
        </Typography>
      </Box>
      <ChevronRightIcon sx={{ fontSize: 18, color: "text.disabled", flexShrink: 0 }} />
    </Box>
  );
}
