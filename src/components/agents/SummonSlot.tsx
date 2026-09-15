import type { ReactNode } from "react";
import { Box, Button, Tooltip } from "@mui/material";
import FlashOnIcon from "@mui/icons-material/FlashOn";

/**
 * 卡片右上角操作槽：默认层（纯展示 chip）与 hover 层（「召唤」按钮）互斥淡入淡出。
 *
 * 默认层是信息展示、不含用户会主动点击的控件，因此「互斥双层」在这里是安全用法
 * （若是「启用开关 + 召唤」这类正交操作，开关必须常驻行内可点，不能这样叠）。
 * 槽宽固定，「chip ↔ 按钮」切换不会引起卡片布局跳动。
 */
export function SummonSlot({
  hovered,
  defaultChip,
  tooltip,
  disabled,
  onSummon,
}: {
  /** 宿主卡片是否处于 hover 态 */
  hovered: boolean;
  /** 静止态展示的信息 chip */
  defaultChip: ReactNode;
  /** 召唤按钮的悬浮说明 */
  tooltip: string;
  disabled: boolean;
  onSummon: () => void;
}) {
  return (
    <Box sx={{ position: "relative", minWidth: 76, height: 30, flexShrink: 0 }}>
      <Box
        sx={{
          position: "absolute",
          right: 0,
          top: "50%",
          transform: "translateY(-50%)",
          opacity: hovered ? 0 : 1,
          pointerEvents: hovered ? "none" : "auto",
          transition: "opacity .12s",
        }}
      >
        {defaultChip}
      </Box>
      <Box
        sx={{
          position: "absolute",
          right: 0,
          top: "50%",
          transform: "translateY(-50%)",
          opacity: hovered ? 1 : 0,
          pointerEvents: hovered ? "auto" : "none",
          transition: "opacity .12s",
        }}
      >
        <Tooltip title={tooltip}>
          <span>
            <Button
              size="small"
              variant="contained"
              disabled={disabled}
              startIcon={<FlashOnIcon sx={{ fontSize: 16 }} />}
              onClick={onSummon}
              sx={{
                minWidth: 0,
                px: 1.25,
                py: 0.25,
                fontSize: 12.5,
                textTransform: "none",
                borderRadius: "8px",
                boxShadow: "none",
                "&:hover": { boxShadow: "0 2px 8px rgba(0,0,0,0.28)" },
              }}
            >
              召唤
            </Button>
          </span>
        </Tooltip>
      </Box>
    </Box>
  );
}
