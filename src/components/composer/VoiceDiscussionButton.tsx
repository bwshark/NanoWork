/**
 * 「语音讨论」入口按钮：输入框右侧、麦克风与发送之间的一枚波形图标。
 *
 * ## 为什么与「语音输入」并排而不是合并成一个按钮
 * 两者是**不同语义**：麦克风把说的话变成输入框里的文字（用户还要改、还要发），
 * 语音讨论则是直接和模型对话、并且会出声。合并成一个按钮，用户就无法预判
 * 点下去是「写字」还是「说话给 AI 听」。参考视频里也是并排两枚。
 *
 * ## 为什么是圆角方块而不是圆形
 * 与同排的麦克风（圆形 IconButton）拉开层级：圆形＝「工具动作」，
 * 方块＝「进入一个模式」。这也是参考图里的处理方式。
 */

import { IconButton, Tooltip } from "@mui/material";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";

export interface VoiceDiscussionButtonProps {
  /** 是否已有一个讨论在进行（此时按钮高亮） */
  active: boolean;
  /** 不可用（缺麦克风 / 缺实时识别模型） */
  disabled: boolean;
  /** 不可用的原因（tooltip 直接说明怎么修） */
  disabledReason: string | null;
  onClick: () => void;
}

/** 按钮边长：与同排麦克风按钮（34）一致，视觉上是一条基线 */
const BUTTON_SIZE = 34;

export function VoiceDiscussionButton({
  active,
  disabled,
  disabledReason,
  onClick,
}: VoiceDiscussionButtonProps) {
  const title = disabled
    ? (disabledReason ?? "语音讨论不可用")
    : active
      ? "语音讨论进行中"
      : "语音讨论";

  return (
    <Tooltip title={title} placement="top">
      {/* disabled 按钮不派发鼠标事件：包一层 span 才能让 Tooltip 生效 */}
      <span style={{ display: "inline-flex" }}>
        <IconButton
          size="small"
          onClick={onClick}
          disabled={disabled}
          aria-label={title}
          aria-pressed={active}
          data-testid="composer-voice-discussion"
          sx={{
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            borderRadius: "10px",
            color: active ? "text.primary" : "text.secondary",
            bgcolor: active ? "action.selected" : "action.hover",
            transition: "background-color 160ms ease, color 160ms ease",
            "&:hover": { bgcolor: "action.selected", color: "text.primary" },
            "&.Mui-disabled": { color: "text.disabled", bgcolor: "transparent" },
          }}
        >
          <GraphicEqIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </span>
    </Tooltip>
  );
}
